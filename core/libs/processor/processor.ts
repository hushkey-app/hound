import { Consumer } from '../consumer/consumer.ts';
import type {
  ProcessableMessage,
  ProcessorOptions,
} from '../../types/processor.ts';
import type { Message, MessageContext } from '../../types/message.ts';
import { DebounceManager } from './debounce-manager.ts';
import type { RedisConnection } from '../../types/redis-client.ts';

/**
 * Processor layer - wraps Consumer with policy logic (retries, delays, DLQ, debouncing)
 *
 * Based on old worker's processTaskItem logic for handling delays
 */
export class Processor {
  private readonly consumer: Consumer;
  private readonly streamdb: RedisConnection;
  private readonly retryConfig: ProcessorOptions['retry'];
  private readonly dlqConfig: ProcessorOptions['dlq'];
  private readonly debounceManager?: DebounceManager;
  #debounceCleanupIntervalId?: ReturnType<typeof setInterval>;

  constructor(options: ProcessorOptions) {
    this.streamdb = options.streamdb;
    this.retryConfig = options.retry;
    this.dlqConfig = options.dlq;

    // Setup debounce if configured (DebounceManager expects seconds, not ms)
    if (options.debounce) {
      const debounceMs = typeof options.debounce === 'number'
        ? options.debounce
        : options.debounce.debounce ?? 0;
      const debounceSeconds = Math.ceil(debounceMs / 1000); // Convert ms to seconds
      const keyFn = typeof options.debounce === 'object'
        ? options.debounce.keyFn
        : undefined;
      this.debounceManager = new DebounceManager(debounceSeconds, keyFn);
    }

    // Create wrapped handler that applies processor policies
    const wrappedHandler = this.createWrappedHandler(options.consumer.handler);

    // Create consumer with wrapped handler
    this.consumer = new Consumer({
      ...options.consumer,
      handler: wrappedHandler,
    });
  }

  /**
   * Creates a wrapped handler that applies processor policies
   * Based on old worker's processTaskItem logic for delays
   */
  private createWrappedHandler(
    originalHandler: ProcessorOptions['consumer']['handler'],
  ): (message: Message, ctx: MessageContext) => Promise<void> {
    return async (message: Message, ctx: MessageContext) => {
      const processableMessage = message as unknown as ProcessableMessage;

      // 1. Check debounce
      if (this.debounceManager) {
        if (
          !this.debounceManager.shouldProcess(
            processableMessage as {
              id: string;
              data?: unknown;
              [key: string]: unknown;
            },
          )
        ) {
          await ctx.ack();
          return;
        }
      }

      // 2. Check delayUntil (like old worker processTaskItem line 165-209)
      const delayUntil = (processableMessage.data as any)?.delayUntil;
      if (delayUntil && typeof delayUntil === 'number') {
        const now = Date.now();
        if (delayUntil > now) {
          // Message is delayed - re-add to stream (like old worker line 198-207)
          await this.requeueMessage(processableMessage);
          await ctx.ack(); // Already ACKed, but keep for compatibility
          return;
        }
      }

      // 3. Execute handler with retry logic
      try {
        await originalHandler(message, ctx);

        if (this.debounceManager) {
          this.debounceManager.markProcessed(
            processableMessage as {
              id: string;
              data?: unknown;
              [key: string]: unknown;
            },
          );
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        await this.handleFailure(processableMessage, err, ctx);
      }
    };
  }

  /**
   * Handles message failure (retries or DLQ routing)
   */
  private async handleFailure(
    message: ProcessableMessage,
    error: Error,
    ctx: MessageContext,
  ): Promise<void> {
    const taskDataAny = message.data as any;
    const retryCount = taskDataAny.retryCount ?? 0;
    const maxRetries = this.retryConfig?.maxRetries ?? 0;
    const retryDelayMs = taskDataAny.retryDelayMs ??
      this.retryConfig?.retryDelayMs ?? 1000;

    // Check if should retry
    const shouldRetry = retryCount > 0 && maxRetries > 0;
    const attempts = (taskDataAny.retriedAttempts || 0) + 1;

    if (
      shouldRetry &&
      (!this.retryConfig?.shouldRetry ||
        this.retryConfig.shouldRetry(error, attempts))
    ) {
      // Re-queue with retry
      const retryMessage: ProcessableMessage = {
        ...message,
        data: {
          ...message.data,
          retryCount: retryCount - 1,
          retriedAttempts: (taskDataAny.retriedAttempts || 0) + 1,
          delayUntil: Date.now() + retryDelayMs,
        },
      };

      await this.requeueMessage(retryMessage);
      await ctx.ack();
      return;
    }

    // Send to DLQ if configured
    if (this.dlqConfig?.streamKey) {
      const dlqAttempts = taskDataAny.retriedAttempts || 0;
      const shouldSendToDLQ = this.dlqConfig.shouldSendToDLQ;
      if (!shouldSendToDLQ || shouldSendToDLQ(message, error, dlqAttempts)) {
        await this.sendToDLQ(message, error, dlqAttempts);
      }
    }

    await ctx.ack();
  }

  /**
   * Add entry to stream. No MAXLEN at add time — consumer trims after ACK with MINID.
   */
  async #xadd(streamKey: string, dataJson: string): Promise<string | null> {
    return await this.streamdb.xadd(streamKey, '*', 'data', dataJson);
  }

  /**
   * Re-queues a message to the stream (like old worker line 198-207)
   * Preserves original timestamp
   */
  private async requeueMessage(message: ProcessableMessage): Promise<void> {
    const streamKey = message.streamKey;
    const messageDataAny = message.data as any;

    // Preserve original timestamp (like old worker line 203-206)
    const originalTimestamp = messageDataAny.timestamp || Date.now();
    const messageData = {
      ...message.data,
      timestamp: originalTimestamp,
    };

    await this.#xadd(streamKey, JSON.stringify(messageData));
  }

  /**
   * Sends a message to the Dead Letter Queue
   */
  private async sendToDLQ(
    message: ProcessableMessage,
    error: Error,
    attempts: number,
  ): Promise<void> {
    const dlqStreamKey = this.dlqConfig?.streamKey || 'dlq-stream';

    const dlqMessage = {
      ...message.data,
      dlqReason: error.message,
      dlqTimestamp: Date.now(),
      attempts,
    };

    await this.#xadd(dlqStreamKey, JSON.stringify(dlqMessage));
  }

  /**
   * Starts processing
   */
  async start(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.debounceManager) {
      this.#debounceCleanupIntervalId = setInterval(() => {
        this.debounceManager?.cleanup();
      }, 5 * 60 * 1000); // every 5 minutes
    }
    await this.consumer.start(options);
  }

  /**
   * Stops processing
   */
  stop(): void {
    if (this.#debounceCleanupIntervalId != null) {
      clearInterval(this.#debounceCleanupIntervalId);
      this.#debounceCleanupIntervalId = undefined;
    }
    this.consumer.stop();
  }

  /**
   * Waits for all active tasks to complete
   */
  async waitForActiveJobs(): Promise<void> {
    await this.consumer.waitForActiveJobs();
  }

  /**
   * Cleanup debounce manager
   */
  cleanup(): void {
    if (this.debounceManager) {
      this.debounceManager.cleanup();
    }
  }
}
