/**
 * Reaper — reclaims stalled jobs from the processing set back to the queue.
 *
 * A job is stalled if it has been in the processing set longer than visibilityTimeoutMs
 * without being ACKed. This happens when a worker crashes mid-job.
 *
 * Runs on an interval alongside the Consumer. On startup it runs immediately
 * to catch anything stalled before the process came online.
 *
 * @module
 */
import { QueueStore } from './queue-store.ts';
import type { RedisConnection } from '../../types/index.ts';
import { debug } from '../../utils/logger.ts';

export class Reaper {
  readonly #store: QueueStore;
  readonly #queues: string[];
  readonly #visibilityTimeoutMs: number;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    db: RedisConnection;
    queues: string[];
    visibilityTimeoutMs?: number;
    intervalMs?: number;
  }) {
    this.#store = new QueueStore(options.db);
    this.#queues = options.queues;
    this.#visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    // Default: run every half-visibilityTimeout so stalled jobs are caught quickly
    this.#intervalMs = options.intervalMs ??
      Math.max(5_000, this.#visibilityTimeoutMs / 2);
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
        const stalled = await this.#store.stalledJobs(
          queue,
          this.#visibilityTimeoutMs,
        );
        if (!stalled.length) continue;

        debug(
          `[hound] Reaper: reclaiming ${stalled.length} stalled job(s) on queue '${queue}'`,
        );

        // Re-add stalled jobs to the queue with score=now so they run immediately
        for (const jobId of stalled) {
          await this.#store.requeue(queue, jobId, Date.now());
        }
      } catch (err) {
        console.error(`[hound] Reaper error on queue '${queue}':`, err);
      }
    }
  }
}
