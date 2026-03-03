import type { MessageHandler } from './message.ts';
import type { RedisConnection } from './index.ts';

/**
 * Consumer options
 */
export interface ConsumerOptions {
  pollIntervalMs?: number;
  /**
   * Number of messages to process concurrently
   * @default 1
   */
  concurrency?: number;

  /**
   * Consumer group name
   * @default 'processor'
   */
  group?: string;

  /**
   * Stable consumer ID (should be unique per instance)
   * If not provided, will generate one based on hostname and pid
   */
  consumerId?: string;

  /**
   * Streams to consume from
   */
  streams: string[];

  /**
   * Redis connection for reading streams
   */
  streamdb: RedisConnection;

  /**
   * Message handler
   */
  handler: MessageHandler;

  /**
   * Options for claiming pending messages
   */
  claim?: {
    /**
     * Minimum idle time in milliseconds before claiming
     * @default 1000 (1 second)
     */
    minIdleMs?: number;
    /**
     * Maximum number of messages to claim at once
     * @default 100
     */
    count?: number;
  };

  /**
   * Options for reading new messages
   */
  read?: {
    /**
     * Block time in milliseconds when no messages available
     * @default 5000
     */
    blockMs?: number;
    /**
     * Maximum number of messages to read at once. Lower for large payloads to avoid process memory spikes.
     * @default 200
     */
    count?: number;
  };

  /**
   * @deprecated No longer used. Stream is trimmed after ACK with XTRIM MINID ~ (only ACKed entries; unprocessed jobs never dropped).
   */
  streamMaxLen?: number;
}
