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
  private readonly readCount: number;
  private readonly blockMs: number;

  constructor(
    streamdb: RedisConnection,
    group: string,
    consumerId: string,
    readCount: number = 200,
    blockMs: number = 1000,
  ) {
    this.streamdb = streamdb;
    this.group = group;
    this.consumerId = consumerId;
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
        // Group exists — reset last-delivered-id to 0 so any messages
        // emitted before start() are not skipped
        await this.streamdb.xgroup('SETID', streamKey, this.group, '0');
        return;
      }
      throw error;
    }
  }

  /**
   * Reads messages from stream (copied from old worker readQueueStream)
   * - Single xpending: used for claim check (idle >30s) and for trim boundary (oldest un-ACKed)
   * - Reads new messages (XREADGROUP with BLOCK blockMs)
   * - ACKs immediately after reading
   * - Trims only ACKed entries (MINID) so stream stays bounded without dropping unprocessed jobs
   */
  async readQueueStream(queueName: string): Promise<Message[]> {
    const streamKey = `${queueName}-stream`;
    const count = this.readCount;

    try {
      // Single xpending call — used for both claim check AND trim boundary
      const pendingMessages = await this.streamdb.xpending(
        streamKey,
        this.group,
        '-',
        '+',
        count,
      ) as { id: string; lastDelivered: number }[] | undefined;

      if (pendingMessages?.length) {
        const now = Date.now();
        const claimIds = pendingMessages
          .filter((msg) => (now - msg.lastDelivered) > 30000)
          .map((msg) => msg.id);
        if (claimIds.length) {
          await this.streamdb.xclaim(
            streamKey,
            this.group,
            this.consumerId,
            30000,
            ...claimIds,
          );
        }
      }

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
        '>',
      ) as [string, [string, string]][];

      if (!jobs?.[0]?.[1]?.length) return [];

      const processedMessages = this.sanitizeStream(jobs, queueName);

      const messageIds = jobs[0][1].map(([id]) => id);
      await this.streamdb.xack(streamKey, this.group, ...messageIds);

      // Trim only ACKed entries — use oldest pending as the safe boundary.
      // If nothing pending, everything is processed — trim up to last ACKed ID.
      try {
        const trimId = pendingMessages?.length
          ? pendingMessages[0].id
          : messageIds[messageIds.length - 1];
        await this.streamdb.call('XTRIM', streamKey, 'MINID', '~', trimId);
      } catch (trimErr) {
        console.warn('[remq] Stream XTRIM failed (non-fatal):', trimErr);
      }

      return processedMessages;
    } catch (error) {
      console.error('[remq] Error reading from stream:', error);
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
