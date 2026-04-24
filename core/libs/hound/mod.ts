/**
 * Hound — high-level public API for job management (singleton lifecycle, handlers, emit, start/stop).
 * Built on Processor → Consumer → QueueStore.
 *
 * @module
 */
import { Processor } from '../processor/processor.ts';
import { DebounceManager } from '../processor/debounce-manager.ts';
import { QueueStore } from '../consumer/queue-store.ts';
import { Reaper } from '../consumer/reaper.ts';
import { createWsGateway } from '../gateways/ws.gateway.ts';
import { debug } from '../../utils/logger.ts';
import type {
  EmitAsyncFunction,
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  JobData,
  JobDefinition,
  JobHandler,
  HoundOptions,
  JobSocketContext,
  Message,
  MessageContext,
  ProcessableMessage,
  RedisConnection,
} from '../../types/index.ts';
import {
  genExecId,
  genJobIdSync,
  parseCronExpression,
} from '../../utils/index.ts';

/** Re-exported option and handler types for Hound. */
export type {
  EmitAsyncFunction,
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  JobContext,
  JobDefinition,
  JobHandler,
  HoundOptions,
} from '../../types/index.ts';

/** Symbol for internal subscription. Not part of public API. */
export const SUBSCRIBE_JOB_FINISHED = Symbol.for('hound.subscribeJobFinished');

export class Hound<
  TApp extends Record<string, unknown> = Record<string, unknown>,
> {
  private static instance: Hound<any>;

  private readonly db: RedisConnection;
  private readonly queueStore: QueueStore;
  private readonly ctx: TApp & {
    emit: EmitFunction;
    emitAsync: EmitAsyncFunction;
  };
  private readonly concurrency: number;
  private readonly processorOptions: HoundOptions<TApp>['processor'];

  private handlers: Map<string, JobHandler<TApp, any>> = new Map();
  private handlerDebounce: Map<string, DebounceManager> = new Map();
  private pendingCronJobs: Map<
    string,
    {
      event: string;
      queue: string;
      repeat: { pattern: string };
      attempts?: number;
    }
  > = new Map();
  private processor?: Processor;
  private reaper?: Reaper;
  private queues: Set<string> = new Set();
  private isStarted = false;
  private shutdownRegistered = false;
  private readonly expose?: number;
  private wsServer?: ReturnType<typeof createWsGateway>;
  private readonly broadcastSockets = new Set<WebSocket>();

  readonly #jobFinishedListeners = new Set<
    (payload: {
      jobId: string;
      queue: string;
      status: 'completed' | 'failed';
      error?: string;
    }) => void
  >();
  #jobFinishedUnsubscribe?: () => void;
  private readonly jobIdToSockets = new Map<string, Set<WebSocket>>();
  private readonly socketToJobIds = new Map<WebSocket, Set<string>>();

  private readonly JOB_STATUS_MESSAGES = {
    processing: 'Job execution started',
    completed: 'Job completed successfully',
    delayed: (date: string) => `Job delayed until ${date}`,
    waiting: 'Job queued and waiting to be processed',
    failed: (error: string) => `Job failed: ${error}`,
  };

  private constructor(options: HoundOptions<TApp>) {
    this.db = options.db;
    this.queueStore = new QueueStore(this.db);
    this.concurrency = options.concurrency ?? 1;
    this.processorOptions = options.processor || {};

    this.ctx = {
      ...(options.ctx || {} as TApp),
      emit: this.emit.bind(this),
      emitAsync: this.emitAsync.bind(this),
    } as TApp & { emit: EmitFunction; emitAsync: EmitAsyncFunction };

    this.expose = options.expose;
  }

  static create<TApp extends Record<string, unknown> = Record<string, unknown>>(
    options: HoundOptions<TApp>,
  ): Hound<TApp> {
    const g = globalThis as Record<string, unknown>;
    if (g['__hound_instance__']) {
      Hound.instance = g['__hound_instance__'] as Hound<TApp>;
      return Hound.instance;
    }
    Hound.instance = new Hound(options);
    g['__hound_instance__'] = Hound.instance;
    return Hound.instance as Hound<TApp>;
  }

  /** Reset singleton — test use only. */
  static _reset(): void {
    Hound.instance = undefined as any;
    (globalThis as Record<string, unknown>)['__hound_instance__'] = undefined;
  }

  static getInstance<
    TApp extends Record<string, unknown> = Record<string, unknown>,
  >(): Hound<TApp> {
    return Hound.instance as Hound<TApp>;
  }

  // ─── Handler registration ─────────────────────────────────────────────────

  on<D = unknown>(
    eventOrDefinition: string | JobDefinition<TApp, D>,
    handler?: JobHandler<TApp, D>,
    options?: HandlerOptions,
  ): this {
    let event: string;
    let h: JobHandler<TApp, D>;
    let opts: HandlerOptions | undefined;

    if (typeof eventOrDefinition === 'object') {
      event = eventOrDefinition.event;
      h = eventOrDefinition.handler;
      opts = eventOrDefinition.options;
    } else {
      event = eventOrDefinition;
      h = handler!;
      opts = options;
    }

    if (!event) throw new Error('event is required');
    if (!h) throw new Error('handler is required');

    const queue = opts?.queue ?? 'default';
    const handlerKey = `${queue}:${event}`;

    this.handlers.set(handlerKey, h as JobHandler<TApp, any>);
    this.queues.add(queue);

    if (opts?.debounce !== undefined) {
      const debounceSeconds = Math.ceil(opts.debounce / 1000);
      this.handlerDebounce.set(handlerKey, new DebounceManager(debounceSeconds, undefined));
    }

    if (opts?.repeat?.pattern) {
      this.pendingCronJobs.set(handlerKey, {
        event,
        queue,
        repeat: { pattern: opts.repeat.pattern },
        attempts: opts.attempts,
      });
    }

    return this;
  }

  // ─── Emission ─────────────────────────────────────────────────────────────

  #buildPayload(
    event: string,
    data?: unknown,
    options?: EmitOptions,
  ): [string, string, string, string] {
    const opts = options ?? {};
    const queue = opts.queue ?? 'default';
    const payload = data ?? {};

    if (!event) throw new Error('event is required');

    const jobId = opts.id ?? genJobIdSync(event, payload);

    let delayUntil: Date | number = opts.delay ?? new Date();
    if (opts.delay) {
      delayUntil = opts.delay;
    } else if (opts.repeat?.pattern) {
      delayUntil = parseCronExpression(opts.repeat.pattern).getNextDate(new Date());
    }

    const delayUntilMs = delayUntil instanceof Date ? delayUntil.getTime() : delayUntil;

    const jobData: JobData = {
      id: jobId,
      state: {
        name: event,
        queue,
        data: payload,
        options: opts,
      },
      status: opts.repeat?.pattern ? 'delayed' : 'waiting',
      delayUntil: delayUntilMs,
      lockUntil: Date.now(),
      priority: opts.priority ?? 0,
      retryCount: opts.retryCount ?? (opts.attempts ?? 0),
      retryDelayMs: opts.retryDelayMs ?? 1000,
      retryBackoff: opts.retryBackoff ?? 'fixed',
      retriedAttempts: 0,
      repeatCount: opts.repeat?.pattern ? 1 : 0,
      repeatDelayMs: 0,
      logs: [{ message: 'Added to the queue', timestamp: Date.now() }],
      errors: [],
      timestamp: Date.now(),
    };

    const stateKey = `queues:${queue}:${jobId}:${jobData.status}`;
    const dataJson = JSON.stringify(jobData);

    // Score: delayUntil adjusted by priority (higher priority = lower score = runs first)
    const score = delayUntilMs - (opts.priority ?? 0);

    return [jobId, queue, stateKey, dataJson];
  }

  emit(event: string, data?: unknown, options?: EmitOptions): string {
    const [jobId, queue, stateKey, dataJson] = this.#buildPayload(event, data, options);
    const opts = options ?? {};
    const delayUntilMs = this.#scoreFromOptions(opts, dataJson);

    this.#setJobState(stateKey, dataJson)
      .then(() => this.queueStore.enqueue(queue, jobId, delayUntilMs))
      .catch((err: unknown) => {
        console.error(` emit failed for ${event}:`, err);
      });

    return jobId;
  }

  async emitAsync(event: string, data?: unknown, options?: EmitOptions): Promise<string> {
    const [jobId, queue, stateKey, dataJson] = this.#buildPayload(event, data, options);
    const score = this.#scoreFromOptions(options ?? {}, dataJson);

    await this.#setJobState(stateKey, dataJson);
    await this.queueStore.enqueue(queue, jobId, score);

    return jobId;
  }

  /** Score for ZADD: delayUntil adjusted by priority. */
  #scoreFromOptions(opts: EmitOptions, dataJson: string): number {
    const parsed = JSON.parse(dataJson) as JobData;
    return parsed.delayUntil - (opts.priority ?? 0);
  }

  /** Enqueue an existing job payload directly (used by HoundManagement.promoteJob). */
  async enqueueJob(queue: string, jobPayload: Record<string, unknown>): Promise<void> {
    const jobId = jobPayload.id as string;
    const score = (jobPayload.delayUntil as number ?? Date.now()) - ((jobPayload.priority as number) ?? 0);
    await this.queueStore.enqueue(queue, jobId, score);
  }

  // ─── Job finished listeners ───────────────────────────────────────────────

  [SUBSCRIBE_JOB_FINISHED](
    cb: (payload: {
      jobId: string;
      queue: string;
      status: 'completed' | 'failed';
      error?: string;
    }) => void,
  ): () => void {
    this.#jobFinishedListeners.add(cb);
    return () => this.#jobFinishedListeners.delete(cb);
  }

  #notifyJobFinished(payload: {
    jobId: string;
    queue: string;
    status: 'completed' | 'failed';
    error?: string;
  }): void {
    for (const cb of this.#jobFinishedListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error(' jobFinished listener error:', err);
      }
    }
  }

  // ─── Redis primitives ─────────────────────────────────────────────────────

  async #setJobState(key: string, value: string): Promise<void> {
    const ttl = this.processorOptions?.jobStateTtlSeconds;
    if (typeof ttl === 'number' && ttl > 0) {
      await this.db.set(key, value, 'EX', ttl);
    } else {
      await this.db.set(key, value);
    }
  }

  /** Pipeline DEL old key + SET new key in one round trip. */
  private async transitionState(delKey: string, setKey: string, value: string): Promise<void> {
    const ttl = this.processorOptions?.jobStateTtlSeconds;
    const pipe = this.db.pipeline();
    pipe.del(delKey);
    if (typeof ttl === 'number' && ttl > 0) {
      pipe.set(setKey, value, 'EX', ttl);
    } else {
      pipe.set(setKey, value);
    }
    await pipe.exec();
  }

  #trimLogs(jobEntry: { logs?: unknown[] }): void {
    const max = this.processorOptions?.maxLogsPerJob;
    if (
      typeof max !== 'number' ||
      max <= 0 ||
      !jobEntry.logs?.length ||
      jobEntry.logs.length <= max
    ) return;
    jobEntry.logs.splice(0, jobEntry.logs.length - max);
  }

  // ─── Start ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isStarted) return;

    if (this.processor) {
      this.processor.stop();
      await this.drain();
    }

    // Cron dedup — simplified: check state key, no stream scan needed
    for (const [, { event, queue, repeat, attempts }] of this.pendingCronJobs) {
      const jobId = genJobIdSync(event, {});

      // Check if already scheduled (delayed state key exists)
      const delayedKey = `queues:${queue}:${jobId}:delayed`;
      const existingData = await this.db.get(delayedKey);

      if (existingData) {
        try {
          const existing = JSON.parse(existingData);
          // Re-add to queue in case the sorted set was flushed (restart safety)
          const score = (existing.delayUntil ?? Date.now()) - (existing.priority ?? 0);
          await this.queueStore.enqueue(queue, jobId, score);
          debug(` cron ${event}: re-registered with delayUntil=${existing.delayUntil}`);
        } catch {
          // Corrupt state — emit fresh
          await this.emitAsync(event, {}, { queue, repeat, attempts });
        }
      } else {
        // Check processing set — Reaper will handle it if it's there
        const inProcessing = await this.db.zscore(`queues:${queue}:processing`, jobId);
        if (!inProcessing) {
          // Not scheduled anywhere — emit fresh
          await this.emitAsync(event, {}, { queue, repeat, attempts });
          debug(` cron ${event}: emitted fresh`);
        } else {
          debug(` cron ${event}: found in processing set, Reaper will reclaim if stalled`);
        }
      }
    }

    this.#createUnifiedProcessor();

    if (this.processor) {
      this.processor.start().catch((err) => {
        console.error(' Error starting processor:', err);
      });
    }

    // Start Reaper
    const allQueues = Array.from(this.queues);
    this.reaper = new Reaper({
      db: this.db,
      queues: allQueues,
      visibilityTimeoutMs: this.processorOptions?.visibilityTimeoutMs,
    });
    this.reaper.start();

    this.isStarted = true;
    this.#setupGracefulShutdown();

    if (this.expose != null) {
      this.wsServer = createWsGateway({
        port: this.expose,
        hostname: '0.0.0.0',
        hound: this,
        onConnection: (ws, req) => this.#handleWsConnection(ws, req),
      });
      this.#jobFinishedUnsubscribe = this[SUBSCRIBE_JOB_FINISHED]((payload) => {
        const sockets = this.#getSocketsForJob(payload.jobId);
        if (!sockets.size) return;
        const payloadStr = JSON.stringify({
          type: 'job_finished',
          jobId: payload.jobId,
          queue: payload.queue,
          status: payload.status,
          error: payload.error,
        });
        for (const socket of sockets) {
          try {
            if (socket.readyState === WebSocket.OPEN) socket.send(payloadStr);
          } catch (err) {
            console.error(' WS send job_finished error:', err);
          }
        }
        const socketsThatHadJob = this.jobIdToSockets.get(payload.jobId);
        this.jobIdToSockets.delete(payload.jobId);
        if (socketsThatHadJob) {
          for (const ws of socketsThatHadJob) {
            this.socketToJobIds.get(ws)?.delete(payload.jobId);
          }
        }
      });
      debug(`Hound WS gateway listening on 0.0.0.0:${this.expose}`);
    }

    const queueList = Array.from(this.queues).join(', ');
    debug(`Hound started with ${this.queues.size} queue(s) [${queueList}] and concurrency ${this.concurrency}`);
  }

  // ─── Stop / drain ─────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.#jobFinishedUnsubscribe?.();
    this.#jobFinishedUnsubscribe = undefined;
    this.broadcastSockets.clear();
    this.jobIdToSockets.clear();
    this.socketToJobIds.clear();

    this.reaper?.stop();
    this.reaper = undefined;

    // Stop the consumer poll loop before closing the WS server
    this.processor?.stop();

    if (this.wsServer) {
      // Race against a 2s timeout — open WS connections can stall graceful shutdown
      await Promise.race([
        this.wsServer.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      this.wsServer = undefined;
    }

    this.isStarted = false;
  }

  async drain(): Promise<void> {
    if (this.processor) {
      await this.processor.waitForActiveJobs();
    }
  }

  // ─── Processor creation ───────────────────────────────────────────────────

  #createUnifiedProcessor(): void {
    const allQueues = Array.from(this.queues);

    const queuePriority: Record<string, number> = {};
    const userPriority = this.processorOptions?.queuePriority ?? {};
    for (const [queue, priority] of Object.entries(userPriority)) {
      queuePriority[queue] = priority;
    }

    const unifiedHandler = async (
      message: Message,
      ctx: MessageContext,
    ): Promise<void> => {
      const msg = message as unknown as ProcessableMessage;
      const jobData = msg.data;

      if (!jobData?.state?.name || !jobData?.state?.queue) {
        throw new Error(' Invalid job data: missing state.name or state.queue');
      }

      const queueName = jobData.state.queue;
      const jobName = jobData.state.name!;
      const handlerKey = `${queueName}:${jobName}`;
      const jobId = jobData.id || msg.id;

      // Pipeline pause check + job state check
      const pipe = this.db.pipeline();
      pipe.get(`queues:${queueName}:paused`);
      pipe.get(`queues:${queueName}:${jobId}:${jobData.status || 'waiting'}`);
      const [[, isPaused], [, jobStatusData]] = (await pipe.exec()) as [
        [Error | null, string | null],
        [Error | null, string | null],
      ];

      // Queue paused — leave in processing set, don't ACK
      if (isPaused === 'true') return;

      if (jobStatusData) {
        try {
          const parsed = JSON.parse(jobStatusData) as {
            status?: string;
            paused?: boolean;
          };
          if (parsed.status === 'completed' || parsed.status === 'failed') {
            await ctx.ack();
            return;
          }
          if (parsed.paused === true) return;
        } catch {
          // Unparseable state — continue processing
        }
      }

      const handler = this.handlers.get(handlerKey);
      if (!handler) {
        throw new Error(
          ` No handler for queue: ${queueName}, event: ${jobName}. ` +
            `Registered: ${Array.from(this.handlers.keys()).join(', ')}`,
        );
      }

      const debounceManager = this.handlerDebounce.get(handlerKey);
      if (debounceManager) {
        if (!debounceManager.shouldProcess(msg as any)) {
          await ctx.ack();
          return;
        }
        const originalHandler = handler;
        const wrappedHandler = async (c: any) => {
          await originalHandler(c);
          debounceManager.markProcessed(msg as any);
        };
        await this.#processJob(jobData, jobId, queueName, wrappedHandler, ctx);
      } else {
        await this.#processJob(jobData, jobId, queueName, handler, ctx);
      }
    };

    this.processor = new Processor({
      consumer: {
        queues: allQueues,
        db: this.db,
        handler: unifiedHandler,
        concurrency: this.concurrency,
        pollIntervalMs: this.processorOptions?.pollIntervalMs,
        visibilityTimeoutMs: this.processorOptions?.visibilityTimeoutMs,
        queuePriority,
        claimCount: this.processorOptions?.claimCount,
      },
      db: this.db,
      ...this.processorOptions,
    });
  }

  // ─── Job processing ───────────────────────────────────────────────────────

  async #processJob(
    jobEntry: any,
    jobId: string,
    queueName: string,
    handler: JobHandler<TApp, any>,
    _ctx: MessageContext,
  ): Promise<void> {
    try {
      if (!jobEntry.logs) jobEntry.logs = [];

      if (!jobEntry.logger) {
        jobEntry.logger = (message: string | object) => {
          jobEntry.logs?.push({
            message: typeof message === 'string' ? message : JSON.stringify(message),
            timestamp: Date.now(),
          });
          this.#trimLogs(jobEntry);
        };
      }

      if (
        jobEntry.status !== 'processing' &&
        !jobEntry.logs.find((l: any) => l.message === this.JOB_STATUS_MESSAGES.processing)
      ) {
        jobEntry.logs.push({ message: this.JOB_STATUS_MESSAGES.processing, timestamp: Date.now() });
        this.#trimLogs(jobEntry);
      }

      const processingData = { ...jobEntry, lastRun: Date.now(), status: 'processing' };
      const oldKey = `queues:${queueName}:${jobId}:${jobEntry.status}`;
      const processingKey = `queues:${queueName}:${jobId}:processing`;

      await this.transitionState(oldKey, processingKey, JSON.stringify(processingData));

      const handlerCtx = {
        ...this.ctx,
        id: jobId,
        name: jobEntry.state.name!,
        queue: jobEntry.state.queue!,
        status: 'processing',
        retryCount: jobEntry.retryCount ?? 0,
        retriedAttempts: jobEntry.retriedAttempts ?? 0,
        data: jobEntry.state.data,
        logger: jobEntry.logger,
        emit: this.emit.bind(this),
        emitAsync: this.emitAsync.bind(this),
        socket: this.#createSocketContext(jobId, jobEntry.state.name!, jobEntry.state.queue!),
      };

      // Cron dedup lock — prevents double execution on restart recovery
      const cronPattern = jobEntry?.state?.options?.repeat?.pattern;
      if (cronPattern && jobEntry.repeatCount) {
        const cronExecLockKey = `queues:${queueName}:cron-exec:${jobId}:${jobEntry.delayUntil}`;
        const lockTtl = this.processorOptions?.jobStateTtlSeconds ?? 3600;
        const acquired = await this.db.set(cronExecLockKey, '1', 'EX', lockTtl, 'NX');
        if (!acquired) {
          await _ctx.ack();
          return;
        }
      }

      await handler(handlerCtx);

      const completedData = {
        ...processingData,
        logs: [
          ...(processingData.logs || []),
          { message: this.JOB_STATUS_MESSAGES.completed, timestamp: Date.now() },
        ],
        status: 'completed',
      };
      this.#trimLogs(completedData);

      const execId = genExecId();
      const completedKey = `queues:${queueName}:${jobId}:completed:${execId}`;
      await this.transitionState(processingKey, completedKey, JSON.stringify(completedData));

      this.#notifyJobFinished({ jobId, queue: queueName, status: 'completed' });

      await this.#scheduleCronNextTick(jobEntry, queueName);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const failedData = {
        ...jobEntry,
        status: 'failed',
        timestamp: Date.now(),
        errors: [{
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now(),
        }],
      };
      this.#trimLogs(failedData);

      const execId = genExecId();
      const failedKey = `queues:${queueName}:${jobEntry.id}:failed:${execId}`;
      const processingKey = `queues:${queueName}:${jobId}:processing`;
      await this.transitionState(processingKey, failedKey, JSON.stringify(failedData));

      const isConfigError = errorMessage.includes('No handler found') ||
        errorMessage.includes('No handlers registered') ||
        errorMessage.includes('is undefined');

      const willRetry = jobEntry.retryCount > 0 && !isConfigError;
      if (!willRetry) {
        this.#notifyJobFinished({ jobId: jobEntry.id, queue: queueName, status: 'failed', error: errorMessage });
      }

      await this.#scheduleCronNextTick(jobEntry, queueName);
      throw error;
    }
  }

  // ─── Cron scheduling ──────────────────────────────────────────────────────

  async #scheduleCronNextTick(
    jobEntry: Record<string, unknown>,
    queueName: string,
  ): Promise<void> {
    const state = jobEntry?.state as {
      name?: string;
      options?: { repeat?: { pattern?: string } };
    } | undefined;
    const pattern = state?.options?.repeat?.pattern;
    if (!jobEntry.repeatCount || !pattern) return;

    const cron = parseCronExpression(pattern);
    const nextRun = cron.getNextDate(new Date()).getTime();
    const lockKey = `queues:${queueName}:cron-lock:${state?.name ?? ''}`;
    const intervalMs = nextRun - Date.now();
    const lockTtl = Math.max(1, Math.ceil(intervalMs * 0.9 / 1000));

    const locked = await this.db.set(lockKey, '1', 'EX', lockTtl, 'NX');
    if (!locked) return;

    const nextJobData = {
      ...jobEntry,
      lockUntil: nextRun,
      delayUntil: nextRun,
      repeatCount: jobEntry.repeatCount,
      timestamp: Date.now(),
      status: 'delayed',
      lastRun: Date.now(),
    };

    const jobId = (jobEntry.id ?? '') as string;
    const stateKey = `queues:${queueName}:${jobId}:delayed`;
    const score = nextRun - ((jobEntry.priority as number) ?? 0);

    await this.#setJobState(stateKey, JSON.stringify(nextJobData));
    await this.queueStore.enqueue(queueName, jobId, score);
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  #createSocketContext(id: string, event: string, queue: string): JobSocketContext {
    if (this.expose == null) {
      return {
        update: () => {
          throw new Error('ctx.socket.update() requires Hound to be started with expose option.');
        },
      };
    }
    return {
      update: (data: unknown, progress?: number) =>
        this.#sendJobUpdate({ id, event, queue, data, progress: progress ?? 0 }),
    };
  }

  #getSocketsForJob(jobId: string): Set<WebSocket> {
    const out = new Set<WebSocket>(this.jobIdToSockets.get(jobId) ?? []);
    for (const ws of this.broadcastSockets) {
      if (ws.readyState === WebSocket.OPEN) out.add(ws);
    }
    return out;
  }

  #sendJobUpdate({ id, event, queue, data, progress }: {
    id: string; event: string; queue: string; data: unknown; progress: number;
  }): void {
    const sockets = this.#getSocketsForJob(id);
    if (!sockets.size) return;
    const payloadStr = JSON.stringify({ type: 'job_update', id, event, queue, data, progress });
    for (const socket of sockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(payloadStr);
      } catch (err) {
        console.error(' WS send job_update error:', err);
      }
    }
  }

  #handleWsConnection(ws: WebSocket, req: Request): void {
    const wantBroadcast = req.headers.get('x-get-broadcast')?.toLowerCase() === 'true';
    if (wantBroadcast) this.broadcastSockets.add(ws);

    const addJobForSocket = (jobId: string) => {
      if (!this.socketToJobIds.has(ws)) this.socketToJobIds.set(ws, new Set());
      this.socketToJobIds.get(ws)!.add(jobId);
      if (!this.jobIdToSockets.has(jobId)) this.jobIdToSockets.set(jobId, new Set());
      this.jobIdToSockets.get(jobId)!.add(ws);
    };

    const removeSocket = () => {
      this.broadcastSockets.delete(ws);
      const jobIds = this.socketToJobIds.get(ws);
      if (jobIds) {
        for (const jobId of jobIds) {
          this.jobIdToSockets.get(jobId)?.delete(ws);
          if (this.jobIdToSockets.get(jobId)?.size === 0) {
            this.jobIdToSockets.delete(jobId);
          }
        }
        this.socketToJobIds.delete(ws);
      }
    };

    ws.addEventListener('close', removeSocket);
    ws.addEventListener('message', (event) => {
      try {
        const raw = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(raw) as {
          type?: string;
          event?: string;
          queue?: string;
          data?: unknown;
          options?: Record<string, unknown>;
        };
        if (typeof msg?.event === 'string') {
          const jobId = this.emit(msg.event, msg.data, {
            queue: msg.queue,
            ...msg.options,
          } as EmitOptions);
          addJobForSocket(jobId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'queued', jobId }));
          }
        }
      } catch (_) {
        // ignore parse errors
      }
    });
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  #setupGracefulShutdown(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    const shutdown = async (signal: string) => {
      debug(`Received ${signal}, shutting down gracefully...`);
      await Promise.race([this.stop(), new Promise<void>((r) => setTimeout(r, 3000))]);
      // Disconnect Redis so the ioredis TCP socket doesn't keep the event loop alive.
      // After this, the event loop drains naturally and the process exits on its own —
      // which is what the Deno watcher expects to trigger a restart.
      try { this.db.disconnect(); } catch { /* ignore */ }
      debug('Shutdown complete');
      // SIGINT = user pressed Ctrl+C → force exit immediately.
      // SIGTERM = watcher restart or Docker stop → let event loop drain so watcher can restart.
      if (signal === 'SIGINT') {
        if (typeof Deno !== 'undefined') {
          // @ts-ignore
          Deno.exit(0);
        } else if (typeof process !== 'undefined') {
          // @ts-ignore
          process.exit(0);
        }
      }
    };

    if (typeof Deno !== 'undefined') {
      // @ts-ignore
      Deno.addSignalListener('SIGINT', () => shutdown('SIGINT'));
      // @ts-ignore
      Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM'));
    } else if (typeof process !== 'undefined') {
      // @ts-ignore
      process.on('SIGINT', () => shutdown('SIGINT'));
      // @ts-ignore
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    }
  }
}
