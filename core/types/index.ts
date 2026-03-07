/**
 * Remq types — single source of truth for public and internal types (emit, handlers, options, job data).
 *
 * @module
 */
import type { Redis } from 'ioredis';

// ─── Redis ────────────────────────────────────────────────────────────────────

/**
 * Abstraction over ioredis so internals aren't coupled to it directly.
 * Accepts a full Redis instance or any compatible client.
 */
export type RedisConnection = Redis;

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
  /** Job priority. Higher = processed first. Default 0. */
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
  /** Awaitable emit. Resolves when both state key and stream entry are written. */
  emitAsync: EmitAsyncFunction;
  /** WebSocket context. Only available when remq is started with expose option. */
  socket: JobSocketContext;
};

/** Async function that processes a job. Receives JobContext; use TData to type ctx.data. */
export type JobHandler<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> = (ctx: JobContext<TApp, TData>) => Promise<void>;

/** Options when registering a handler with `remq.on()`. */
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

/** Awaitable emit. Resolves with jobId after state key and stream entry are written. */
export type EmitAsyncFunction = (
  event: string,
  data?: unknown,
  options?: EmitOptions,
) => Promise<string>;

// ─── WebSocket ────────────────────────────────────────────────────────────────

/** Context for sending real-time updates to a WebSocket client tracking this job. */
export interface JobSocketContext {
  /** Send a progressive update to the WebSocket client tracking this job. */
  update: (data: unknown, progress?: number) => void;
}

// ─── Job data (internal stream payload) ──────────────────────────────────────

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
 * Full job payload — written to stream and state keys.
 * This is the shape of every message in Redis Streams.
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
  messageId?: string;
}

// ─── Message (internal consumer shape) ───────────────────────────────────────

/** Message as read from a Redis Stream — stream entry ID, stream key, and parsed job payload. */
export interface Message {
  /** Redis Stream entry ID e.g. '1234567890123-0'. */
  id: string;
  /** Stream key e.g. 'default-stream'. */
  streamKey: string;
  /** Parsed job payload (JobData). */
  data: JobData;
}

/** Context passed to the low-level stream handler; provides the message and ack/nack. */
export interface MessageContext {
  message: Message;
  /** ACK the message — removes from PEL. Call only after successful processing. */
  ack: () => Promise<void>;
  /** NACK — ACK the original (removes from PEL); caller decides retry/DLQ. */
  nack: (error: Error) => Promise<void>;
}

// ─── Consumer options (internal) ─────────────────────────────────────────────

/** XREADGROUP tuning: how many entries to read and how long to block. */
export interface ConsumerReadOptions {
  /** Max messages per XREADGROUP call. Default 200. */
  count?: number;
  /** BLOCK timeout in ms. Default 50. */
  blockMs?: number;
}

/** Options for the Consumer — streams, handler, and tuning. */
export interface ConsumerOptions {
  /** Stream keys to read from (e.g. ['default-stream']). */
  streams: string[];
  /** Redis connection used for streams. */
  streamdb: RedisConnection;
  /** Handler invoked for each message; must call ctx.ack() or ctx.nack(). */
  handler: (message: Message, ctx: MessageContext) => Promise<void>;
  /** Max concurrent message handlers. Default 1. */
  concurrency?: number;
  /** Consumer group name. Default 'processor'. */
  group?: string;
  /** Stable consumer ID (e.g. hostname-pid). Auto-generated if omitted. */
  consumerId?: string;
  /** Idle poll interval in ms when no messages. Default 3000. */
  pollIntervalMs?: number;
  /** XREADGROUP count and block. */
  read?: ConsumerReadOptions;
  /** Idle ms after which PEL entries are reclaimed (XCLAIM). Default 30000. */
  visibilityTimeoutMs?: number;
  /**
   * Priority map for stream ordering. Lower number = read first.
   * Streams not in the map are read last (Infinity priority).
   * Example: { 'payments-stream': 1, 'sync-stream': 2 }
   */
  streamPriority?: Record<string, number>;
}

// ─── Processor options (internal) ────────────────────────────────────────────

/** Retry policy: backoff and optional predicate for when to retry. */
export interface RetryConfig {
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoff?: 'fixed' | 'exponential';
  shouldRetry?: (error: Error, attempts: number) => boolean;
}

/** Dead-letter queue: stream key and optional filter for which failures to send. */
export interface DlqConfig {
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
  streamdb: RedisConnection;
  retry?: RetryConfig;
  dlq?: DlqConfig;
  debounce?: number | DebounceConfig;
  jobStateTtlSeconds?: number;
  maxLogsPerJob?: number;
  pollIntervalMs?: number;
  read?: ConsumerReadOptions;
  readCount?: number;
}

// ─── Remq public options ──────────────────────────────────────────────────────

/** Redis connection options — used to auto-create a connection or streamdb. */
export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  [key: string]: unknown;
}

/** Options for Remq.create() — db, optional streamdb/redis, ctx, concurrency, expose, processor. */
export interface JobManagerOptions<
  TApp extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Primary Redis connection — state keys, locks, pause flags. */
  db: RedisConnection;
  /**
   * Dedicated Redis connection for streams.
   * Prevents XREADGROUP BLOCK from stalling admin queries on db.
   * If omitted and redis is provided, auto-creates on db+1.
   * If neither provided, falls back to db (not recommended).
   */
  streamdb?: RedisConnection;
  /**
   * Redis connection config — used to auto-create streamdb on db+1.
   * Ignored if streamdb is provided explicitly.
   */
  redis?: RedisConfig;
  /** App-level context injected into every handler as ctx.* */
  ctx?: TApp;
  /** Max concurrent jobs across all queues. Default 1. */
  concurrency?: number;
  /** WebSocket gateway port for real-time job updates. */
  expose?: number;
  /** Enable debug logging. Default false. */
  debug?: boolean;
  processor?: {
    /** State key TTL in seconds. Required for production — prevents unbounded key growth. */
    jobStateTtlSeconds?: number;
    /** Max log entries per job blob. Self-cleaning. */
    maxLogsPerJob?: number;
    /** Poll interval in ms when stream is empty. Default 3000. */
    pollIntervalMs?: number;
    /** How long before a stuck processing job is reclaimed. Default 30000ms. */
    visibilityTimeoutMs?: number;
    read?: ConsumerReadOptions;
    /** @deprecated use read.count */
    readCount?: number;
    retry?: RetryConfig;
    dlq?: DlqConfig;
    /**
     * Stream read priority. Lower number = higher priority.
     * Example: { payments: 1, sync: 2 } — omit '-stream' suffix.
     */
    streamPriority?: Record<string, number>;
  };
}

// ─── processableMessage (internal alias) ─────────────────────────────────────

/** Internal alias used in unified message handler */
export type ProcessableMessage = Message;
