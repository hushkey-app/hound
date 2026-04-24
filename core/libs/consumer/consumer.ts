/**
 * Consumer — poll loop over sorted-set queues (claim, dispatch, concurrency).
 *
 * @module
 */
import type {
  ConsumerOptions,
  Message,
  MessageContext,
} from '../../types/index.ts';
import { QueueStore } from './queue-store.ts';

export class Consumer {
  private readonly db: ConsumerOptions['db'];
  private readonly queues: string[];
  private readonly handler: ConsumerOptions['handler'];
  private readonly queueStore: QueueStore;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrency: number;
  private readonly claimCount: number;

  #isProcessing = false;
  #processingController = new AbortController();
  #processingFinished: Promise<void> = Promise.resolve();
  readonly #activeJobs = new Set<Promise<void>>();
  #consecutiveErrors = 0;

  constructor(options: ConsumerOptions) {
    if (!options.queues || options.queues.length === 0) {
      throw new Error('At least one queue must be specified');
    }
    if (!options.handler) {
      throw new Error('Handler is required');
    }

    this.db = options.db;

    // Sort queues by priority — lower number = polled first
    const priorityMap = options.queuePriority ?? {};
    this.queues = [...options.queues].sort((a, b) => {
      const pa = priorityMap[a] ?? Infinity;
      const pb = priorityMap[b] ?? Infinity;
      return pa - pb;
    });

    this.handler = options.handler;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.maxConcurrency = options.concurrency ?? 1;
    this.claimCount = options.claimCount ?? 200;
    this.queueStore = new QueueStore(this.db);
  }

  async start(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    const controller = this.#processingController;
    this.#processingFinished = this.#processingFinished.then(() =>
      this.#processLoop({ signal, controller })
    );
    return this.#processingFinished;
  }

  async #processLoop(
    options: { signal?: AbortSignal; controller: AbortController },
  ): Promise<void> {
    const { signal, controller } = options;
    this.#isProcessing = true;

    try {
      while (true) {
        if (signal?.aborted || controller.signal.aborted) break;

        try {
          // Claim from all queues (in priority order) into a single batch
          const messages: Message[] = [];
          for (const queue of this.queues) {
            const batch = await this.#claimFromQueue(queue);
            messages.push(...batch);
          }

          if (messages.length === 0) {
            await this.#delay(this.pollIntervalMs);
            continue;
          }

          this.#consecutiveErrors = 0;

          // Sort claimed messages by priority descending (higher priority number = first)
          messages.sort((a, b) => (b.data.priority ?? 0) - (a.data.priority ?? 0));

          // Dispatch up to concurrency limit
          for (const message of messages) {
            if (signal?.aborted || controller.signal.aborted) return;

            while (this.#activeJobs.size >= this.maxConcurrency) {
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
                console.error(`[hound] Message ${message.id} error:`, error);
              }
            })();

            this.#activeJobs.add(task);
            task.finally(() => this.#activeJobs.delete(task));
          }
        } catch (error) {
          console.error('[hound] Processing loop error:', error);
          const isTransient = this.#isTransientError(error);
          const delayMs = isTransient
            ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.#consecutiveErrors),
              30_000,
            )
            : this.pollIntervalMs;
          if (isTransient) this.#consecutiveErrors += 1;
          else this.#consecutiveErrors = 0;
          await this.#delay(delayMs);
        }
      }
    } finally {
      this.#isProcessing = false;
    }
  }

  async #claimFromQueue(queue: string): Promise<Message[]> {
    try {
      const jobIds = await this.queueStore.claim(queue, this.claimCount);
      if (!jobIds.length) return [];

      const dataMap = await this.queueStore.getJobData(queue, jobIds);
      const messages: Message[] = [];

      for (const jobId of jobIds) {
        const raw = dataMap.get(jobId);
        if (!raw) {
          // State key missing — job was deleted externally; clean up processing set
          await this.queueStore.ack(queue, jobId);
          continue;
        }
        try {
          const jobData = JSON.parse(raw);
          messages.push({ id: jobId, queue, data: jobData });
        } catch {
          console.error(`[hound] Failed to parse job data for ${jobId}`);
          await this.queueStore.ack(queue, jobId);
        }
      }
      return messages;
    } catch (error) {
      console.error(`[hound] Error claiming from queue ${queue}:`, error);
      return [];
    }
  }

  async #processMessage(message: Message): Promise<void> {
    const ctx: MessageContext = {
      message,
      ack: () => this.queueStore.ack(message.queue, message.id),
      nack: (_error: Error) => this.queueStore.nack(message.queue, message.id),
    };

    try {
      await this.handler(message, ctx);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw err;
    }
  }

  stop(): void {
    // Abort the controller — also wakes up any pending #delay calls immediately
    this.#processingController.abort();
    this.#processingController = new AbortController();
  }

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

  #isTransientError(error: unknown): boolean {
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

  // Abort-aware delay — resolves immediately when the processing controller is aborted.
  // Without this, the poll loop would sleep the full pollIntervalMs after stop() is called,
  // keeping the event loop alive and preventing natural process exit.
  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      const abort = () => { clearTimeout(id); resolve(); };
      this.#processingController.signal.addEventListener('abort', abort, { once: true });
    });
  }
}
