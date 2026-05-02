/**
 * HoundManagement — queue and job administration via management.api.jobs and management.api.queues.
 *
 * @example
 * const management = new HoundManagement({ db, hound });
 * await management.api.jobs.find();
 * await management.api.queues.find();
 *
 * @module
 */
import type { RedisConnection } from '../../types/index.ts';
import type { Hound } from '../hound/mod.ts';
import { SUBSCRIBE_JOB_FINISHED } from '../hound/mod.ts';
import { QueueStore } from '../consumer/queue-store.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

/** In-memory snapshot of a single job as stored in Redis. Returned by jobs.find(), jobs.get(), etc. */
export interface JobRecord {
  id: string;
  queue: string;
  status: 'waiting' | 'delayed' | 'processing' | 'completed' | 'failed';
  name: string;
  data: unknown;
  retryCount: number;
  retriedAttempts: number;
  retryDelayMs: number;
  retryBackoff: 'fixed' | 'exponential';
  priority: number;
  delayUntil: number;
  lockUntil: number;
  repeatCount: number;
  logs: { message: string; timestamp: number }[];
  errors: { message: string; stack?: string; timestamp: number }[];
  timestamp: number;
  lastRun?: number;
  paused?: boolean;
  execId?: string;
}

/** Summary of a queue: name, pause state, and current length. Returned by queues.find(). */
export interface QueueRecord {
  name: string;
  paused: boolean;
  length: number;
}

/** Per-status job counts for a single queue. Returned by queues.stats(). */
export interface QueueStats {
  waiting: number;
  delayed: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

/** Optional filters for jobs.find(). */
export interface FindJobsOptions {
  /** Narrow to a specific queue name. */
  queue?: string;
  /** Narrow to a specific job status. */
  status?: JobRecord['status'];
}

/** Payload emitted when a job reaches a terminal state (completed or failed). */
export interface JobFinishedPayload {
  jobId: string;
  queue: string;
  status: 'completed' | 'failed';
  error?: string;
}

/** Options to create a HoundManagement instance. */
export interface HoundManagementOptions {
  db: RedisConnection;
  hound?: Hound<any>;
}

// ─── Active job statuses — terminal states use execId suffix ─────────────────

const ACTIVE_STATUSES = ['processing', 'waiting', 'delayed'] as const;
const TERMINAL_STATUSES = ['completed', 'failed'] as const;

// ─── HoundManagement ───────────────────────────────────────────────────────────

/** Queue and job administration. Use api.jobs and api.queues for CRUD; events.job for completion/failure. */
export class HoundManagement {
  private readonly db: RedisConnection;
  private readonly hound?: Hound<any>;

  readonly api: {
    readonly jobs: JobsApi;
    readonly queues: QueuesApi;
  };

  readonly events: {
    job: {
      finished: (cb: (payload: JobFinishedPayload) => void) => () => void;
      completed: (cb: (payload: JobFinishedPayload) => void) => () => void;
      failed: (cb: (payload: JobFinishedPayload) => void) => () => void;
    };
  };

  constructor(options: HoundManagementOptions) {
    this.db = options.db;
    this.hound = options.hound;

    this.api = {
      jobs: new JobsApi(this.db, this.hound),
      queues: new QueuesApi(this.db, this.hound),
    };

    this.events = {
      job: {
        finished: (cb) => this.#subscribe(cb),
        completed: (cb) => this.#subscribe((p) => { if (p.status === 'completed') cb(p); }),
        failed: (cb) => this.#subscribe((p) => { if (p.status === 'failed') cb(p); }),
      },
    };
  }

  #subscribe(cb: (payload: JobFinishedPayload) => void): () => void {
    if (!this.hound) {
      throw new Error(
        'management.events requires a Hound instance: new HoundManagement({ db, hound })',
      );
    }
    return this.hound[SUBSCRIBE_JOB_FINISHED](cb);
  }
}

// ─── JobsApi ──────────────────────────────────────────────────────────────────

class JobsApi {
  constructor(
    private readonly db: RedisConnection,
    private readonly hound?: Hound<any>,
  ) {}

  /**
   * Find jobs across all queues and statuses.
   * Returns one entry per jobId — most recent terminal state wins for completed/failed.
   * Pass options to narrow by queue or status.
   */
  async find(options?: FindJobsOptions): Promise<JobRecord[]> {
    const jobMap = new Map<string, JobRecord>();

    for (const status of ACTIVE_STATUSES) {
      const pattern = `queues:*:*:${status}`;
      const keys = await this.#scanKeys(pattern);
      if (!keys.length) continue;

      const pipe = this.db.pipeline();
      keys.forEach((k) => pipe.get(k));
      const results = await pipe.exec() as [Error | null, string | null][];

      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (err || !data) continue;
        const job = this.#parseJob(data, status, keys[i]);
        if (!job) continue;
        jobMap.set(`${job.queue}:${job.id}`, job);
      }
    }

    for (const status of TERMINAL_STATUSES) {
      const pattern = `queues:*:*:${status}:*`;
      const keys = await this.#scanKeys(pattern);
      if (!keys.length) continue;

      const pipe = this.db.pipeline();
      keys.forEach((k) => pipe.get(k));
      const results = await pipe.exec() as [Error | null, string | null][];

      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (err || !data) continue;
        const parts = keys[i].split(':');
        const execId = parts[parts.length - 1];
        const job = this.#parseJob(data, status, keys[i], execId);
        if (!job) continue;
        const mapKey = `${job.queue}:${job.id}`;
        const existing = jobMap.get(mapKey);
        if (!existing || (job.timestamp ?? 0) > (existing.timestamp ?? 0)) {
          jobMap.set(mapKey, job);
        }
      }
    }

    let results = Array.from(jobMap.values()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    if (options?.queue) results = results.filter((j) => j.queue === options.queue);
    if (options?.status) results = results.filter((j) => j.status === options.status);
    return results;
  }

  async get(key: string): Promise<JobRecord | null> {
    const [queue, ...rest] = key.split(':');
    const jobId = rest.join(':');
    if (!queue || !jobId) throw new Error('key must be in format "{queue}:{jobId}"');
    const jobs = await this.find();
    return jobs.find((j) => j.queue === queue && j.id === jobId) ?? null;
  }

  async delete(key: string): Promise<boolean> {
    const [queue, ...rest] = key.split(':');
    const jobId = rest.join(':');
    if (!queue || !jobId) throw new Error('key must be in format "{queue}:{jobId}"');

    // Only include active keys that actually exist in Redis
    const candidateActive = ACTIVE_STATUSES.map((s) => `queues:${queue}:${jobId}:${s}`);
    const pipe = this.db.pipeline();
    candidateActive.forEach((k) => pipe.get(k));
    const fetched = await pipe.exec() as [Error | null, string | null][];
    const activeKeys = candidateActive.filter((_, i) => fetched[i][1] !== null);

    const terminalKeys: string[] = [];
    for (const status of TERMINAL_STATUSES) {
      const found = await this.#scanKeys(`queues:${queue}:${jobId}:${status}:*`);
      terminalKeys.push(...found);
    }

    const allKeys = [...activeKeys, ...terminalKeys];
    if (!allKeys.length) return false;

    await this.db.del(...allKeys);
    return true;
  }

  async promote(key: string): Promise<JobRecord | null> {
    if (!this.hound) {
      throw new Error('promote() requires a Hound instance: new HoundManagement({ db, hound })');
    }

    const job = await this.get(key);
    if (!job) return null;

    if (job.status !== 'delayed' && job.status !== 'waiting') {
      throw new Error(
        `Cannot promote job with status "${job.status}". Only delayed or waiting jobs can be promoted.`,
      );
    }

    // Mutate the raw stored payload (not the JobRecord projection from get(),
    // which lacks state.name/queue/options and would corrupt the state record).
    const stateKey = `queues:${job.queue}:${job.id}:${job.status}`;
    const raw = await this.db.get(stateKey);
    if (!raw) return null;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    payload.delayUntil = now;
    payload.lockUntil = now;
    await this.db.set(stateKey, JSON.stringify(payload));

    // Re-enqueue with score=now. Use enqueueJob (not emit) to preserve cron
    // metadata (repeat.pattern, repeatCount, status='delayed') — emit() rebuilds
    // the payload and would kill the cron recurrence.
    await this.hound.enqueueJob(job.queue, payload);

    return { ...job, delayUntil: now, lockUntil: now };
  }

  async pause(key: string): Promise<JobRecord | null> {
    const job = await this.get(key);
    if (!job) return null;

    if (job.status !== 'waiting' && job.status !== 'delayed') {
      throw new Error(
        `Cannot pause job with status "${job.status}". Only waiting or delayed jobs can be paused.`,
      );
    }

    const paused = { ...job, delayUntil: Number.MAX_SAFE_INTEGER, lockUntil: Number.MAX_SAFE_INTEGER, paused: true };
    await this.db.set(`queues:${job.queue}:${job.id}:${job.status}`, JSON.stringify(paused));

    return paused as JobRecord;
  }

  /** Resume a paused job — reverses a previous jobs.pause(). Resets delayUntil to now. */
  async resume(key: string): Promise<JobRecord | null> {
    const job = await this.get(key);
    if (!job) return null;

    if (!job.paused) {
      throw new Error(
        `Cannot resume job that is not paused. Current status: "${job.status}"`,
      );
    }

    const resumed = { ...job, delayUntil: Date.now(), lockUntil: Date.now(), paused: false };
    await this.db.set(`queues:${job.queue}:${job.id}:${job.status}`, JSON.stringify(resumed));

    return resumed;
  }

  /**
   * Retry a failed job — re-enqueues it for immediate processing.
   * Requires a Hound instance: new HoundManagement({ db, hound }).
   */
  async retry(key: string): Promise<JobRecord | null> {
    if (!this.hound) {
      throw new Error(
        'retry() requires a Hound instance: new HoundManagement({ db, hound })',
      );
    }

    const job = await this.get(key);
    if (!job) return null;

    if (job.status !== 'failed') {
      throw new Error(
        `Cannot retry job with status "${job.status}". Only failed jobs can be retried.`,
      );
    }

    this.hound.emit(job.name, job.data, { queue: job.queue, id: job.id, delay: new Date() });

    return job;
  }

  #parseJob(data: string, status: string, key: string, execId?: string): JobRecord | null {
    try {
      const raw = JSON.parse(data);
      return {
        id: raw.id,
        queue: raw.state?.queue ?? key.split(':')[1],
        name: raw.state?.name ?? '',
        status: status as JobRecord['status'],
        data: raw.state?.data ?? null,
        retryCount: raw.retryCount ?? 0,
        retriedAttempts: raw.retriedAttempts ?? 0,
        retryDelayMs: raw.retryDelayMs ?? 1000,
        retryBackoff: raw.retryBackoff ?? 'fixed',
        priority: raw.priority ?? 0,
        delayUntil: raw.delayUntil ?? 0,
        lockUntil: raw.lockUntil ?? 0,
        repeatCount: raw.repeatCount ?? 0,
        logs: raw.logs ?? [],
        errors: raw.errors ?? [],
        timestamp: raw.timestamp ?? 0,
        lastRun: raw.lastRun,
        paused: raw.paused ?? false,
        execId,
      };
    } catch {
      console.error(`[hound] Failed to parse job from key: ${key}`);
      return null;
    }
  }

  async #scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.db.scan(cursor, 'MATCH', pattern, 'COUNT', 100) as [string, string[]];
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}

// ─── QueuesApi ────────────────────────────────────────────────────────────────

class QueuesApi {
  private readonly queueStore: QueueStore;

  constructor(
    private readonly db: RedisConnection,
    private readonly hound?: Hound<any>,
  ) {
    this.queueStore = new QueueStore(db);
  }

  /** Find all queues — discovers by scanning state keys. */
  async find(): Promise<QueueRecord[]> {
    const queueNames = new Set<string>();

    let cursor = '0';
    do {
      const [next, keys] = await this.db.scan(cursor, 'MATCH', 'queues:*:*:*', 'COUNT', 100) as [string, string[]];
      cursor = next;
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 4 && parts[0] === 'queues') {
          queueNames.add(parts[1]);
        }
      }
    } while (cursor !== '0');

    // Also discover from sorted-set queue keys
    let qCursor = '0';
    do {
      const [next, keys] = await this.db.scan(qCursor, 'MATCH', 'queues:*:q', 'COUNT', 100) as [string, string[]];
      qCursor = next;
      for (const key of keys) {
        // queues:{queue}:q
        const parts = key.split(':');
        if (parts.length === 3) queueNames.add(parts[1]);
      }
    } while (qCursor !== '0');

    const records = await Promise.all(
      Array.from(queueNames).sort().map(async (name) => {
        const [paused, length] = await Promise.all([
          this.running(name).then((r) => !r),
          this.queueStore.queueLength(name),
        ]);
        return { name, paused, length } as QueueRecord;
      }),
    );

    return records;
  }

  async pause(key: string): Promise<void> {
    await this.db.set(`queues:${key}:paused`, 'true');
  }

  async resume(key: string): Promise<void> {
    await this.db.del(`queues:${key}:paused`);
  }

  /**
   * Reset a queue — delete all state keys, the queue sorted set, and the processing set.
   * Destructive — no undo.
   */
  async reset(key: string): Promise<void> {
    const stateKeys = await this.#scanStateKeys(`queues:${key}:*`);
    if (stateKeys.length) {
      for (let i = 0; i < stateKeys.length; i += 1000) {
        await this.db.del(...stateKeys.slice(i, i + 1000));
      }
    }
    await this.queueStore.deleteQueue(key);
  }

  async running(key: string): Promise<boolean> {
    const val = await this.db.get(`queues:${key}:paused`);
    return val !== 'true';
  }

  /** Per-status job counts for a queue. Deduplicates completed/failed by jobId. */
  async stats(key: string): Promise<QueueStats> {
    const counts = { waiting: 0, delayed: 0, processing: 0, completed: 0, failed: 0 };

    for (const status of ACTIVE_STATUSES) {
      const keys = await this.#scanStateKeys(`queues:${key}:*:${status}`);
      counts[status] = keys.length;
    }

    for (const status of TERMINAL_STATUSES) {
      const keys = await this.#scanStateKeys(`queues:${key}:*:${status}:*`);
      counts[status] = new Set(keys.map((k) => k.split(':')[2])).size;
    }

    return { ...counts, total: counts.waiting + counts.delayed + counts.processing + counts.completed + counts.failed };
  }

  async #scanStateKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.db.scan(cursor, 'MATCH', pattern, 'COUNT', 100) as [string, string[]];
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}
