/**
 * Hound types — single source of truth for public and internal types (emit, handlers, options, job data).
 *
 * @module
 */

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Minimal storage interface — implemented by ioredis Redis and InMemoryStorage.
 * All hound internals program against this interface, never against ioredis directly.
 */
export interface StorageClient {
  get(key: string): Promise<string | null>;
  // deno-lint-ignore no-explicit-any
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  zscore(key: string, member: string): Promise<string | null>;
  // deno-lint-ignore no-explicit-any
  eval(script: string, numkeys: number, ...args: any[]): Promise<any>;
  scan(
    cursor: string | number,
    matchFlag: 'MATCH',
    pattern: string,
    countFlag: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  // deno-lint-ignore no-explicit-any
  pipeline(): any;
  disconnect(): void;
}

/** Accepts ioredis Redis or InMemoryStorage. */
export type RedisConnection = StorageClient;

// ─── Emit ────────────────────────────────────────────────────────────────────

/** Options for repeating a job on a schedule (cron pattern). */
export interface RepeatOptions {
  /** Cron expression e.g. '* * * * *' (minute, hour, day of month, month, day of week). */
  pattern: string;
}

/** Options for `emit()` and `emitAsync()`. All fields optional. */
export interface EmitOptions {
  /** Target queue. Defaults to 'default'. */
  queue?: string;
  /** Explicit job ID. If omitted, derived from event + payload via FNV-1a. */
  id?: string;
  /** Delay until this date before processing. */
  delay?: Date;
  /** Cron repeat pattern. Makes the job self-scheduling. */
  repeat?: RepeatOptions;
  /** Number of retry attempts on failure. */
  attempts?: number;
  /** Retry count (alias for attempts, takes precedence). */
  retryCount?: number;
  /** Delay between retries in ms. Default 1000. */
  retryDelayMs?: number;
  /** Retry backoff strategy. Default 'fixed'. */
  retryBackoff?: 'fixed' | 'exponential';
  /** Job priority. Higher number = processed first (lower ZADD score). Default 0. */
  priority?: number;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Context passed to every job handler.
 * TApp = app-level context (db, services, etc.)
 * TData = job payload shape for type-safe ctx.data
 */
export type JobContext<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> = TApp & {
  /** Unique job ID (FNV-1a hash of event + payload, stable across retries). */
  id: string;
  /** Event name e.g. 'property.sync'. */
  name: string;
  /** Queue name. */
  queue: string;
  /** Current status — always 'processing' inside handler. */
  status: string;
  /** Unix ms timestamp when the job was emitted (enqueuedAt). Use with Date.now() for e2e latency. */
  enqueuedAt: number;
  /** Remaining retry attempts. */
  retryCount: number;
  /** How many times this job has been retried so far. */
  retriedAttempts: number;
  /** Job payload — typed via TData. */
  data: TData;
  /** Sync logger — appends to in-memory job log blob. No Redis write. */
  logger: (message: string | object) => void;
  /** Fire-and-forget emit. Returns jobId. */
  emit: EmitFunction;
  /** Awaitable emit. Resolves when state key and queue entry are written. */
  emitAsync: EmitAsyncFunction;
  /** Emit and wait for the job to complete. Rejects on failure or timeout. */
  emitAndWait: EmitAndWaitFunction;
  /** WebSocket context. Only available when hound is started with expose option. */
  socket: JobSocketContext;
};

/** Async function that processes a job. Receives JobContext; use TData to type ctx.data. */
export type JobHandler<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> = (ctx: JobContext<TApp, TData>) => Promise<void>;

/**
 * Middleware function — wraps every job handler execution.
 * Call `next()` to continue the chain; throwing skips it and fails the job.
 *
 * @example
 * hound.use(async (ctx, next) => {
 *   const start = Date.now();
 *   await next();
 *   metrics.record(ctx.name, Date.now() - start);
 * });
 */
export type MiddlewareFn<
  TApp extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: JobContext<TApp, unknown>, next: () => Promise<void>) => Promise<void>;

/** Options when registering a handler with `hound.on()`. */
export interface HandlerOptions {
  /** Target queue. Defaults to 'default'. */
  queue?: string;
  /** Cron repeat pattern. */
  repeat?: RepeatOptions;
  /** Max retry attempts. */
  attempts?: number;
  /** Debounce window in ms. */
  debounce?: number;
  /** Retry backoff strategy. */
  retryBackoff?: 'fixed' | 'exponential';
  /**
   * Max concurrent executions of this handler. Overrides the global Hound concurrency
   * for this specific job type. Use for beefy jobs that should not saturate the worker pool.
   * Example: { concurrency: 2 } — at most 2 instances run in parallel.
   */
  concurrency?: number;
  /**
   * Per-handler execution timeout in ms. If the handler (including middleware) does not
   * resolve within this window, the job fails with a timeout error and the normal retry
   * policy applies. Useful for handlers that call external APIs or do I/O with no built-in timeout.
   *
   * @example
   * hound.on('payment.charge', handler, { timeoutMs: 8_000 });
   */
  timeoutMs?: number;
}

/**
 * Typed job definition — use with defineJob() for full type safety on ctx.data.
 */
export interface JobDefinition<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> {
  /** Event name (e.g. 'user.sync'). */
  event: string;
  /** Handler function; receives JobContext with typed data. */
  handler: JobHandler<TApp, TData>;
  /** Optional queue, repeat, attempts, debounce. */
  options?: HandlerOptions;
}

// ─── Emit functions ───────────────────────────────────────────────────────────

/** Fire-and-forget emit. Enqueues the job and returns jobId immediately. */
export type EmitFunction = (
  event: string,
  data?: unknown,
  options?: EmitOptions,
) => string;

/** Awaitable emit. Resolves with jobId after state key and queue entry are written. */
export type EmitAsyncFunction = (
  event: string,
  data?: unknown,
  options?: EmitOptions,
) => Promise<string>;

/** Awaitable emit that resolves with jobId once the job completes, or rejects on failure/timeout. */
export type EmitAndWaitFunction = (
  event: string,
  data?: unknown,
  options?: EmitOptions & { timeoutMs?: number },
) => Promise<string>;

/** Options for hound.benchmark(). */
export interface BenchmarkOptions {
  /** Total number of jobs to run. */
  totalJobs: number;
  /** Simulated work delay per job in ms. Defaults to 0. */
  simulatedWorkMs?: number;
  /** Per-job timeout in ms. Defaults to 30_000. */
  timeoutMs?: number;
}

/** Result returned by hound.benchmark(). */
export interface BenchmarkResult {
  totalJobs: number;
  durationMs: number;
  /** Jobs per second. */
  throughput: number;
  latency: {
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
    avg: number;
  };
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

/** Context for sending real-time updates to a WebSocket client tracking this job. */
export interface JobSocketContext {
  /** Send a progressive update to the WebSocket client tracking this job. */
  update: (data: unknown, progress?: number) => void;
}

// ─── Job data (internal queue payload) ───────────────────────────────────────

/** Single log entry attached to a job (in-memory until job state is persisted). */
export interface JobLog {
  message: string;
  timestamp: number;
}

/** Error record attached to a job (e.g. on failure or retry). */
export interface JobError {
  message: string;
  stack?: string;
  timestamp: number;
}

/** Job identity and payload — name, queue, data, and the emit options used to create it. */
export interface JobState<TData = unknown> {
  name: string;
  queue: string;
  data: TData;
  options: EmitOptions;
}

/**
 * Full job payload — written to state keys and the sorted-set queue.
 */
export interface JobData<TData = unknown> {
  id: string;
  state: JobState<TData>;
  status: 'waiting' | 'delayed' | 'processing' | 'completed' | 'failed';
  delayUntil: number;
  lockUntil: number;
  priority: number;
  retryCount: number;
  retryDelayMs: number;
  retryBackoff: 'fixed' | 'exponential';
  retriedAttempts: number;
  repeatCount: number;
  repeatDelayMs: number;
  logs: JobLog[];
  errors: JobError[];
  timestamp: number;
  lastRun?: number;
}

// ─── Message (internal consumer shape) ───────────────────────────────────────

/** Message as claimed from the sorted-set queue. */
export interface Message {
  /** Job ID — stable across retries. */
  id: string;
  /** Queue name e.g. 'default'. */
  queue: string;
  /** Parsed job payload (JobData). */
  data: JobData;
}

/** Context passed to the low-level queue handler; provides the message and ack/nack. */
export interface MessageContext {
  message: Message;
  /** ACK — removes from processing set. Call after successful processing. */
  ack: () => Promise<void>;
  /** NACK — removes from processing set; caller handles retry/DLQ. */
  nack: (error: Error) => Promise<void>;
}

// ─── Consumer options (internal) ─────────────────────────────────────────────

/** Options for the Consumer. */
export interface ConsumerOptions {
  /** Queue names to poll (e.g. ['default', 'payments']). */
  queues: string[];
  /** Redis connection. */
  db: RedisConnection;
  /** Handler invoked for each message; must call ctx.ack() or ctx.nack(). */
  handler: (message: Message, ctx: MessageContext) => Promise<void>;
  /** Max concurrent message handlers. Default 1. */
  concurrency?: number;
  /** Idle poll interval in ms when no messages. Default 3000. */
  pollIntervalMs?: number;
  /** Max messages to claim per poll cycle. Default 200. */
  claimCount?: number;
  /** Idle ms after which processing jobs are reclaimed by the Reaper. Default 30000. */
  visibilityTimeoutMs?: number;
  /**
   * Priority map for queue ordering. Lower number = polled first.
   * Queues not in the map are polled last.
   * Example: { payments: 1, sync: 2 }
   */
  queuePriority?: Record<string, number>;
}

// ─── Processor options (internal) ────────────────────────────────────────────

/** Retry policy: backoff and optional predicate for when to retry. */
export interface RetryConfig {
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoff?: 'fixed' | 'exponential';
  shouldRetry?: (error: Error, attempts: number) => boolean;
}

/** Dead-letter queue: queue name and optional filter for which failures to send. */
export interface DlqConfig {
  /** Queue name for dead-letter jobs (e.g. 'dlq'). */
  streamKey?: string;
  shouldSendToDLQ?: (
    message: Message,
    error: Error,
    attempts: number,
  ) => boolean;
}

/** Debounce configuration: window in ms and optional key function. */
export interface DebounceConfig {
  debounce: number;
  keyFn?: (message: Message) => string;
}

/** Options for the Processor — consumer config plus retry, DLQ, and state TTL. */
export interface ProcessorOptions {
  consumer: ConsumerOptions;
  db: RedisConnection;
  retry?: RetryConfig;
  dlq?: DlqConfig;
  debounce?: number | DebounceConfig;
  jobStateTtlSeconds?: number;
  maxLogsPerJob?: number;
  pollIntervalMs?: number;
  claimCount?: number;
}

// ─── Hound public options ──────────────────────────────────────────────────────

/** Options for Hound.create(). */
export interface HoundOptions<
  TApp extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Redis connection — state keys, queue sorted sets, locks, pause flags. */
  db: RedisConnection;
  /** App-level context injected into every handler as ctx.* */
  ctx?: TApp;
  /** Max concurrent jobs across all queues. Default 1. */
  concurrency?: number;
  /**
   * Pass `import.meta` from your plugin file so Hound can resolve `jobDirs` relative to it.
   * Required when `jobDirs` is set.
   */
  importMeta?: { url: string };
  /**
   * Directories containing `*.job.ts` files to auto-register on `start()`.
   * Resolved relative to `importMeta.url`. Also used by `deno task codegen`.
   *
   * Naming convention: the queue name is derived from the filename stem before `.job.ts`.
   * Example: `payments.job.ts` → queue `"payments"`, `sync-daily.job.ts` → queue `"sync-daily"`.
   *
   * All matching files in each directory are imported automatically — no manual registration needed.
   *
   * @example
   * jobDirs: ['../jobs', '../scheduled']
   * // Scans both dirs and registers every *.job.ts found.
   */
  jobDirs?: string[];
  /**
   * Output directory for the generated HoundJobMap type file (codegen only).
   */
  outputDir?: string;
  /**
   * Optional Bearer token. When set, the HTTP gateway requires
   * `Authorization: Bearer <token>` on all requests.
   */
  auth?: string;
  processor?: {
    /** State key TTL in seconds. Required for production — prevents unbounded key growth. */
    jobStateTtlSeconds?: number;
    /** Max log entries per job blob. Self-cleaning. */
    maxLogsPerJob?: number;
    /** Poll interval in ms when queue is empty. Default 3000. */
    pollIntervalMs?: number;
    /** How long before a stuck processing job is reclaimed by the Reaper. Default 30000ms. */
    visibilityTimeoutMs?: number;
    /** Max messages to claim per poll cycle. Default 200. */
    claimCount?: number;
    retry?: RetryConfig;
    dlq?: DlqConfig;
    /**
     * Queue poll priority. Lower number = higher priority (polled first).
     * Example: { payments: 1, sync: 2 }
     */
    queuePriority?: Record<string, number>;
  };
}

// ─── processableMessage (internal alias) ─────────────────────────────────────

/** Internal alias used in unified message handler */
export type ProcessableMessage = Message;
