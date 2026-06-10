/**
 * Reaper — reclaims stalled jobs from the processing set back to the queue.
 *
 * A job is stalled if it has been in the processing set longer than visibilityTimeoutMs
 * without being ACKed. This happens when a worker crashes mid-job.
 *
 * Poison-pill defense: each reclaim increments a `reclaims` counter in the job
 * payload. Past `maxReclaims` the job is marked failed instead of requeued — a
 * job that crashes its worker on every attempt must not loop forever.
 *
 * Runs on an interval alongside the Consumer. On startup it runs immediately
 * to catch anything stalled before the process came online.
 *
 * @module
 */
import { QueueStore } from './queue-store.ts';
import { ALL_STATUSES, indexKey, indexKeyForState } from './job-index.ts';
import { JOB_FINISHED_CHANNEL } from '../broker/mod.ts';
import type { HoundBroker, RedisConnection } from '../../types/index.ts';
import { genExecId } from '../../utils/index.ts';
import { debug } from '../../utils/logger.ts';

export class Reaper {
  readonly #db: RedisConnection;
  readonly #store: QueueStore;
  readonly #queues: string[];
  readonly #visibilityTimeoutMs: number;
  readonly #intervalMs: number;
  readonly #maxReclaims: number;
  readonly #jobStateTtlSeconds?: number;
  readonly #broker?: HoundBroker;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    db: RedisConnection;
    queues: string[];
    visibilityTimeoutMs?: number;
    intervalMs?: number;
    /** Reclaims allowed before the job is marked failed. Default 5. */
    maxReclaims?: number;
    /** TTL for the failed record written on poison cutoff. */
    jobStateTtlSeconds?: number;
    /** When set, poison-cutoff failures are published as job-finished events. */
    broker?: HoundBroker;
  }) {
    this.#db = options.db;
    this.#store = new QueueStore(options.db);
    this.#queues = options.queues;
    this.#visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    // Default: run every half-visibilityTimeout so stalled jobs are caught quickly
    this.#intervalMs = options.intervalMs ??
      Math.max(5_000, this.#visibilityTimeoutMs / 2);
    this.#maxReclaims = options.maxReclaims ?? 5;
    this.#jobStateTtlSeconds = options.jobStateTtlSeconds;
    this.#broker = options.broker;
  }

  /** Start the reaper. Runs one immediate sweep, then on interval. */
  start(): void {
    this.#sweep().catch((err) =>
      console.error('[hound] Reaper sweep error:', err)
    );
    this.#timer = setInterval(() => {
      this.#sweep().catch((err) =>
        console.error('[hound] Reaper sweep error:', err)
      );
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #sweep(): Promise<void> {
    for (const queue of this.#queues) {
      try {
        await this.#trimIndexes(queue);

        const stalled = await this.#store.stalledJobs(
          queue,
          this.#visibilityTimeoutMs,
        );
        if (!stalled.length) continue;

        debug(
          `[hound] Reaper: reclaiming ${stalled.length} stalled job(s) on queue '${queue}'`,
        );

        for (const jobId of stalled) {
          await this.#reclaimOrFail(queue, jobId);
        }
      } catch (err) {
        console.error(`[hound] Reaper error on queue '${queue}':`, err);
      }
    }
  }

  /** Requeue a stalled job, or mark it failed once it exceeds maxReclaims. */
  async #reclaimOrFail(queue: string, jobId: string): Promise<void> {
    // Find the live state record — :processing for jobs that crashed
    // mid-handler, :waiting/:delayed for jobs that crashed between claim and
    // state transition.
    let stateKey = '';
    let raw: string | null = null;
    for (const status of ['processing', 'waiting', 'delayed']) {
      const key = `queues:${queue}:${jobId}:${status}`;
      raw = await this.#db.get(key);
      if (raw) {
        stateKey = key;
        break;
      }
    }

    if (!raw) {
      // Orphan zset entry — state deleted externally or expired. Drop it
      // instead of cycling it through claim/ack forever.
      await this.#store.ack(queue, jobId);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await this.#store.ack(queue, jobId);
      return;
    }

    const reclaims = ((payload.reclaims as number) ?? 0) + 1;

    if (reclaims > this.#maxReclaims) {
      const error =
        `[hound] Reaper: reclaimed ${this.#maxReclaims} times without completing — ` +
        `possible poison job, or visibilityTimeoutMs is below the handler's real duration`;
      const failedData = {
        ...payload,
        status: 'failed',
        timestamp: Date.now(),
        errors: [
          ...((payload.errors as unknown[]) ?? []),
          { message: error, timestamp: Date.now() },
        ],
      };
      await this.#setKey(
        `queues:${queue}:${jobId}:failed:${genExecId()}`,
        JSON.stringify(failedData),
      );
      const delPipe = this.#db.pipeline();
      delPipe.del(stateKey);
      const delIdx = indexKeyForState(stateKey);
      if (delIdx) delPipe.zrem(delIdx, stateKey);
      await delPipe.exec();
      await this.#store.ack(queue, jobId);
      this.#broker?.publish(JOB_FINISHED_CHANNEL, {
        jobId,
        queue,
        status: 'failed',
        error,
      });
      debug(`[hound] Reaper: '${jobId}' hit maxReclaims — marked failed`);
      return;
    }

    payload.reclaims = reclaims;
    await this.#setKey(stateKey, JSON.stringify(payload));
    await this.#store.requeue(queue, jobId, Date.now());
  }

  async #setKey(key: string, value: string): Promise<void> {
    const ttl = this.#jobStateTtlSeconds;
    const pipe = this.#db.pipeline();
    if (typeof ttl === 'number' && ttl > 0) {
      pipe.set(key, value, 'EX', ttl);
    } else {
      pipe.set(key, value);
    }
    const idx = indexKeyForState(key);
    if (idx) pipe.zadd(idx, Date.now(), key);
    await pipe.exec();
  }

  /**
   * Index members don't expire with their state keys (zset members have no
   * TTL) — trim entries older than jobStateTtlSeconds so counts and listings
   * don't drift on TTL'd deployments. No-op when no TTL is configured.
   */
  async #trimIndexes(queue: string): Promise<void> {
    const ttl = this.#jobStateTtlSeconds;
    if (typeof ttl !== 'number' || ttl <= 0) return;
    const cutoff = Date.now() - ttl * 1000;
    for (const status of ALL_STATUSES) {
      await this.#db.zremrangebyscore(indexKey(queue, status), 0, cutoff);
    }
  }
}
