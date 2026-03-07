/**
 * Consumer — runtime engine for Redis Streams (fill-then-drain, real ACK/NACK, stable consumer ID).
 *
 * @module
 */
import type {
  ConsumerOptions,
  Message,
  MessageContext,
} from '../../types/index.ts';
import { StreamReader } from './stream-reader.ts';

/**
 * Runtime engine for processing messages from Redis Streams. Fill-then-drain, real ACK/NACK, error isolation.
 */
export class Consumer extends EventTarget {
  private readonly streamdb: ConsumerOptions['streamdb'];
  private readonly streams: string[]; // sorted by priority ascending (lower number = higher priority)
  private readonly group: string;
  private readonly consumerId: string;
  private readonly handler: ConsumerOptions['handler'];
  private readonly streamReader: StreamReader;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrency: number;

  #isProcessing = false;
  #processingController = new AbortController();
  #processingFinished: Promise<void> = Promise.resolve();
  readonly #activeJobs = new Set<Promise<void>>();
  #consecutiveRedisErrors = 0;

  /**
   * Create a consumer for the given streams and handler. Ensures consumer groups in start().
   * @param options - Streams, streamdb, handler, group, concurrency, and optional priority/poll/read
   * @throws If streams is empty or handler is missing
   */
  constructor(options: ConsumerOptions) {
    super();

    if (!options.streams || options.streams.length === 0) {
      throw new Error('At least one stream must be specified');
    }

    if (!options.handler) {
      throw new Error('Handler is required');
    }

    this.streamdb = options.streamdb;
    this.group = options.group || 'processor';

    // Sort streams by priority — lower number = higher priority = read first
    // Streams not in the priority map get Infinity (read last)
    // Example: { 'payments-stream': 1, 'sync-stream': 2 }
    const priorityMap = options.streamPriority ?? {};
    this.streams = [...options.streams].sort((a, b) => {
      const pa = priorityMap[a] ?? Infinity;
      const pb = priorityMap[b] ?? Infinity;
      return pa - pb;
    });
    this.consumerId = options.consumerId || this.#generateConsumerId();
    this.handler = options.handler;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.maxConcurrency = options.concurrency ?? 1;

    this.streamReader = new StreamReader(
      this.streamdb,
      this.group,
      this.consumerId,
      options.read?.count ?? 200,
      options.read?.blockMs ?? 50,
      options.visibilityTimeoutMs ?? 30_000,
    );
  }

  /**
   * Start the processing loop.
   * Ensures consumer groups exist for all registered streams before starting.
   * Self-contained — does not rely on caller to have set up groups.
   */
  async start(options: { signal?: AbortSignal } = {}): Promise<void> {
    // Ensure consumer groups once at startup — not on every poll cycle
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
   * Main processing loop.
   *
   * Fill-then-drain pattern:
   * 1. Read ALL streams into a single message buffer (no break on first hit)
   * 2. Dispatch messages up to concurrency limit
   * 3. Tight 50ms spin when at concurrency limit — don't wait full pollIntervalMs
   * 4. Back off exponentially on Redis errors
   *
   * Why fill-then-drain:
   * Breaking on first stream with messages starves other queues under load.
   * At high throughput on default-stream, scheduled-stream would never get read.
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
          // Fill: read all streams into buffer — no break on first hit
          const messages: Message[] = [];
          for (const streamKey of this.streams) {
            const queueName = streamKey.replace(/-stream$/, '');
            const batch = await this.streamReader.readQueueStream(queueName);
            messages.push(...batch);
            // No break — drain every stream before dispatching
          }

          if (messages.length === 0) {
            await this.#delay(this.pollIntervalMs);
            continue;
          }

          // Successfully read — reset error backoff
          this.#consecutiveRedisErrors = 0;

          // Drain: dispatch messages up to concurrency limit
          for (const message of messages) {
            if (signal?.aborted || controller.signal.aborted) return;

            // Tight spin when at concurrency limit — 50ms not pollIntervalMs
            while (
              this.#activeJobs.size >= this.maxConcurrency
            ) {
              await Promise.race([
                Promise.race(Array.from(this.#activeJobs)),
                this.#delay(50),
              ]);
              if (signal?.aborted || controller.signal.aborted) return;
            }

            const task = (async () => {
              try {
                await this.#processMessage(message);
              } catch (error) {
                // Error isolation — one message failure never kills the loop
                console.error(`[remq] Message ${message.id} error:`, error);
              }
            })();

            this.#activeJobs.add(task);
            task.finally(() => this.#activeJobs.delete(task));
          }
        } catch (error) {
          console.error('[remq] Processing loop error:', error);
          const isTransient = this.#isRedisTransientError(error);
          const delayMs = isTransient
            ? Math.min(
              this.pollIntervalMs *
                Math.pow(2, this.#consecutiveRedisErrors),
              30_000,
            )
            : this.pollIntervalMs;
          if (isTransient) this.#consecutiveRedisErrors += 1;
          else this.#consecutiveRedisErrors = 0;
          await this.#delay(delayMs);
        }
      }
    } finally {
      this.#isProcessing = false;
    }
  }

  /**
   * Process a single message.
   *
   * Creates a real MessageContext with live ack/nack operations.
   * ACK is NOT called here — processor.ts calls ctx.ack() after handler success
   * and ctx.nack() after final failure. Consumer has no opinion on ACK timing.
   *
   * Error isolation: errors are caught by the task wrapper in #processLoop.
   */
  async #processMessage(message: Message): Promise<void> {
    const startTime = Date.now();

    // Real ACK/NACK — not no-ops
    const ctx: MessageContext = {
      message,
      ack: () => this.streamReader.ack(message.streamKey, message.id),
      nack: (_error: Error) =>
        this.streamReader.nack(message.streamKey, message.id),
    };

    this.#emitEvent('started', { message });

    try {
      await this.handler(message, ctx);
      this.#emitEvent('succeeded', {
        message,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.#emitEvent('failed', {
        message,
        error: err,
        duration: Date.now() - startTime,
      });
      this.#emitEvent('error', { error: err });
      throw err; // Re-throw so task wrapper logs it
    }
  }

  /**
   * Stop the processing loop.
   * Does not wait for active jobs — call drain() after stop() for graceful shutdown.
   */
  stop(): void {
    this.#processingController.abort();
    this.#processingController = new AbortController();
  }

  /**
   * Wait for all in-flight jobs to complete.
   * Call after stop() for graceful shutdown.
   */
  async waitForActiveJobs(): Promise<void> {
    if (this.#activeJobs.size > 0) {
      await Promise.all(Array.from(this.#activeJobs));
    }
  }

  get isProcessing(): boolean {
    return this.#isProcessing;
  }

  get processingFinished(): Promise<void> {
    return this.#processingFinished;
  }

  get activeJobs(): Set<Promise<void>> {
    return this.#activeJobs;
  }

  /**
   * Generate a stable consumer ID from hostname + pid.
   * Visible in Redis XPENDING output — useful for multi-instance debugging.
   * Format: consumer-{hostname}-{pid}
   */
  #generateConsumerId(): string {
    try {
      const hostname = typeof Deno !== 'undefined' && Deno.hostname
        ? Deno.hostname()
        : 'unknown';
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
   * Heuristic: true if the error is a transient Redis condition.
   * Transient errors trigger exponential backoff instead of fixed pollIntervalMs.
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

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #emitEvent(type: string, detail: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
