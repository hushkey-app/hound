/**
 * QueueStore — Redis sorted-set queue primitives (enqueue, claim, ack, nack, requeue).
 *
 * Queue key:      queues:{queue}:q          ZADD scored by delayUntil ms
 * Processing key: queues:{queue}:processing  ZADD scored by claimed_at ms
 *
 * Claim is atomic via Lua: ZRANGEBYSCORE + ZREM + ZADD in one round trip.
 *
 * @module
 */
import type { RedisConnection } from '../../types/index.ts';

// Lua: atomically move up to ARGV[2] ready jobs (score <= ARGV[1]) from queue to processing.
// Returns the list of claimed jobIds.
const CLAIM_SCRIPT = `
local qKey = KEYS[1]
local pKey = KEYS[2]
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local claimedAt = tonumber(ARGV[3])
local jobs = redis.call('ZRANGEBYSCORE', qKey, 0, now, 'LIMIT', 0, count)
if #jobs == 0 then return {} end
for _, jobId in ipairs(jobs) do
  redis.call('ZREM', qKey, jobId)
  redis.call('ZADD', pKey, claimedAt, jobId)
end
return jobs
`;

export class QueueStore {
  constructor(private readonly db: RedisConnection) {}

  /** Add a job to the queue. Score must already include any tiebreaker from the caller. */
  async enqueue(queue: string, jobId: string, score: number): Promise<void> {
    await this.db.zadd(this.#qKey(queue), score, jobId);
  }

  /**
   * Atomically claim up to `count` ready jobs (score <= now).
   * Returns claimed jobIds; moves them from queue → processing set.
   */
  async claim(queue: string, count: number): Promise<string[]> {
    const now = Date.now();
    const result = await this.db.eval(
      CLAIM_SCRIPT,
      2,
      this.#qKey(queue),
      this.#pKey(queue),
      now,
      count,
      now,
    ) as string[];
    return result ?? [];
  }

  /**
   * Fetch job data for a list of jobIds from a queue.
   * Tries :waiting, :delayed, then :processing state keys — returns whichever
   * is non-null first. The :processing fallback covers jobs reclaimed by the
   * Reaper after a worker crashed mid-execution: their state key was already
   * transitioned to :processing, and without it the job would be ACKed away
   * as "deleted externally" and silently lost.
   * Returns a map of jobId → raw JSON string.
   */
  async getJobData(
    queue: string,
    jobIds: string[],
  ): Promise<Map<string, string>> {
    if (!jobIds.length) return new Map();

    const pipe = this.db.pipeline();
    for (const id of jobIds) {
      pipe.get(`queues:${queue}:${id}:waiting`);
      pipe.get(`queues:${queue}:${id}:delayed`);
      pipe.get(`queues:${queue}:${id}:processing`);
    }
    const results = await pipe.exec() as [Error | null, string | null][];

    const out = new Map<string, string>();
    for (let i = 0; i < jobIds.length; i++) {
      const waiting = results[i * 3][1];
      const delayed = results[i * 3 + 1][1];
      const processing = results[i * 3 + 2][1];
      const data = waiting ?? delayed ?? processing;
      if (data) out.set(jobIds[i], data);
    }
    return out;
  }

  /** Remove a job from the processing set (ACK). */
  async ack(queue: string, jobId: string): Promise<void> {
    await this.db.zrem(this.#pKey(queue), jobId);
  }

  /** Remove a job from the processing set (NACK — same op, state key already written). */
  async nack(queue: string, jobId: string): Promise<void> {
    await this.db.zrem(this.#pKey(queue), jobId);
  }

  /** Move a job back to the queue with a new score (used for retry + delay requeue by Reaper). */
  async requeue(queue: string, jobId: string, score: number): Promise<void> {
    const pipe = this.db.pipeline();
    pipe.zrem(this.#pKey(queue), jobId);
    pipe.zadd(this.#qKey(queue), score, jobId);
    await pipe.exec();
  }

  /** Number of jobs currently in the queue (waiting + delayed). */
  async queueLength(queue: string): Promise<number> {
    return await this.db.zcard(this.#qKey(queue));
  }

  /** Number of jobs currently claimed (processing set). */
  async processingCount(queue: string): Promise<number> {
    return await this.db.zcard(this.#pKey(queue));
  }

  /** All jobIds in the processing set with score older than `olderThanMs`. */
  async stalledJobs(queue: string, olderThanMs: number): Promise<string[]> {
    const cutoff = Date.now() - olderThanMs;
    return await this.db.zrangebyscore(this.#pKey(queue), 0, cutoff);
  }

  /** Delete queue and processing sorted sets for a queue (used by management reset). */
  async deleteQueue(queue: string): Promise<void> {
    await this.db.del(this.#qKey(queue), this.#pKey(queue));
  }

  #qKey(queue: string): string {
    return `queues:${queue}:q`;
  }

  #pKey(queue: string): string {
    return `queues:${queue}:processing`;
  }
}
