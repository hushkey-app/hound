/**
 * Core message types for the consumer
 * These represent the minimal data structures needed for message processing
 */

/**
 * Raw message from Redis Stream
 */
export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

/**
 * Parsed message ready for processing
 */
export interface Message {
  id: string;
  streamKey: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Message with processing context
 */
export interface MessageContext {
  message: Message;
  ack: () => Promise<void>;
  nack: (error: Error) => Promise<void>;
}

/**
 * Message handler function
 */
export type MessageHandler = (
  message: Message,
  ctx: MessageContext,
) => Promise<void>;

/**
 * Consumer event types
 */
export interface ConsumerEvents {
  message: CustomEvent<{ message: Message }>;
  started: CustomEvent<{ message: Message }>;
  succeeded: CustomEvent<{ message: Message; duration: number }>;
  failed: CustomEvent<{ message: Message; error: Error; duration: number }>;
  error: CustomEvent<{ error: Error }>;
}
