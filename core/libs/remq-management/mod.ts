/**
 * RemqManagement — queue and job administration via management.api.jobs and management.api.queues.
 *
 * @example
 * const management = new RemqManagement({ db, streamdb, remq });
 * await management.api.jobs.find();
 * await management.api.queues.find();
 *
 * @module
 */
import type { RedisConnection } from '../../types/index.ts';
import type { Remq } from '../remq/mod.ts';
import { SUBSCRIBE_JOB_FINISHED } from '../remq/mod.ts';

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

/** Summary of a queue: name, stream key, pause state, and current length. Returned by queues.find(). */
export interface QueueRecord {
  name: string;
  stream: string;
  paused: boolean;
  length: number;
}

/** Payload emitted when a job reaches a terminal state (completed or failed). Used by events.job callbacks. */
export interface JobFinishedPayload {
  jobId: string;
  queue: string;
  status: 'completed' | 'failed';
  error?: string;
}

/** Options to create a RemqManagement instance. Pass db and streamdb; optional remq required for events and promote. */
export interface RemqManagementOptions {
  db: RedisConnection;
  streamdb: RedisConnection;
  remq?: Remq<any>;
}

// ─── Active job statuses — terminal states use execId suffix ─────────────────

const ACTIVE_STATUSES = ['processing', 'waiting', 'delayed'] as const;
const TERMINAL_STATUSES = ['completed', 'failed'] as const;
const ALL_STATUSES = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] as const;

// ─── RemqManagement ───────────────────────────────────────────────────────────

/** Queue and job administration. Use api.jobs and api.queues for CRUD; events.job for completion/failure. */
export class RemqManagement {
  private readonly db: RedisConnection;
  private readonly streamdb: RedisConnection;
  private readonly remq?: Remq<any>;

  readonly api: {
    jobs: JobsApi;
    queues: QueuesApi;
  };

  readonly events: {
    job: {
      /** Subscribe to all terminal job events (completed + failed). */
      finished: (cb: (payload: JobFinishedPayload) => void) => () => void;
      /** Subscribe to completed jobs only. */
      completed: (cb: (payload: JobFinishedPayload) => void) => () => void;
      /** Subscribe to failed jobs only. */
      failed: (cb: (payload: JobFinishedPayload) => void) => () => void;
    };
  };

  /**
   * Create a management client. Provide db and streamdb; add remq for events.job and api.jobs.promote().
   * @param options - Connection and optional Remq instance
   */
  constructor(options: RemqManagementOptions) {
    this.db = options.db;
    this.streamdb = options.streamdb;
    this.remq = options.remq;

    this.api = {
      jobs: new JobsApi(this.db, this.streamdb, this.remq),
      queues: new QueuesApi(this.db, this.streamdb, this.remq),
    };

    this.events = {
      job: {
        finished: (cb) => this.#subscribe(cb),
        completed: (cb) =>
          this.#subscribe((p) => {
            if (p.status === 'completed') cb(p);
          }),
        failed: (cb) =>
          this.#subscribe((p) => {
            if (p.status === 'failed') cb(p);
          }),
      },
    };
  }

  #subscribe(cb: (payload: JobFinishedPayload) => void): () => void {
    if (!this.remq) {
      throw new Error(
        'management.events requires a Remq instance: new RemqManagement({ db, streamdb, remq })',
      );
    }
    return this.remq[SUBSCRIBE_JOB_FINISHED](cb);
  }
}

// ─── JobsApi ──────────────────────────────────────────────────────────────────

class JobsApi {
  constructor(
    private readonly db: RedisConnection,
    private readonly streamdb: RedisConnection,
    private readonly remq?: Remq<any>,
  ) {}

  /**
   * Find all jobs across all queues and statuses.
   * Returns one entry per jobId — most recent terminal state wins for completed/failed.
   * Redis is fast — no pagination, return everything.
   */
  async find(): Promise<JobRecord[]> {
    const jobMap = new Map<string, JobRecord>();

    // ── Active statuses: exact key pattern queues:{queue}:{jobId}:{status} ──
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
        const mapKey = `${job.queue}:${job.id}`;
        jobMap.set(mapKey, job);
      }
    }

    // ── Terminal statuses: pattern queues:{queue}:{jobId}:{status}:{execId} ──
    // Multiple execIds may exist per jobId — keep most recent (highest timestamp)
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

        // Extract execId from key: queues:{queue}:{jobId}:{status}:{execId}
        const parts = keys[i].split(':');
        const execId = parts[parts.length - 1];

        const job = this.#parseJob(data, status, keys[i], execId);
        if (!job) continue;

        const mapKey = `${job.queue}:${job.id}`;
        const existing = jobMap.get(mapKey);

        // Keep most recent terminal state by timestamp
        if (!existing || (job.timestamp ?? 0) > (existing.timestamp ?? 0)) {
          jobMap.set(mapKey, job);
        }
      }
    }

    return Array.from(jobMap.values()).sort((a, b) =>
      (b.timestamp ?? 0) - (a.timestamp ?? 0)
    );
  }

  /**
   * Get a single job by composite key "{queue}:{jobId}".
   * Runs find() then filters — Redis is fast, consistent with find() results.
   */
  async get(key: string): Promise<JobRecord | null> {
    const [queue, ...rest] = key.split(':');
    const jobId = rest.join(':');
    if (!queue || !jobId) {
      throw new Error('key must be in format "{queue}:{jobId}"');
    }
    const jobs = await this.find();
    return jobs.find((j) => j.queue === queue && j.id === jobId) ?? null;
  }

  /**
   * Delete a job by composite key "{queue}:{jobId}".
   * Deletes all state keys — active and all terminal executions.
   */
  async delete(key: string): Promise<boolean> {
    const [queue, ...rest] = key.split(':');
    const jobId = rest.join(':');
    if (!queue || !jobId) {
      throw new Error('key must be in format "{queue}:{jobId}"');
    }

    // Delete active state keys
    const activeKeys = ACTIVE_STATUSES.map(
      (s) => `queues:${queue}:${jobId}:${s}`,
    );

    // Scan for terminal state keys (have execId suffix)
    const terminalKeys: string[] = [];
    for (const status of TERMINAL_STATUSES) {
      const found = await this.#scanKeys(
        `queues:${queue}:${jobId}:${status}:*`,
      );
      terminalKeys.push(...found);
    }

    const allKeys = [...activeKeys, ...terminalKeys];
    if (!allKeys.length) return false;

    await this.db.del(...allKeys);
    return true;
  }

  /**
   * Promote a job to run immediately.
   * Reads from delayed state key if available, falls back to stream scan.
   * Re-emits with delay: now via remq.emit().
   * Requires remq instance.
   */
  async promote(key: string): Promise<JobRecord | null> {
    if (!this.remq) {
      throw new Error(
        'promote() requires a Remq instance: new RemqManagement({ db, streamdb, remq })',
      );
    }

    const job = await this.get(key);
    if (!job) return null;

    if (job.status !== 'delayed' && job.status !== 'waiting') {
      throw new Error(
        `Cannot promote job with status "${job.status}". Only delayed or waiting jobs can be promoted.`,
      );
    }

    // Update state key to reflect immediate delayUntil
    const promoted = {
      ...job,
      delayUntil: Date.now(),
      lockUntil: Date.now(),
    };

    await this.db.set(
      `queues:${job.queue}:${job.id}:${job.status}`,
      JSON.stringify(promoted),
    );

    // Re-emit immediately — delay: now bypasses cron pattern recompute
    this.remq.emit(job.name, job.data, {
      queue: job.queue,
      id: job.id,
      delay: new Date(),
    });

    return promoted;
  }

  /**
   * Pause a job by setting delayUntil to Number.MAX_SAFE_INTEGER.
   * Job stays in stream but delay check will never let it through.
   * Only waiting or delayed jobs can be paused.
   */
  async pause(key: string): Promise<JobRecord | null> {
    const job = await this.get(key);
    if (!job) return null;

    if (job.status !== 'waiting' && job.status !== 'delayed') {
      throw new Error(
        `Cannot pause job with status "${job.status}". Only waiting or delayed jobs can be paused.`,
      );
    }

    const paused = {
      ...job,
      delayUntil: Number.MAX_SAFE_INTEGER,
      lockUntil: Number.MAX_SAFE_INTEGER,
      paused: true,
    };

    await this.db.set(
      `queues:${job.queue}:${job.id}:${job.status}`,
      JSON.stringify(paused),
    );

    return paused as JobRecord;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  #parseJob(
    data: string,
    status: string,
    key: string,
    execId?: string,
  ): JobRecord | null {
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
      console.error(`[remq] Failed to parse job from key: ${key}`);
      return null;
    }
  }

  async #scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.db.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      ) as [string, string[]];
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}

// ─── QueuesApi ────────────────────────────────────────────────────────────────

class QueuesApi {
  constructor(
    private readonly db: RedisConnection,
    private readonly streamdb: RedisConnection,
    private readonly remq?: Remq<any>,
  ) {}

  /**
   * Find all registered queues — includes empty streams.
   * Discovers queues by scanning both state keys and stream keys.
   */
  async find(): Promise<QueueRecord[]> {
    const queueNames = new Set<string>();

    // Discover from state keys
    let cursor = '0';
    do {
      const [next, keys] = await this.db.scan(
        cursor,
        'MATCH',
        'queues:*:*:*',
        'COUNT',
        100,
      ) as [string, string[]];
      cursor = next;
      for (const key of keys) {
        const parts = key.split(':');
        // queues:{queue}:{jobId}:{status} — 4 or 5 parts
        if (parts.length >= 4 && parts[0] === 'queues') {
          // Skip pause flags: queues:{queue}:paused (3 parts)
          queueNames.add(parts[1]);
        }
      }
    } while (cursor !== '0');

    // Discover from stream keys — catches queues with stream but no state keys
    const streamKeys = await this.#scanStreamKeys('*-stream');
    for (const key of streamKeys) {
      const queueName = key.replace(/-stream$/, '');
      queueNames.add(queueName);
    }

    // Build queue records
    const records = await Promise.all(
      Array.from(queueNames).sort().map(async (name) => {
        const [paused, length] = await Promise.all([
          this.running(name).then((r) => !r),
          this.#streamLength(name),
        ]);
        return {
          name,
          stream: `${name}-stream`,
          paused,
          length,
        } as QueueRecord;
      }),
    );

    return records;
  }

  /**
   * Pause a queue — sets paused flag, consumer skips processing.
   */
  async pause(key: string): Promise<void> {
    await this.db.set(`queues:${key}:paused`, 'true');
  }

  /**
   * Resume a paused queue — removes paused flag.
   */
  async resume(key: string): Promise<void> {
    await this.db.del(`queues:${key}:paused`);
  }

  /**
   * Reset a queue — flush all jobs and trim the stream to empty.
   * Deletes all state keys and stream entries for the queue.
   * Destructive — no undo.
   */
  async reset(key: string): Promise<void> {
    const streamKey = `${key}-stream`;

    // Delete all state keys for this queue
    const stateKeys = await this.#scanStateKeys(`queues:${key}:*`);
    if (stateKeys.length) {
      // DEL in batches of 1000 to avoid blocking Redis
      for (let i = 0; i < stateKeys.length; i += 1000) {
        await this.db.del(...stateKeys.slice(i, i + 1000));
      }
    }

    // Trim stream to empty — XTRIM MAXLEN 0
    try {
      await this.streamdb.xtrim(streamKey, 'MAXLEN', 0);
    } catch {
      // Stream may not exist — non-fatal
    }

    // Delete consumer group so cursor resets on next start()
    try {
      await this.streamdb.xgroup('DESTROY', streamKey, 'processor');
    } catch {
      // Group may not exist — non-fatal
    }
  }

  /**
   * Check if a queue is active (not paused).
   * Returns true if running, false if paused.
   */
  async running(key: string): Promise<boolean> {
    const val = await this.db.get(`queues:${key}:paused`);
    return val !== 'true';
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  async #streamLength(queueName: string): Promise<number> {
    try {
      return await this.streamdb.xlen(`${queueName}-stream`);
    } catch {
      return 0;
    }
  }

  async #scanStateKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.db.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      ) as [string, string[]];
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async #scanStreamKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.streamdb.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      ) as [string, string[]];
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}
