import type { ConsumerOptions } from '../../types/consumer.ts';
import type { Message, MessageContext } from '../../types/message.ts';
import { StreamReader } from './stream-reader.ts';
import { ConcurrencyPool } from './concurrency-pool.ts';

/**
 * Consumer - Runtime engine for processing messages from Redis Streams
 *
 * Based on old worker's robust processJobsLoop logic
 */
export class Consumer extends EventTarget {
  private readonly streamdb: ConsumerOptions['streamdb'];
  private readonly streams: string[];
  private readonly group: string;
  private readonly consumerId: string;
  private readonly handler: ConsumerOptions['handler'];
  private readonly streamReader: StreamReader;
  private readonly concurrencyPool: ConcurrencyPool;
  private readonly pollIntervalMs: number;

  #isProcessing = false;
  #processingController = new AbortController();
  #processingFinished: Promise<void> = Promise.resolve();
  readonly #activeJobs = new Set<Promise<void>>(); // Like old worker line 63
  #consecutiveRedisErrors = 0;

  constructor(options: ConsumerOptions) {
    super();

    if (!options.streams || options.streams.length === 0) {
      throw new Error('At least one stream must be specified');
    }

    if (!options.handler) {
      throw new Error('Handler is required');
    }

    this.streamdb = options.streamdb;
    this.streams = options.streams;
    this.group = options.group || 'processor';
    this.consumerId = options.consumerId || this.generateStableConsumerId();
    this.handler = options.handler;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000; // Like old worker line 115

    const concurrency = options.concurrency ?? 1;
    this.concurrencyPool = new ConcurrencyPool(concurrency);

    this.streamReader = new StreamReader(
      this.streamdb,
      this.group,
      this.consumerId,
      options.read?.count ?? 200,
      options.read?.blockMs ?? 1000,
    );
  }

  /**
   * Generates a stable consumer ID
   */
  generateStableConsumerId(): string {
    try {
      // @ts-ignore - Deno hostname might not be available in all environments
      const hostname = typeof Deno !== 'undefined' && Deno.hostname
        ? Deno.hostname()
        : 'unknown';

      // @ts-ignore - Deno.pid might not be in types
      const pid = typeof Deno !== 'undefined' && Deno.pid !== undefined
        ? Deno.pid
        : Date.now();

      return `consumer-${hostname}-${pid}`;
    } catch {
      return `consumer-${Date.now()}-${
        Math.random().toString(36).substring(2, 9)
      }`;
    }
  }

  /**
   * Starts processing messages (like old worker processJobs)
   */
  async start(options: { signal?: AbortSignal } = {}): Promise<void> {
    // Ensure consumer groups once at startup, not on every poll (avoids Redis round trip per stream per cycle)
    for (const streamKey of this.streams) {
      await this.streamReader.ensureConsumerGroup(streamKey);
    }
    const { signal } = options;
    const controller = this.#processingController;
    this.#processingFinished = this.#processingFinished.then(() =>
      this.#processLoop({ signal, controller })
    );
    return this.#processingFinished;
  }

  /**
   * Main processing loop (copied from old worker processJobsLoop)
   */
  async #processLoop(
    options: { signal?: AbortSignal; controller: AbortController },
  ): Promise<void> {
    const { signal, controller } = options;
    this.#isProcessing = true;

    try {
      while (true) {
        if (signal?.aborted || controller.signal.aborted) break;

        try {
          // FIX 6: read ALL streams into buffer — no break on first hit.
          // Previously broke after the first stream with messages, leaving
          // other queues unread and workers starved between poll cycles.
          const messages: Message[] = [];

          for (const streamKey of this.streams) {
            const queueName = streamKey.replace('-stream', '');
            const queueMessages = await this.streamReader.readQueueStream(
              queueName,
            );
            messages.push(...queueMessages);
            // no break — drain every stream before dispatching
          }

          if (messages.length === 0) {
            await this.delay(this.pollIntervalMs);
            continue;
          }

          this.#consecutiveRedisErrors = 0;

          for (const message of messages) {
            if (signal?.aborted || controller.signal.aborted) return;

            // FIX 6: tight spin when at concurrency limit — 50ms instead of
            // pollIntervalMs (3000ms). Workers were stalling up to 3 seconds
            // waiting for a slot to open even with a full message buffer.
            while (
              this.#activeJobs.size >= this.concurrencyPool.maxConcurrency
            ) {
              await Promise.race([
                Promise.race(this.#activeJobs),
                this.delay(50),
              ]);
              if (signal?.aborted || controller.signal.aborted) return;
            }

            const taskPromise = (async () => {
              try {
                await this.#processMessage(message);
              } catch (error) {
                console.error(`Message ${message.id} processing error:`, error);
              }
            })();

            this.#activeJobs.add(taskPromise);
            taskPromise.finally(() => this.#activeJobs.delete(taskPromise));
          }
        } catch (error) {
          console.error('Error in processing loop:', error);
          const isTransient = this.#isRedisTransientError(error);
          const delayMs = isTransient
            ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.#consecutiveRedisErrors),
              30000,
            )
            : this.pollIntervalMs;
          if (isTransient) this.#consecutiveRedisErrors += 1;
          else this.#consecutiveRedisErrors = 0;
          await this.delay(delayMs);
        }
      }
    } finally {
      this.#isProcessing = false;
    }
  }

  /**
   * Processes a single message (messages already ACKed after reading)
   */
  async #processMessage(message: Message): Promise<void> {
    const startTime = Date.now();

    // Create no-op context (messages already ACKed after reading)
    const ctx: MessageContext = {
      message,
      ack: async () => {
        // Already ACKed after reading - no-op
      },
      nack: async () => {
        // Already ACKed after reading - no-op
      },
    };

    // Emit started event
    this.#emitStarted(message);

    try {
      // Call handler (messages already ACKed, processing key acts as lock)
      await this.handler(message, ctx);

      const duration = Date.now() - startTime;
      this.#emitSucceeded(message, duration);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const duration = Date.now() - startTime;

      // Error handling - message already ACKed, errors tracked via Redis keys
      this.#emitFailed(message, err, duration);
      this.#emitError(err);
    }
  }

  /**
   * Stops processing
   */
  stop(): void {
    this.#processingController.abort();
    this.#processingController = new AbortController();
  }

  /**
   * Whether the consumer is currently processing
   */
  get isProcessing(): boolean {
    return this.#isProcessing;
  }

  /**
   * Promise that resolves when processing loop exits
   */
  get processingFinished(): Promise<void> {
    return this.#processingFinished;
  }

  /**
   * Set of currently running tasks
   */
  get activeJobs(): Set<Promise<void>> {
    return this.#activeJobs;
  }

  /**
   * Waits for all active tasks to complete
   */
  async waitForActiveJobs(): Promise<void> {
    if (this.#activeJobs.size > 0) {
      await Promise.all(this.#activeJobs);
    }
  }

  /**
   * Heuristic: true if the error is a transient Redis condition (LOADING, connection reset, etc.)
   * so we can back off instead of hammering Redis.
   */
  #isRedisTransientError(error: unknown): boolean {
    const msg = typeof (error as { message?: string })?.message === 'string'
      ? (error as { message: string }).message
      : '';
    const code = (error as { code?: string })?.code ?? '';
    return (
      msg.includes('LOADING') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('Connection is closed') ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED'
    );
  }

  /**
   * Delay utility (like old worker)
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Event emitters
  #emitStarted(message: Message): void {
    this.dispatchEvent(
      new CustomEvent('started', {
        detail: { message },
      }),
    );
  }

  #emitSucceeded(message: Message, duration: number): void {
    this.dispatchEvent(
      new CustomEvent('succeeded', {
        detail: { message, duration },
      }),
    );
  }

  #emitFailed(message: Message, error: Error, duration: number): void {
    this.dispatchEvent(
      new CustomEvent('failed', {
        detail: { message, error, duration },
      }),
    );
  }

  #emitError(error: Error): void {
    this.dispatchEvent(
      new CustomEvent('error', {
        detail: { error },
      }),
    );
  }
}
