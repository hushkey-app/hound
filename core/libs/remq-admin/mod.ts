/**
 * RemqAdmin module
 *
 * Client for queue administration: CRUD and control for admin UIs and external clients.
 */
import type { RedisConnection } from '../../types/index.ts';
import type {
  Job,
  ListOptions,
  QueueInfo,
  QueueStats,
} from '../../types/admin.ts';
import { type Remq, SUBSCRIBE_JOB_FINISHED } from '../remq/mod.ts';

export type {
  Job,
  ListOptions,
  QueueInfo,
  QueueStats,
} from '../../types/admin.ts';

// All possible job statuses — order matters for getJob pipeline (most likely first)
const JOB_STATUSES: Job['status'][] = [
  'processing',
  'waiting',
  'delayed',
  'completed',
  'failed',
];

/**
 * RemqAdmin - Client for queue administration
 *
 * Provides CRUD operations for job management in admin interfaces.
 * Optional Remq instance enables onJobFinished() and proper retryJob().
 */
export class RemqAdmin {
  private readonly db: RedisConnection;
  private readonly remq?: Remq<any>;

  constructor(db: RedisConnection, remq?: Remq<any>) {
    this.db = db;
    this.remq = remq;
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────

  /**
   * Subscribe to job completion/failure.
   * Requires RemqAdmin to be constructed with a Remq instance.
   * Returns an unsubscribe function.
   */
  onJobFinished(
    cb: (payload: {
      jobId: string;
      queue: string;
      status: 'completed' | 'failed';
      error?: string;
    }) => void,
  ): () => void {
    if (!this.remq) {
      throw new Error(
        'RemqAdmin.onJobFinished() requires a Remq instance: new RemqAdmin(db, remq)',
      );
    }
    return this.remq[SUBSCRIBE_JOB_FINISHED]((
      p: {
        jobId: string;
        queue: string;
        status: 'completed' | 'failed';
        error?: string;
      },
    ) =>
      cb({
        jobId: p.jobId,
        queue: p.queue,
        status: p.status,
        error: p.error,
      })
    );
  }

  // ─── Job Queries ──────────────────────────────────────────────────────────

  /**
   * Get a job by ID and queue.
   * Pipelines all status key lookups into a single Redis round trip.
   */
  async getJob(jobId: string, queue: string): Promise<Job | null> {
    const keys = JOB_STATUSES.map((s) => `queues:${queue}:${jobId}:${s}`);

    const pipe = this.db.pipeline();
    keys.forEach((key) => pipe.get(key));
    const results = await pipe.exec() as [Error | null, string | null][];

    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i];
      if (!err && data) {
        try {
          const job = JSON.parse(data) as Job;
          job.status = JOB_STATUSES[i];
          return job;
        } catch {
          console.error(`Error parsing job data for ${keys[i]}`);
          return null;
        }
      }
    }

    return null;
  }

  /**
   * List jobs with optional filtering.
   * Pipelines GET calls per SCAN page to reduce round trips.
   */
  async listJobs(options: ListOptions = {}): Promise<Job[]> {
    const { queue, status, limit = 100, offset = 0 } = options;

    if (!queue) {
      throw new Error('queue is required for listJobs');
    }

    const statuses: Job['status'][] = status ? [status] : JOB_STATUSES;
    const jobs: Job[] = [];

    for (const statusType of statuses) {
      const pattern = `queues:${queue}:*:${statusType}`;
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.db.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        ) as [string, string[]];

        cursor = nextCursor;

        if (keys.length === 0) continue;

        // Pipeline all GETs for this SCAN page — N keys = 1 round trip
        const pipe = this.db.pipeline();
        keys.forEach((key) => pipe.get(key));
        const results = await pipe.exec() as [Error | null, string | null][];

        for (let i = 0; i < results.length; i++) {
          const [err, data] = results[i];
          if (!err && data) {
            try {
              const job = JSON.parse(data) as Job;
              job.status = statusType;
              jobs.push(job);
            } catch {
              console.error(`Error parsing job data for ${keys[i]}`);
            }
          }
        }
      } while (cursor !== '0');
    }

    // Sort by timestamp — newest first
    jobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return jobs.slice(offset, offset + limit);
  }

  /**
   * Promote a delayed or waiting job to run now.
   * Updates delayUntil/lockUntil to now and re-enqueues to stream via Remq.enqueueJobToStream
   * so the processor picks it up immediately. Requires Remq instance (enqueueJobToStream).
   * Returns the promoted job or null if not found.
   */
  async promoteJob(jobId: string, queue: string): Promise<Job | null> {
    const job = await this.getJob(jobId, queue);
    if (!job) return null;
    if (job.status !== 'delayed' && job.status !== 'waiting') {
      throw new Error(
        `Cannot promote job with status: ${job.status}. Only delayed or waiting jobs can be promoted.`,
      );
    }
    if (!this.remq) {
      throw new Error(
        'RemqAdmin.promoteJob() requires a Remq instance to enqueue the job to the stream. Use new RemqAdmin(db, remq).',
      );
    }
    const promoted = { ...job, delayUntil: Date.now(), lockUntil: Date.now() };
    await this.db.set(
      `queues:${queue}:${jobId}:${job.status}`,
      JSON.stringify(promoted),
    );
    await this.remq.enqueueJobToStream(queue, promoted as Record<string, unknown>);
    return promoted;
  }
  // ─── Job Mutations ────────────────────────────────────────────────────────

  /**
   * Delete a job and all its status keys.
   * Log keys are no longer stored separately (logs live in job blob).
   */
  async deleteJob(jobId: string, queue: string): Promise<void> {
    const keys = JOB_STATUSES.map((s) => `queues:${queue}:${jobId}:${s}`);
    await this.db.del(...keys);
  }

  /**
   * Retry a failed job.
   * Uses remq.emit() to go through the full emit path (MAXLEN, TTL, stream).
   * Requires RemqAdmin to be constructed with a Remq instance.
   */
  async retryJob(jobId: string, queue: string): Promise<Job | null> {
    const job = await this.getJob(jobId, queue);

    if (!job) return null;

    if (job.status !== 'failed') {
      throw new Error(
        `Cannot retry job with status: ${job.status}. Only failed jobs can be retried.`,
      );
    }

    // Delete failed state key
    await this.db.del(`queues:${queue}:${jobId}:failed`);

    if (this.remq) {
      // Use remq.emit() — goes through full path (MAXLEN, TTL, stream write)
      this.remq.emit(job.state.name, job.state.data, {
        queue,
        id: jobId,
        retryCount: job.retryCount,
        retryDelayMs: job.retryDelayMs,
      });
    } else {
      // Fallback: write waiting state directly (no stream — job won't process until remq picks it up)
      console.warn(
        '[remq] RemqAdmin.retryJob without Remq instance — job state updated but not re-queued to stream. Pass remq to RemqAdmin constructor.',
      );
      const retryJob: Job = {
        ...job,
        status: 'waiting',
        retriedAttempts: job.retriedAttempts + 1,
        timestamp: Date.now(),
        delayUntil: Date.now(),
        lockUntil: Date.now(),
        logs: [
          ...job.logs,
          {
            message: `Retried via RemqAdmin (attempt ${
              job.retriedAttempts + 1
            })`,
            timestamp: Date.now(),
          },
        ],
      };
      await this.db.set(
        `queues:${queue}:${jobId}:waiting`,
        JSON.stringify(retryJob),
      );
      return retryJob;
    }

    return job;
  }

  /**
   * Cancel a waiting or delayed job (deletes it from Redis).
   */
  async cancelJob(jobId: string, queue: string): Promise<boolean> {
    const job = await this.getJob(jobId, queue);

    if (!job) return false;

    if (job.status !== 'waiting' && job.status !== 'delayed') {
      throw new Error(
        `Cannot cancel job with status: ${job.status}. Only waiting or delayed jobs can be cancelled.`,
      );
    }

    await this.deleteJob(jobId, queue);
    return true;
  }

  /**
   * Pause an individual job (only waiting or delayed).
   */
  async pauseJob(jobId: string, queue: string): Promise<Job | null> {
    const job = await this.getJob(jobId, queue);

    if (!job) return null;

    if (job.status !== 'waiting' && job.status !== 'delayed') {
      throw new Error(
        `Cannot pause job with status: ${job.status}. Only waiting or delayed jobs can be paused.`,
      );
    }

    const pausedJob = { ...job, paused: true } as Job;
    await this.db.set(
      `queues:${queue}:${jobId}:${job.status}`,
      JSON.stringify(pausedJob),
    );
    return pausedJob;
  }

  /**
   * Resume a paused job.
   */
  async resumeJob(jobId: string, queue: string): Promise<Job | null> {
    const job = await this.getJob(jobId, queue);

    if (!job) return null;

    const resumedJob = { ...job, paused: false } as Job;
    await this.db.set(
      `queues:${queue}:${jobId}:${job.status}`,
      JSON.stringify(resumedJob),
    );
    return resumedJob;
  }

  // ─── Queue Management ─────────────────────────────────────────────────────

  /**
   * Pause one or all queues.
   */
  async pause(queue?: string): Promise<void> {
    const qs = queue != null ? [queue] : await this.queues();
    const pipe = this.db.pipeline();
    qs.forEach((q) => pipe.set(`queues:${q}:paused`, 'true'));
    await pipe.exec();
  }

  /**
   * Resume one or all queues.
   */
  async resume(queue?: string): Promise<void> {
    const qs = queue != null ? [queue] : await this.queues();
    const pipe = this.db.pipeline();
    qs.forEach((q) => pipe.del(`queues:${q}:paused`));
    await pipe.exec();
  }

  /**
   * Check if a queue is paused.
   */
  async isPaused(queue: string): Promise<boolean> {
    const val = await this.db.get(`queues:${queue}:paused`);
    return val === 'true';
  }

  // ─── Queue Queries ────────────────────────────────────────────────────────

  /**
   * Get all queue names (discovered by scanning keys).
   * Note: O(n) scan — consider a queues:registry SET for large deployments.
   */
  async queues(): Promise<string[]> {
    const found = new Set<string>();
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.db.scan(
        cursor,
        'MATCH',
        'queues:*:*:*',
        'COUNT',
        100,
      ) as [string, string[]];

      cursor = nextCursor;

      for (const key of keys) {
        const parts = key.split(':');
        // queues:{queue}:{jobId}:{status} — skip pause flags queues:{queue}:paused
        if (parts.length === 4 && parts[0] === 'queues') {
          found.add(parts[1]);
        }
      }
    } while (cursor !== '0');

    return Array.from(found).sort();
  }

  /**
   * Get job count stats for a queue.
   * Uses SCAN per status — counts only, no data fetch.
   */
  async stats(queue: string): Promise<QueueStats> {
    const result: QueueStats = {
      queue,
      waiting: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      total: 0,
    };

    for (const status of JOB_STATUSES) {
      const pattern = `queues:${queue}:*:${status}`;
      let count = 0;
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.db.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        ) as [string, string[]];

        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');

      result[status] = count;
      result.total += count;
    }

    return result;
  }

  /**
   * Get all queues with their stats.
   */
  async queuesInfo(): Promise<QueueInfo[]> {
    const names = await this.queues();
    return Promise.all(
      names.map(async (name) => ({
        name,
        stats: await this.stats(name),
      })),
    );
  }
}
