/**
 * Processor — policy layer around Consumer (delay, retry, DLQ, ACK/NACK).
 *
 * @module
 */
import { Consumer } from '../consumer/consumer.ts';
import type {
  Message,
  MessageContext,
  ProcessableMessage,
  ProcessorOptions,
} from '../../types/index.ts';

/** Max retry delay for exponential backoff — 1 hour */
const MAX_RETRY_DELAY_MS = 3_600_000;

/**
 * Policy layer wrapping Consumer. Owns delay (sleep then requeue), retry (backoff), DLQ, ACK/NACK.
 */
export class Processor {
  private readonly consumer: Consumer;
  private readonly streamdb: ProcessorOptions['streamdb'];
  private readonly retryConfig: ProcessorOptions['retry'];
  private readonly dlqConfig: ProcessorOptions['dlq'];
  private readonly jobStateTtlSeconds?: number;
  private readonly maxLogsPerJob?: number;

  /**
   * Create a processor with consumer config, retry, and optional DLQ.
   * @param options - Consumer streams/handler, streamdb, and optional retry/DLQ/state TTL
   */
  constructor(options: ProcessorOptions) {
    this.streamdb = options.streamdb;
    this.retryConfig = options.retry;
    this.dlqConfig = options.dlq;
    this.jobStateTtlSeconds = options.jobStateTtlSeconds;
    this.maxLogsPerJob = options.maxLogsPerJob;

    const wrappedHandler = this.#createWrappedHandler(options.consumer.handler);

    this.consumer = new Consumer({
      ...options.consumer,
      handler: wrappedHandler,
    });
  }

  /**
   * Creates the wrapped handler that applies all processor policies.
   *
   * Order of operations:
   * 1. Check delayUntil — sleep then requeue if not yet time
   * 2. Execute handler
   * 3. On success — ctx.ack()
   * 4. On failure — retry or DLQ, then ctx.nack()
   */
  #createWrappedHandler(
    originalHandler: ProcessorOptions['consumer']['handler'],
  ): (message: Message, ctx: MessageContext) => Promise<void> {
    return async (message: Message, ctx: MessageContext) => {
      const msg = message as unknown as ProcessableMessage;
      const jobData = msg.data as any;

      // ── 1. Delay check ────────────────────────────────────────────────────
      const delayUntil = jobData?.delayUntil;
      if (delayUntil && typeof delayUntil === 'number') {
        const now = Date.now();
        if (delayUntil > now) {
          // Sleep up to 30s then requeue — never tight spin
          const waitMs = Math.min(delayUntil - now, 30_000);
          await this.#delay(waitMs);

          if (Date.now() < delayUntil) {
            // Still not time — requeue and ACK original
            // No state key write — delay is transient
            await this.#requeueDelay(msg);
            await ctx.ack();
            return;
          }
          // Past delayUntil after sleep — fall through to execute
        }
      }

      // ── 2. Execute handler ────────────────────────────────────────────────
      try {
        await originalHandler(message, ctx);

        // ── 3. Success — ACK removes from PEL ────────────────────────────
        await ctx.ack();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        await this.#handleFailure(msg, err, ctx);
      }
    };
  }

  /**
   * Handle job failure — retry, DLQ, or final failure.
   *
   * Flow:
   * 1. Determine if should retry
   * 2. If retry — requeue with decremented retryCount + backoff delay, ACK original
   * 3. If final failure — send to DLQ if configured, NACK original
   */
  async #handleFailure(
    message: ProcessableMessage,
    error: Error,
    ctx: MessageContext,
  ): Promise<void> {
    const jobData = message.data as any;
    const retryCount = jobData.retryCount ?? 0;
    const retriedAttempts = jobData.retriedAttempts ?? 0;
    const retryDelayMs = jobData.retryDelayMs ??
      this.retryConfig?.retryDelayMs ?? 1000;
    const retryBackoff = jobData.retryBackoff ??
      this.retryConfig?.retryBackoff ?? 'fixed';

    const isConfigError = error.message.includes('No handler found') ||
      error.message.includes('No handlers registered') ||
      error.message.includes('is undefined');

    const willRetry = retryCount > 0 &&
      !isConfigError &&
      (!this.retryConfig?.shouldRetry ||
        this.retryConfig.shouldRetry(error, retriedAttempts + 1));

    if (willRetry) {
      // Calculate backoff delay
      const backoffMs = retryBackoff === 'exponential'
        ? Math.min(
          retryDelayMs * Math.pow(2, retriedAttempts),
          MAX_RETRY_DELAY_MS,
        )
        : retryDelayMs;

      const retryJob = {
        ...jobData,
        delayUntil: Date.now() + backoffMs,
        lockUntil: Date.now(),
        retryCount: retryCount - 1,
        retriedAttempts: retriedAttempts + 1,
        logs: [
          ...(jobData.logs || []),
          {
            message: `retrying — attempt ${
              retriedAttempts + 1
            }, delay ${backoffMs}ms`,
            timestamp: Date.now(),
          },
        ],
      };
      this.#trimLogs(retryJob);

      // Requeue retry entry, ACK original — order matters
      await this.#xadd(message.streamKey, JSON.stringify(retryJob));
      await ctx.ack();
      return;
    }

    // ── Final failure ─────────────────────────────────────────────────────

    // Send to DLQ if configured
    if (this.dlqConfig?.streamKey) {
      const attempts = retriedAttempts;
      const shouldSend = this.dlqConfig.shouldSendToDLQ;
      if (!shouldSend || shouldSend(message, error, attempts)) {
        await this.#sendToDLQ(message, error, attempts);
      }
    }

    // NACK — ACKs original, removes from PEL
    // State key (failed:execId) is written by mod.ts processJob
    await ctx.nack(error);
  }

  /**
   * Requeue a delayed message back to the stream.
   * Preserves original timestamp and delayUntil — no state key write.
   */
  async #requeueDelay(message: ProcessableMessage): Promise<void> {
    const jobData = message.data as any;
    const messageData = {
      ...jobData,
      timestamp: jobData.timestamp || Date.now(),
    };
    await this.#xadd(message.streamKey, JSON.stringify(messageData));
  }

  /**
   * Send a message to the Dead Letter Queue stream.
   */
  async #sendToDLQ(
    message: ProcessableMessage,
    error: Error,
    attempts: number,
  ): Promise<void> {
    const dlqStreamKey = this.dlqConfig?.streamKey || 'dlq-stream';
    const dlqMessage = {
      ...message.data,
      dlqReason: error.message,
      dlqStack: error.stack,
      dlqTimestamp: Date.now(),
      attempts,
    };
    await this.#xadd(dlqStreamKey, JSON.stringify(dlqMessage));
  }

  /**
   * Write to stream — no MAXLEN at emit time.
   * Trimming is handled post-ACK in stream-reader.ts using MINID.
   */
  async #xadd(streamKey: string, dataJson: string): Promise<string | null> {
    return await this.streamdb.xadd(streamKey, '*', 'data', dataJson);
  }

  /**
   * Trim logs array to maxLogsPerJob if configured.
   * Removes oldest entries first.
   */
  #trimLogs(jobEntry: { logs?: unknown[] }): void {
    const max = this.maxLogsPerJob;
    if (
      typeof max !== 'number' ||
      max <= 0 ||
      !jobEntry.logs?.length ||
      jobEntry.logs.length <= max
    ) return;
    jobEntry.logs.splice(0, jobEntry.logs.length - max);
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start processing.
   */
  async start(options?: { signal?: AbortSignal }): Promise<void> {
    await this.consumer.start(options);
  }

  /**
   * Stop processing.
   */
  stop(): void {
    this.consumer.stop();
  }

  /**
   * Wait for all in-flight jobs to complete.
   */
  async waitForActiveJobs(): Promise<void> {
    await this.consumer.waitForActiveJobs();
  }
}
