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
 * Handler function signature
 */
export interface TaskHandler<T = unknown, D = unknown> {
  (
    task: {
      name: string;
      queue: string;
      data?: D;
      logger?: (message: string | object) => Promise<void>;
    },
    ctx: T & { emit: EmitFunction; socket: TaskSocketContext },
  ): Promise<void> | void;
}

/**
 * Emit function for triggering new tasks
 */
export interface EmitFunction {
  (args: {
    event: string;
    queue?: string;
    data?: unknown;
    options?: {
      id?: string;
      priority?: number;
      delayUntil?: Date;
      retryCount?: number;
      retryDelayMs?: number;
      repeat?: {
        pattern: string;
      };
      attempts?: number;
      debounce?: number;
    };
  }): string;
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
  };
}

/**
 * Handler registration options
 */
export interface RegisterHandlerOptions<T = unknown, D = unknown> {
  /**
   * Handler function
   */
  handler: TaskHandler<T, D>;

  /**
   * Event/Task name
   */
  event: string;

  /**
   * Queue name (defaults to 'default')
   */
  queue?: string;

  /**
   * Task options (for cron/repeatable tasks)
   */
  options?: {
    repeat?: {
      pattern: string;
    };
    attempts?: number;
    debounce?: number; // Debounce window in milliseconds
    [key: string]: unknown;
  };
}
