import type { RedisOptions } from 'ioredis';
import type { RedisConnection } from './index.ts';
import type { ProcessorOptions } from './processor.ts';

/**
 * Update function – send a progressive update to the client over WebSocket (when job was triggered via WS).
 */
export interface UpdateFunction {
  (
    data: unknown,
    progress?: number,
  ): void;
}

/**
 * Context for the current job's WebSocket (when job was triggered via WS).
 * Use ctx.socket.update() to stream progress to the client; no-op if no socket is tracking this job.
 */
export interface JobSocketContext {
  update: UpdateFunction;
}

/**
 * Options for emit()
 */
export interface EmitOptions {
  queue?: string; // default: 'default'
  id?: string;
  priority?: number;
  delay?: Date;
  retryCount?: number;
  retryDelayMs?: number;
  repeat?: { pattern: string };
  attempts?: number;
}

/**
 * Context passed to job handlers (job identity, payload, and capabilities).
 * App context is merged onto ctx via & TApp.
 */
export type JobContext<TApp extends Record<string, unknown>, TData> = {
  id: string;
  name: string;
  queue: string;
  status: string;
  retryCount: number;
  retriedAttempts: number;
  data: TData;
  logger: (msg: string | object) => Promise<void>;
  emit: EmitFunction;
  socket: JobSocketContext;
} & TApp;

/**
 * Handler function signature — single ctx argument with job + app context.
 */
export type JobHandler<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> = (
  ctx: JobContext<TApp, TData>,
) => Promise<void> | void;

/**
 * Emit function for triggering new Jobs
 */
export interface EmitFunction {
  (event: string, data?: unknown, options?: EmitOptions): string;
}

/**
 * Options for on(event, handler, options)
 */
export interface HandlerOptions {
  queue?: string;
  repeat?: { pattern: string };
  attempts?: number;
  debounce?: number;
}

/**
 * Job definition — event + handler + options. Use defineJob() to create.
 */
export interface JobDefinition<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
> {
  event: string;
  handler: JobHandler<TApp, TData>;
  options?: HandlerOptions;
}

/**
 * Typed factory for job definitions. Zero runtime overhead.
 */
export function defineJob<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
>(
  event: string,
  handler: JobHandler<TApp, TData>,
  options?: HandlerOptions,
): JobDefinition<TApp, TData> {
  return { event, handler, options };
}

/**
 * Job Manager options
 */
export interface JobManagerOptions<T = unknown> {
  /**
   * Redis connection for job storage
   */
  db: RedisConnection;

  /**
   * Expose port for the WebSocket gateway (enables real-time job updates).
   */
  expose?: number;

  /**
   * Context object passed to handlers
   */
  ctx?: T;

  /**
   * Number of concurrent Jobs to process
   * @default 1
   */
  concurrency?: number;

  /**
   * Optional separate Redis connection for streams.
   * If omitted, created automatically from redis config (db index + 1).
   */
  streamdb?: RedisConnection;

  /**
   * Redis connection config used to auto-create the stream connection.
   * Required if streamdb is not provided. Remq will create a dedicated
   * connection using db index + 1 for all stream operations (XREADGROUP BLOCK,
   * XADD, XACK). This prevents blocking admin queries on the main connection.
   */
  redis?: RedisOptions;

  /**
   * When true, log worker PID and job id when a job is picked up (e.g. for debugging).
   * @default false
   */
  debug?: boolean;

  /**
   * Processor options (retry, DLQ, debounce, maxLogsPerJob, stream trim, read count)
   */
  processor?: {
    retry?: ProcessorOptions['retry'];
    dlq?: ProcessorOptions['dlq'];
    debounce?: ProcessorOptions['debounce'];
    ignoreConfigErrors?: boolean;
    /**
     * Max number of log entries to keep per job. Trims oldest entries; keeps Redis self-cleaning.
     * @default undefined (no limit)
     */
    maxLogsPerJob?: number;
    /**
     * @deprecated No longer used. Stream is trimmed after ACK with XTRIM MINID ~ (only ACKed entries; unprocessed jobs never dropped).
     */
    streamMaxLen?: number;
    /**
     * Max messages to read per XREADGROUP batch. Lower this if message payloads are large to avoid process memory spikes.
     * @default 200
     */
    readCount?: number;
    /**
     * Stream read options (XREADGROUP). Use for throughput/low-latency tuning.
     */
    read?: {
      /**
       * Block time in ms when waiting for new messages. Lower = faster reaction, more Redis calls.
       * Very low values (e.g. 10–50ms) can overload Redis and CPU; use 100–1000 for throughput, default 1000 for production.
       * @default 1000
       */
      blockMs?: number;
      /**
       * Max messages per XREADGROUP batch. Same as readCount; use either.
       * @default 200
       */
      count?: number;
    };
    /**
     * TTL in seconds for all job state keys (waiting, delayed, processing, completed, failed). Keys expire after this many seconds; prevents unbounded Redis key growth.
     * @default undefined (no TTL; keys live forever)
     */
    jobStateTtlSeconds?: number;
    /**
     * Poll interval in ms when the queue is empty. Lower = faster pickup, more Redis calls.
     * Very low values (e.g. 10–50ms) can stress the server; use 100–500 for throughput, default 3000 for production.
     * @default 3000
     */
    pollIntervalMs?: number;
  };
}
