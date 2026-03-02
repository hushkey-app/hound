import type { RedisConnection } from '../../types/index.ts';
import type { Message } from '../../types/message.ts';

/**
 * StreamReader - Handles reading from Redis Streams
 *
 * Copied from old worker's readQueueStream logic - robust and reliable
 */
export class StreamReader {
  private readonly streamdb: RedisConnection;
  private readonly group: string;
  private readonly consumerId: string;
  private readonly streamMaxLen?: number;
  private readonly readCount: number;
  private readonly blockMs: number;

  constructor(
    streamdb: RedisConnection,
    group: string,
    consumerId: string,
    streamMaxLen?: number,
    readCount: number = 200,
    blockMs: number = 1000,
  ) {
    this.streamdb = streamdb;
    this.group = group;
    this.consumerId = consumerId;
    this.streamMaxLen = streamMaxLen;
    this.readCount = readCount;
    this.blockMs = blockMs;
  }

  /**
   * Ensures consumer group exists
   */
  async ensureConsumerGroup(streamKey: string): Promise<void> {
    try {
      await this.streamdb.xgroup(
        'CREATE',
        streamKey,
        this.group,
        '0',
        'MKSTREAM',
      );
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (err?.message?.includes('BUSYGROUP')) {
        // Group already exists, which is fine
        return;
      }
      throw error;
    }
  }

  /**
   * Reads messages from stream (copied from old worker readQueueStream)
   * - Claims pending messages >30s idle
   * - Reads new messages (XREADGROUP with BLOCK blockMs)
   * - ACKs immediately after reading
   * - Returns sanitized job data
   */
  async readQueueStream(queueName: string): Promise<Message[]> {
    const streamKey = `${queueName}-stream`;
    const count = this.readCount;
    // Consumer groups are ensured once at start (ensureAllConsumerGroups), not on every poll

    try {
      // First try to claim any pending messages (like old worker line 661-692)
      const pendingMessages = await this.streamdb.xpending(
        streamKey,
        this.group,
        '-',
        '+',
        count,
      );

      interface PendingMessage {
        id: string;
        lastDelivered: number;
      }

      if (pendingMessages?.length) {
        // Claim messages that have been pending too long (30 seconds like old worker line 679)
        const now = Date.now();
        const claimIds = (pendingMessages as PendingMessage[])
          .filter((msg) => (now - msg.lastDelivered) > 30000) // 30 seconds threshold
          .map((msg) => msg.id);

        if (claimIds.length) {
          // Redis xclaim expects individual message IDs, not an array (like old worker line 684-690)
          await this.streamdb.xclaim(
            streamKey,
            this.group,
            this.consumerId,
            30000, // Min idle time (like old worker line 688)
            ...claimIds, // Spread the array to pass individual IDs
          );
        }
      }

      // Then read new messages (like old worker line 695-706)
      const jobs = await this.streamdb.xreadgroup(
        'GROUP',
        this.group,
        this.consumerId,
        'COUNT',
        count,
        'BLOCK',
        this.blockMs,
        'STREAMS',
        streamKey,
        '>', // Only new messages
      ) as [string, [string, string]][];

      if (!jobs?.[0]?.[1]?.length) {
        return [];
      }

      const processedMessages = this.sanitizeStream(jobs, queueName);

      // Acknowledge processed messages immediately (like old worker line 714-720)
      const messageIds = jobs[0][1].map(([id]) => id);
      await this.streamdb.xack(
        streamKey,
        this.group,
        ...messageIds,
      );

      // Self-clean: trim stream so it doesn't grow unbounded (prevents memory blowup)
      if (this.streamMaxLen != null && this.streamMaxLen > 0) {
        try {
          await this.streamdb.call(
            'XTRIM',
            streamKey,
            'MAXLEN',
            '~',
            this.streamMaxLen,
          );
        } catch (trimErr) {
          console.warn('[remq] Stream XTRIM failed (non-fatal):', trimErr);
        }
      }

      return processedMessages;
    } catch (error) {
      console.error('Error reading from stream:', error);
      return [];
    }
  }

  /**
   * Sanitizes raw stream data into message objects (copied from old worker sanitizeStream)
   */
  private sanitizeStream(
    stream: [string, [string, string]][],
    queueName: string,
  ): Message[] {
    if (!stream?.[0]?.[1]) return [];

    const messages = stream[0][1];
    const processedIds = new Set<string>(); // Track processed job IDs

    return messages
      .map(([messageId, [_, jobDataStr]]) => {
        try {
          // Ensure jobDataStr is a valid JSON string
          if (!jobDataStr || typeof jobDataStr !== 'string') {
            console.error('Invalid job data:', jobDataStr);
            return null;
          }

          const jobData = JSON.parse(jobDataStr);

          if (!jobData) {
            console.error('Failed to parse job data:', jobDataStr);
            return null;
          }

          return {
            id: messageId,
            streamKey: `${queueName}-stream`,
            data: {
              ...jobData,
              messageId, // Include messageId in data like old worker
            },
          } as Message;
        } catch (error) {
          console.error('Error parsing job data:', error);
          console.error('Raw job data:', jobDataStr);
          return null;
        }
      })
      .filter((msg): msg is Message => {
        if (!msg) return false;

        // Only process unique jobs based on ID, name and queue (like old worker line 239-245)
        const msgData = msg.data as any;
        const jobIdentifier =
          `${msgData.id}:${msgData.state?.name}:${msgData.state?.queue}`;
        if (processedIds.has(jobIdentifier)) {
          return false;
        }
        processedIds.add(jobIdentifier);
        return true;
      });
  }

  /**
   * Acknowledges a message (for compatibility, though we ACK after reading)
   */
  async ack(streamKey: string, messageId: string): Promise<void> {
    await this.streamdb.xack(streamKey, this.group, messageId);
  }
}
