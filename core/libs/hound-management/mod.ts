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
import {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  indexKey,
  indexKeyForState,
  type ParsedStateKey,
  parseStateKey,
  QUEUE_REGISTRY_KEY,
  TERMINAL_STATUSES,
} from '../consumer/job-index.ts';

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
  /**
   * Max records to return, applied after sorting and filtering. Reads are
   * index-backed — only the requested page's payloads are fetched.
   */
  limit?: number;
  /** Records to skip before limit — for offset pagination. */
  offset?: number;
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

// ─── HoundManagement ───────────────────────────────────────────────────────────

/** Queue and job administration. Use api.jobs and api.queues for CRUD; events.job for completion/failure. */
export class HoundManagement {
  private readonly db: RedisConnection;
  private readonly hound?: Hound<any>;

  readonly api: {
    readonly jobs: JobsApi;
    readonly queues: QueuesApi;
    /** Rebuild indexes + queue registry from a one-time keyspace scan (migration). */
    readonly reindex: () => Promise<number>;
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

    const jobs = new JobsApi(this.db, this.hound);
    this.api = {
      jobs,
      queues: new QueuesApi(this.db, this.hound),
      reindex: () => jobs.reindex(),
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
  private readonly queueStore: QueueStore;

  constructor(
    private readonly db: RedisConnection,
    private readonly hound?: Hound<any>,
  ) {
    this.queueStore = new QueueStore(db);
  }

  /**
   * Find jobs across queues and statuses — index-backed, no keyspace SCAN.
   * Reads the per-queue-status index zsets (member = state key, score =
   * transition time), merges to one entry per jobId (newest terminal state
   * wins over an older active one), sorts newest-first, and only fetches the
   * requested page's payloads. Index members whose state key has expired are
   * removed lazily.
   */
  async find(options?: FindJobsOptions): Promise<JobRecord[]> {
    const statuses = options?.status ? [options.status] : [...ALL_STATUSES];
    const queues = options?.queue
      ? [options.queue]
      : await this.db.zrangebyscore(QUEUE_REGISTRY_KEY, '-inf', '+inf');

    interface Entry {
      key: string;
      score: number;
      parsed: ParsedStateKey;
    }
    const entries: Entry[] = [];
    for (const queue of queues) {
      for (const status of statuses) {
        const flat = await this.db.zrangebyscore(
          indexKey(queue, status),
          '-inf',
          '+inf',
          'WITHSCORES',
        );
        for (let i = 0; i < flat.length; i += 2) {
          const parsed = parseStateKey(flat[i]);
          if (!parsed) continue;
          entries.push({ key: flat[i], score: Number(flat[i + 1]), parsed });
        }
      }
    }

    // One entry per jobId. Among actives: delayed > waiting > processing;
    // terminal vs anything: newer score wins — mirrors the original
    // scan-based merge, with index scores standing in for payload timestamps.
    const ACTIVE_RANK: Record<string, number> = {
      processing: 0,
      waiting: 1,
      delayed: 2,
    };
    const chosen = new Map<string, Entry>();
    for (const e of entries) {
      const id = `${e.parsed.queue}:${e.parsed.jobId}`;
      const cur = chosen.get(id);
      if (!cur) {
        chosen.set(id, e);
        continue;
      }
      const bothActive = e.parsed.execId === undefined &&
        cur.parsed.execId === undefined;
      if (bothActive) {
        if (ACTIVE_RANK[e.parsed.status] > ACTIVE_RANK[cur.parsed.status]) {
          chosen.set(id, e);
        }
      } else if (e.score > cur.score) {
        chosen.set(id, e);
      }
    }

    // Newest first; paginate BEFORE fetching payloads.
    let page = [...chosen.values()].sort((a, b) => b.score - a.score);
    if (options?.offset !== undefined && options.offset > 0) {
      page = page.slice(options.offset);
    }
    if (options?.limit !== undefined && options.limit >= 0) {
      page = page.slice(0, options.limit);
    }
    if (!page.length) return [];

    const pipe = this.db.pipeline();
    page.forEach((e) => pipe.get(e.key));
    const results = await pipe.exec() as [Error | null, string | null][];

    const jobs: JobRecord[] = [];
    const stale: Entry[] = [];
    for (let i = 0; i < page.length; i++) {
      const [err, data] = results[i];
      if (err || !data) {
        stale.push(page[i]);
        continue;
      }
      const job = this.#parseJob(
        data,
        page[i].parsed.status,
        page[i].key,
        page[i].parsed.execId,
      );
      if (job) jobs.push(job);
    }

    // Lazy repair — drop members whose state key expired or was deleted.
    if (stale.length) {
      const clean = this.db.pipeline();
      for (const e of stale) {
        clean.zrem(indexKey(e.parsed.queue, e.parsed.status), e.key);
      }
      await clean.exec();
    }

    return jobs;
  }

  /**
   * Get a single job by "{queue}:{jobId}" key. Direct key lookups — does not
   * scan the full keyspace like find(). Merge semantics match find(): later
   * active statuses win (delayed > waiting > processing), and a terminal
   * record replaces the active one when its timestamp is newer.
   */
  async get(key: string): Promise<JobRecord | null> {
    const [queue, ...rest] = key.split(':');
    const jobId = rest.join(':');
    if (!queue || !jobId) {
      throw new Error('key must be in format "{queue}:{jobId}"');
    }

    const activeKeys = ACTIVE_STATUSES.map((s) =>
      `queues:${queue}:${jobId}:${s}`
    );
    const pipe = this.db.pipeline();
    activeKeys.forEach((k) => pipe.get(k));
    const fetched = await pipe.exec() as [Error | null, string | null][];

    let job: JobRecord | null = null;
    for (let i = 0; i < ACTIVE_STATUSES.length; i++) {
      const data = fetched[i][1];
      if (!data) continue;
      const parsed = this.#parseJob(data, ACTIVE_STATUSES[i], activeKeys[i]);
      if (parsed) job = parsed;
    }

    for (const status of TERMINAL_STATUSES) {
      const keys = await this.#terminalKeysFor(queue, jobId, status);
      if (!keys.length) continue;

      const tPipe = this.db.pipeline();
      keys.forEach((k) => tPipe.get(k));
      const results = await tPipe.exec() as [Error | null, string | null][];

      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (err || !data) continue;
        const parts = keys[i].split(':');
        const parsed = this.#parseJob(
          data,
          status,
          keys[i],
          parts[parts.length - 1],
        );
        if (!parsed) continue;
        if (!job || (parsed.timestamp ?? 0) > (job.timestamp ?? 0)) {
          job = parsed;
        }
      }
    }

    return job;
  }

  /**
   * Rebuild the queue registry and all index zsets from a one-time keyspace
   * scan. Run once when upgrading a deployment that has pre-index job data —
   * everything written after the upgrade indexes itself. Returns the number
   * of state keys indexed.
   */
  async reindex(): Promise<number> {
    // Wipe existing indexes first so stale members don't linger.
    const oldIdx = await this.#scanKeys('hound:idx:*');
    if (oldIdx.length) await this.db.del(...oldIdx);
    await this.db.del(QUEUE_REGISTRY_KEY);

    const patterns = [
      ...ACTIVE_STATUSES.map((s) => `queues:*:*:${s}`),
      ...TERMINAL_STATUSES.map((s) => `queues:*:*:${s}:*`),
    ];

    let count = 0;
    for (const pattern of patterns) {
      const keys = await this.#scanKeys(pattern);
      if (!keys.length) continue;

      const getPipe = this.db.pipeline();
      keys.forEach((k) => getPipe.get(k));
      const results = await getPipe.exec() as [Error | null, string | null][];

      const idxPipe = this.db.pipeline();
      let staged = 0;
      for (let i = 0; i < keys.length; i++) {
        const [err, data] = results[i];
        if (err || !data) continue; // expired, or non-string key caught by the pattern
        const parsed = parseStateKey(keys[i]);
        if (!parsed) continue;
        let ts = Date.now();
        try {
          ts = (JSON.parse(data) as { timestamp?: number }).timestamp ?? ts;
        } catch {
          continue; // not a job payload
        }
        idxPipe.zadd(indexKey(parsed.queue, parsed.status), ts, keys[i]);
        idxPipe.zadd(QUEUE_REGISTRY_KEY, ts, parsed.queue);
        staged++;
      }
      if (staged) await idxPipe.exec();
      count += staged;
    }
    return count;
  }

  /** Terminal state keys for a job — index member prefix filter, no SCAN. */
  async #terminalKeysFor(
    queue: string,
    jobId: string,
    status: string,
  ): Promise<string[]> {
    const prefix = `queues:${queue}:${jobId}:${status}:`;
    const members = await this.db.zrangebyscore(
      indexKey(queue, status),
      '-inf',
      '+inf',
    );
    return members.filter((m) => m.startsWith(prefix));
  }

  async delete(key: string): Promise<boolean> {
    const [queue, ...rest] = key.split(':');
    const jobId = rest.join(':');
    if (!queue || !jobId) {
      throw new Error('key must be in format "{queue}:{jobId}"');
    }

    // Only include active keys that actually exist in Redis
    const candidateActive = ACTIVE_STATUSES.map((s) =>
      `queues:${queue}:${jobId}:${s}`
    );
    const pipe = this.db.pipeline();
    candidateActive.forEach((k) => pipe.get(k));
    const fetched = await pipe.exec() as [Error | null, string | null][];
    const activeKeys = candidateActive.filter((_, i) => fetched[i][1] !== null);

    const terminalKeys: string[] = [];
    for (const status of TERMINAL_STATUSES) {
      terminalKeys.push(...await this.#terminalKeysFor(queue, jobId, status));
    }

    const allKeys = [...activeKeys, ...terminalKeys];
    if (!allKeys.length) return false;

    const pipe2 = this.db.pipeline();
    pipe2.del(...allKeys);
    for (const k of allKeys) {
      const idx = indexKeyForState(k);
      if (idx) pipe2.zrem(idx, k);
    }
    await pipe2.exec();
    return true;
  }

  async promote(key: string): Promise<JobRecord | null> {
    if (!this.hound) {
      throw new Error(
        'promote() requires a Hound instance: new HoundManagement({ db, hound })',
      );
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

    // Mutate the raw stored payload (not the JobRecord projection from get(),
    // which lacks state.name/queue/options and would corrupt the state record).
    const stateKey = `queues:${job.queue}:${job.id}:${job.status}`;
    const raw = await this.db.get(stateKey);
    if (!raw) return null;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    payload.delayUntil = Number.MAX_SAFE_INTEGER;
    payload.lockUntil = Number.MAX_SAFE_INTEGER;
    payload.paused = true;
    await this.db.set(stateKey, JSON.stringify(payload));

    // Push the queue-set score out too — otherwise the consumer still claims
    // the job when its original score comes due. resume() re-scores to now.
    await this.queueStore.enqueue(job.queue, job.id, Number.MAX_SAFE_INTEGER);

    return {
      ...job,
      delayUntil: Number.MAX_SAFE_INTEGER,
      lockUntil: Number.MAX_SAFE_INTEGER,
      paused: true,
    };
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

    // Mutate the raw stored payload — see pause() for why not the projection.
    const stateKey = `queues:${job.queue}:${job.id}:${job.status}`;
    const raw = await this.db.get(stateKey);
    if (!raw) return null;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    payload.delayUntil = now;
    payload.lockUntil = now;
    payload.paused = false;
    await this.db.set(stateKey, JSON.stringify(payload));

    await this.queueStore.enqueue(job.queue, job.id, now);

    return { ...job, delayUntil: now, lockUntil: now, paused: false };
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

    this.hound.emit(job.name, job.data, {
      queue: job.queue,
      id: job.id,
      delay: new Date(),
    });

    return job;
  }

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
      console.error(`[hound] Failed to parse job from key: ${key}`);
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
  private readonly queueStore: QueueStore;

  constructor(
    private readonly db: RedisConnection,
    private readonly hound?: Hound<any>,
  ) {
    this.queueStore = new QueueStore(db);
  }

  /** Find all queues — reads the queue registry, no keyspace scan. */
  async find(): Promise<QueueRecord[]> {
    const names = await this.db.zrangebyscore(
      QUEUE_REGISTRY_KEY,
      '-inf',
      '+inf',
    );

    const records = await Promise.all(
      Array.from(new Set(names)).sort().map(async (name) => {
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
    // Indexes live outside the queues:* namespace — clear them explicitly.
    await this.db.del(...ALL_STATUSES.map((s) => indexKey(key, s)));
    await this.queueStore.deleteQueue(key);
  }

  async running(key: string): Promise<boolean> {
    const val = await this.db.get(`queues:${key}:paused`);
    return val !== 'true';
  }

  /** Per-status job counts for a queue. Deduplicates completed/failed by jobId. */
  async stats(key: string): Promise<QueueStats> {
    const counts = {
      waiting: 0,
      delayed: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    // Active indexes hold one member per job — ZCARD is the count.
    for (const status of ACTIVE_STATUSES) {
      counts[status] = await this.db.zcard(indexKey(key, status));
    }

    // Terminal indexes hold one member per execution — dedupe by jobId to
    // preserve the original "unique jobs" semantic. Member list only, no GETs.
    for (const status of TERMINAL_STATUSES) {
      const members = await this.db.zrangebyscore(
        indexKey(key, status),
        '-inf',
        '+inf',
      );
      const jobIds = new Set<string>();
      for (const m of members) {
        const parsed = parseStateKey(m);
        if (parsed) jobIds.add(parsed.jobId);
      }
      counts[status] = jobIds.size;
    }

    return {
      ...counts,
      total: counts.waiting + counts.delayed + counts.processing +
        counts.completed + counts.failed,
    };
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
}
