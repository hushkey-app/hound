/**
 * StreamReader — Redis Stream operations (XREADGROUP, XACK, XTRIM MINID, XCLAIM) for Consumer.
 *
 * @module
 */
import type { Message, RedisConnection } from '../../types/index.ts';

/**
 * Handles Redis Stream operations: XREADGROUP, XACK, XTRIM (MINID), XCLAIM. Messages stay in PEL until ack().
 */
export class StreamReader {
  private readonly streamdb: RedisConnection;
  private readonly group: string;
  private readonly consumerId: string;
  private readonly readCount: number;
  private readonly blockMs: number;
  private readonly visibilityTimeoutMs: number;

  /**
   * Create a stream reader for a consumer group.
   * @param streamdb - Redis connection for streams
   * @param group - Consumer group name (e.g. "processor")
   * @param consumerId - Stable ID for this consumer (e.g. hostname-pid)
   * @param readCount - Max entries per XREADGROUP (default 200)
   * @param blockMs - Block duration for XREADGROUP in ms (default 50)
   * @param visibilityTimeoutMs - Idle time after which PEL entries are reclaimed via XCLAIM (default 30000)
   */
  constructor(
    streamdb: RedisConnection,
    group: string,
    consumerId: string,
    readCount: number = 200,
    blockMs: number = 50,
    visibilityTimeoutMs: number = 30_000,
  ) {
    this.streamdb = streamdb;
    this.group = group;
    this.consumerId = consumerId;
    this.readCount = readCount;
    this.blockMs = blockMs;
    this.visibilityTimeoutMs = visibilityTimeoutMs;
  }

  /**
   * Ensure consumer group exists for a stream.
   * - Creates group with MKSTREAM if stream doesn't exist yet
   * - On BUSYGROUP (group already exists) — returns silently, cursor untouched
   * - Never resets last-delivered-id — that caused full stream redelivery on restart
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
        return; // Group exists, cursor is correct — leave it alone
      }
      throw error;
    }
  }

  /**
   * Read new messages from a queue stream.
   *
   * Flow:
   * 1. XPENDING — get current PEL, reclaim any idle > visibilityTimeoutMs
   * 2. XREADGROUP '>' — read new undelivered messages
   * 3. Return messages WITHOUT ACKing — they stay in PEL until ack() is called
   *
   * Messages remain in PEL until explicitly ACKed. If the process crashes,
   * the next startup's claim check will reclaim and redeliver them.
   */
  async readQueueStream(queueName: string): Promise<Message[]> {
    const streamKey = `${queueName}-stream`;

    try {
      // Step 1: Check PEL and reclaim stuck messages
      await this.#claimIdleMessages(streamKey);

      // Step 2: Read new messages — do NOT ACK here
      const jobs = await this.streamdb.xreadgroup(
        'GROUP',
        this.group,
        this.consumerId,
        'COUNT',
        this.readCount,
        'BLOCK',
        this.blockMs,
        'STREAMS',
        streamKey,
        '>',
      ) as [string, [string, string][]][] | null;

      if (!jobs?.[0]?.[1]?.length) return [];

      return this.#sanitize(jobs, queueName);
    } catch (error) {
      console.error('[remq] Error reading from stream:', error);
      return [];
    }
  }

  /**
   * ACK a message after successful handler completion.
   *
   * Flow:
   * 1. XACK — remove from PEL (message is done, won't be redelivered)
   * 2. Re-fetch PEL to get safe MINID boundary
   * 3. XTRIM MINID up to oldest remaining PEL entry
   *    If PEL is empty after ACK, skip trim — no safe boundary exists
   *
   * Why skip trim when PEL is empty:
   * New emit() calls may have written stream entries not yet read.
   * Trimming with no PEL boundary could delete those unprocessed entries.
   *
   * ioredis XPENDING tuple: [id, consumer, idleMs, deliveryCount]
   */
  async ack(streamKey: string, messageId: string): Promise<void> {
    await this.streamdb.xack(streamKey, this.group, messageId);

    try {
      const pending = await this.streamdb.xpending(
        streamKey,
        this.group,
        '-',
        '+',
        1, // only need oldest entry for MINID boundary
      ) as [string, string, number, number][] | undefined;

      if (pending?.length) {
        const minId = pending[0][0]; // tuple index 0 = stream entry ID
        if (minId) {
          // Trim up to oldest still-pending entry — safe boundary
          await this.streamdb.call('XTRIM', streamKey, 'MINID', '~', minId);
        }
      }
      // PEL empty → skip trim, no safe boundary
    } catch (trimErr) {
      // Trim failure is non-fatal — stream grows slightly but no data loss
      console.warn('[remq] XTRIM failed (non-fatal):', trimErr);
    }
  }

  /**
   * NACK primitive — ACKs the original message only.
   * Does NOT requeue — caller (processor.ts) decides retry/DLQ strategy.
   *
   * Why ACK on failure:
   * The message has been handled (even if unsuccessfully). The caller is
   * responsible for requeuing if needed. Leaving in PEL would cause
   * xclaim to redeliver it — which is wrong if the caller already requeued.
   */
  async nack(streamKey: string, messageId: string): Promise<void> {
    await this.streamdb.xack(streamKey, this.group, messageId);
  }

  /**
   * Reclaim messages that have been in PEL longer than visibilityTimeoutMs.
   * These are jobs from workers that crashed before ACKing.
   *
   * Uses XCLAIM to transfer ownership to this consumer so they get reprocessed.
   * Runs every read cycle — overhead is negligible at normal PEL sizes.
   *
   * ioredis XPENDING tuple: [id, consumer, idleMs, deliveryCount]
   */
  async #claimIdleMessages(streamKey: string): Promise<void> {
    try {
      const pending = await this.streamdb.xpending(
        streamKey,
        this.group,
        '-',
        '+',
        this.readCount,
      ) as [string, string, number, number][] | undefined;

      if (!pending?.length) return;

      const claimIds = pending
        .filter((msg) => msg[2] > this.visibilityTimeoutMs) // index 2 = idleMs
        .map((msg) => msg[0]); // index 0 = stream entry ID

      if (!claimIds.length) return;

      await this.streamdb.xclaim(
        streamKey,
        this.group,
        this.consumerId,
        this.visibilityTimeoutMs,
        ...claimIds,
      );
    } catch (err) {
      // Non-fatal — missed claim means delayed redelivery, not data loss
      console.warn('[remq] xclaim failed (non-fatal):', err);
    }
  }

  /**
   * Sanitize raw Redis Stream output into typed Message objects.
   *
   * Deduplicates by jobId within the batch — handles edge case where
   * the same job appears twice in a single read (e.g. after xclaim race).
   */
  #sanitize(
    stream: [string, [string, string][]][],
    queueName: string,
  ): Message[] {
    if (!stream?.[0]?.[1]) return [];

    const seen = new Set<string>();

    return stream[0][1]
      .map(([messageId, fields]) => {
        try {
          // Fields are [key, value, key, value, ...] — find 'data' key
          const dataIndex = fields.indexOf('data');
          if (dataIndex === -1 || !fields[dataIndex + 1]) {
            console.error(
              '[remq] Missing data field in stream entry:',
              messageId,
            );
            return null;
          }

          const jobData = JSON.parse(fields[dataIndex + 1]);
          if (!jobData) {
            console.error('[remq] Failed to parse job data for:', messageId);
            return null;
          }

          return {
            id: messageId,
            streamKey: `${queueName}-stream`,
            data: {
              ...jobData,
              messageId,
            },
          } as Message;
        } catch (error) {
          console.error('[remq] Error parsing stream entry:', messageId, error);
          return null;
        }
      })
      .filter((msg): msg is Message => {
        if (!msg) return false;

        // Dedup within batch by jobId + event + queue
        const key =
          `${msg.data.id}:${msg.data.state?.name}:${msg.data.state?.queue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}
