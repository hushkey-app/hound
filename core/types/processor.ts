import type { ConsumerOptions } from './consumer.ts';
import type { RedisConnection } from './index.ts';

/**
 * Message data structure expected by processor
 * Extends base Message with retry/delay metadata
 */
export interface ProcessableMessage {
  id: string;
  streamKey: string;
  data: {
    id?: string;
    state?: {
      name?: string;
      queue?: string;
      data?: unknown;
    };
    delayUntil?: number;
    retryCount?: number;
    retryDelayMs?: number;
    retriedAttempts?: number;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Debounce configuration
 */
export interface DebounceConfig {
  /**
   * Debounce window in milliseconds (prevents processing same message within window)
   * @default undefined (no debouncing)
   */
  debounce?: number;

  /**
   * Function to generate debounce key from message
   * If not provided, uses message.id as key
   */
  keyFn?: (
    message: { id: string; data?: unknown; [key: string]: unknown },
  ) => string;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /**
   * Maximum number of retries
   * @default 0 (no retries)
   */
  maxRetries?: number;

  /**
   * Delay between retries in milliseconds
   * @default 1000
   */
  retryDelayMs?: number;

  /**
   * Exponential backoff multiplier for retry delays
   * @default 1 (linear backoff)
   */
  backoffMultiplier?: number;

  /**
   * Function to determine if error should be retried
   * @default retries all errors except configuration errors
   */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * DLQ (Dead Letter Queue) configuration
 */
export interface DLQConfig {
  /**
   * Stream key for DLQ
   * If not provided, DLQ is disabled
   */
  streamKey?: string;

  /**
   * Function to determine if message should go to DLQ
   * Only evaluated when streamKey is set
   * @default sends to DLQ when retries are exhausted
   */
  shouldSendToDLQ?: (
    message: ProcessableMessage,
    error: Error,
    attempts: number,
  ) => boolean;
}

/**
 * Processor options
 */
export interface ProcessorOptions {
  /**
   * Consumer options (streams, handler, etc.)
   */
  consumer: ConsumerOptions;

  /**
   * Redis connection for re-queuing messages and DLQ
   */
  streamdb: RedisConnection;

  /**
   * Retry configuration
   */
  retry?: RetryConfig;

  /**
   * DLQ configuration
   */
  dlq?: DLQConfig;

  /**
   * Debounce window in milliseconds (prevents processing same message within window).
   * Can be a number (e.g. 60_000 for 1 minute) or DebounceConfig object (advanced API).
   * @default undefined (no debouncing)
   */
  debounce?: number | DebounceConfig;

  /**
   * Whether to ignore configuration errors (don't retry/send to DLQ)
   * @default true
   */
  ignoreConfigErrors?: boolean;

  /**
   * @deprecated No longer used. Stream is trimmed after ACK with XTRIM MINID ~ (only ACKed entries; unprocessed jobs never dropped).
   */
  streamMaxLen?: number;

  /**
   * Max messages to read per XREADGROUP batch. Lower for large payloads to avoid process memory spikes.
   * @default 200
   */
  readCount?: number;

  /**
   * TTL in seconds for all job state keys (waiting, delayed, processing, completed, failed). Prevents unbounded Redis key growth.
   * @default undefined (no TTL)
   */
  jobStateTtlSeconds?: number;
}
