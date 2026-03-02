/**
 * Consumer module - minimal runtime engine for processing messages from Redis Streams
 *
 * This module provides:
 * - Consumer: Main consumer class for processing messages
 * - StreamReader: Handles Redis Stream reading with proper consumer group management
 * - ConcurrencyPool: Manages concurrent message processing
 *
 * The Consumer is a minimal "runtime engine" that only handles:
 * - Fetching messages from Redis Streams (new + stuck pending)
 * - Running handlers with concurrency control
 * - ACKing messages after successful processing
 * - Emitting runtime events (started, succeeded, failed)
 *
 * Policy concerns (retries, delays, cron, state management) are handled in higher layers.
 */

export { Consumer } from './consumer.ts';
export { StreamReader } from './stream-reader.ts';
export { ConcurrencyPool } from './concurrency-pool.ts';
export type {
  ConsumerEvents,
  Message,
  MessageContext,
  MessageHandler,
} from '../../types/message.ts';
export type { ConsumerOptions } from '../../types/consumer.ts';
