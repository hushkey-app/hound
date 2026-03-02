import type { RedisConnection } from './index.ts';
import type { ProcessorOptions } from './processor.ts';

/**
 * Update function – send a progressive update to the client over WebSocket (when task was triggered via WS).
 */
export interface UpdateFunction {
  (
    data: unknown,
    progress?: number,
  ): void;
}

/**
 * Context for the current task's WebSocket (when task was triggered via WS).
 * Use ctx.socket.update() to stream progress to the client; no-op if no socket is tracking this task.
 */
export interface TaskSocketContext {
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
 * Context passed to task handlers (job identity, payload, and capabilities).
 * App context is merged onto ctx via & TApp.
 */
export interface TaskContext<TApp extends Record<string, unknown> = Record<string, unknown>, TData = unknown> {
  id: string;
  name: string;
  queue: string;
  status: string;
  retryCount: number;
  retriedAttempts: number;
  data: TData;
  logger: (msg: string | object) => Promise<void>;
  emit: EmitFunction;
  socket: TaskSocketContext;
}

/**
 * Handler function signature — single ctx argument with job + app context.
 */
export type TaskHandler<TApp extends Record<string, unknown> = Record<string, unknown>, TData = unknown> = (
  ctx: TaskContext<TApp, TData>,
) => Promise<void> | void;

/**
 * Emit function for triggering new tasks
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
 * Task Manager options
 */
export interface TaskManagerOptions<T = unknown> {
  /**
   * Redis connection for task storage
   */
  db: RedisConnection;

  /**
   * Expose port for the WebSocket gateway (enables real-time task updates).
   */
  expose?: number;

  /**
   * Context object passed to handlers
   */
  ctx?: T;

  /**
   * Number of concurrent tasks to process
   * @default 1
   */
  concurrency?: number;

  /**
   * Optional separate Redis connection for streams (for performance)
   * If not provided, uses db connection
   */
  streamdb?: RedisConnection;

  /**
   * When true, log worker PID and job id when a task is picked up (e.g. for debugging).
   * @default false
   */
  debug?: boolean;

  /**
   * Processor options (retry, DLQ, debounce, maxLogsPerTask, stream trim, read count)
   */
  processor?: {
    retry?: ProcessorOptions['retry'];
    dlq?: ProcessorOptions['dlq'];
    debounce?: ProcessorOptions['debounce'];
    ignoreConfigErrors?: boolean;
    /**
     * Max number of log entries to keep per task. Trims oldest entries; keeps Redis self-cleaning.
     * @default undefined (no limit)
     */
    maxLogsPerTask?: number;
    /**
     * Max stream length per queue stream. After each read+ACK, trims the stream to this length (approximate).
     * Prevents unbounded stream growth and memory blowup. Set to e.g. 10000 for production.
     * @default undefined (no trim; stream grows until Redis eviction or manual trim)
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

