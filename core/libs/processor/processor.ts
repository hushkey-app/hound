/**
 * Processor — policy layer around Consumer (retry, ACK/NACK).
 *
 * Delay is no longer handled here — ZADD score IS the delay. Jobs with
 * delayUntil in the future sit in the sorted set and won't be claimed
 * by Consumer until their time arrives.
 *
 * @module
 */
import { Consumer } from '../consumer/consumer.ts';
import { QueueStore } from '../consumer/queue-store.ts';
import type {
  Message,
  MessageContext,
  ProcessorOptions,
  RedisConnection,
} from '../../types/index.ts';

const MAX_RETRY_DELAY_MS = 3_600_000;

export class Processor {
  private readonly consumer: Consumer;
  private readonly db: RedisConnection;
  private readonly queueStore: QueueStore;
  private readonly retryConfig: ProcessorOptions['retry'];
  private readonly jobStateTtlSeconds?: number;
  private readonly maxLogsPerJob?: number;

  constructor(options: ProcessorOptions) {
    this.db = options.db;
    this.queueStore = new QueueStore(options.db);
    this.retryConfig = options.retry;
    this.jobStateTtlSeconds = options.jobStateTtlSeconds;
    this.maxLogsPerJob = options.maxLogsPerJob;

    const wrappedHandler = this.#createWrappedHandler(options.consumer.handler);
    this.consumer = new Consumer({ ...options.consumer, handler: wrappedHandler });
  }

  /**
   * Wrapped handler — execute → ACK on success, retry / NACK on failure.
   */
  #createWrappedHandler(
    originalHandler: ProcessorOptions['consumer']['handler'],
  ): (message: Message, ctx: MessageContext) => Promise<void> {
    return async (message: Message, ctx: MessageContext) => {
      try {
        await originalHandler(message, ctx);
        await ctx.ack();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        await this.#handleFailure(message, err, ctx);
      }
    };
  }

  async #handleFailure(
    message: Message,
    error: Error,
    ctx: MessageContext,
  ): Promise<void> {
    const jobData = message.data as any;
    const retryCount = jobData.retryCount ?? 0;
    const retriedAttempts = jobData.retriedAttempts ?? 0;
    const retryDelayMs = jobData.retryDelayMs ?? this.retryConfig?.retryDelayMs ?? 1000;
    const retryBackoff = jobData.retryBackoff ?? this.retryConfig?.retryBackoff ?? 'fixed';

    const isConfigError = error.message.includes('No handler found') ||
      error.message.includes('No handlers registered') ||
      error.message.includes('is undefined');

    const willRetry = retryCount > 0 &&
      !isConfigError &&
      (!this.retryConfig?.shouldRetry || this.retryConfig.shouldRetry(error, retriedAttempts + 1));

    if (willRetry) {
      const backoffMs = retryBackoff === 'exponential'
        ? Math.min(retryDelayMs * Math.pow(2, retriedAttempts), MAX_RETRY_DELAY_MS)
        : retryDelayMs;

      const retryScore = Date.now() + backoffMs;
      const retryJob = {
        ...jobData,
        delayUntil: retryScore,
        lockUntil: Date.now(),
        retryCount: retryCount - 1,
        retriedAttempts: retriedAttempts + 1,
        status: 'delayed',
        logs: [
          ...(jobData.logs ?? []),
          {
            message: `retrying — attempt ${retriedAttempts + 1}, delay ${backoffMs}ms`,
            timestamp: Date.now(),
          },
        ],
      };
      this.#trimLogs(retryJob);

      // Write delayed state key so getJobData finds the job on next claim
      await this.#setKey(`queues:${message.queue}:${message.id}:delayed`, JSON.stringify(retryJob));
      await this.queueStore.enqueue(message.queue, message.id, retryScore);
      await ctx.ack();
      return;
    }

    await ctx.nack(error);
  }

  async #setKey(key: string, value: string): Promise<void> {
    const ttl = this.jobStateTtlSeconds;
    if (typeof ttl === 'number' && ttl > 0) {
      await this.db.set(key, value, 'EX', ttl);
    } else {
      await this.db.set(key, value);
    }
  }

  #trimLogs(jobEntry: { logs?: unknown[] }): void {
    const max = this.maxLogsPerJob;
    if (typeof max !== 'number' || max <= 0 || !jobEntry.logs?.length || jobEntry.logs.length <= max) return;
    jobEntry.logs.splice(0, jobEntry.logs.length - max);
  }

  async start(options?: { signal?: AbortSignal }): Promise<void> {
    await this.consumer.start(options);
  }

  stop(): void {
    this.consumer.stop();
  }

  async waitForActiveJobs(): Promise<void> {
    await this.consumer.waitForActiveJobs();
  }
}
