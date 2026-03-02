/**
 * Processor module - policy layer for message processing
 *
 * Handles:
 * - Retries with exponential backoff
 * - Delays (delayUntil)
 * - DLQ routing
 * - Debouncing
 *
 * Wraps Consumer and adds business logic policies
 */

export { Processor } from './processor.ts';
export { DebounceManager } from './debounce-manager.ts';
export type {
  DebounceConfig,
  DLQConfig,
  ProcessableMessage,
  ProcessorOptions,
  RetryConfig,
} from '../../types/processor.ts';
