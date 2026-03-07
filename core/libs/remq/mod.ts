/**
 * Remq — high-level public API for job management (singleton lifecycle, handlers, emit, start/stop).
 * Built on Processor → Consumer → StreamReader.
 *
 * @module
 */
import { Redis } from 'ioredis';
import { Processor } from '../processor/processor.ts';
import { DebounceManager } from '../processor/debounce-manager.ts';
import { createWsGateway } from '../gateways/ws.gateway.ts';
import type {
  EmitAsyncFunction,
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  JobData,
  JobDefinition,
  JobHandler,
  JobManagerOptions,
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

/** Re-exported option and handler types for Remq (EmitOptions, JobContext, JobHandler, etc.). */
export type {
  EmitAsyncFunction,
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  JobContext,
  JobDefinition,
  JobHandler,
  JobManagerOptions,
} from '../../types/index.ts';

/** Symbol for internal subscription. Not part of public API. */
export const SUBSCRIBE_JOB_FINISHED = Symbol.for('remq.subscribeJobFinished');

/**
 * Main Remq instance: register handlers with on(), enqueue jobs with emit()/emitAsync(), then start().
 * Use Remq.create() once; getInstance() thereafter.
 */
export class Remq<
  TApp extends Record<string, unknown> = Record<string, unknown>,
> {
  private static instance: Remq<any>;

  private readonly db: RedisConnection;
  private readonly streamdb: RedisConnection;
  private readonly ctx: TApp & {
    emit: EmitFunction;
    emitAsync: EmitAsyncFunction;
  };
  private readonly concurrency: number;
  private readonly processorOptions: JobManagerOptions<TApp>['processor'];
  private readonly debug: boolean;

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
  private queueStreams: Set<string> = new Set();
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
  #workerRunIndex = 0;

  private readonly JOB_STATUS_MESSAGES = {
    processing: 'Job execution started',
    completed: 'Job completed successfully',
    delayed: (date: string) => `Job delayed until ${date}`,
    waiting: 'Job queued and waiting to be processed',
    failed: (error: string) => `Job failed: ${error}`,
  };

  /**
   * Create a Remq instance. Use Remq.create() instead of calling this directly.
   * @param options - DB connections, concurrency, optional ctx and expose
   */
  private constructor(options: JobManagerOptions<TApp>) {
    this.db = options.db;

    if (options.streamdb) {
      this.streamdb = options.streamdb;
    } else if (options.redis) {
      const streamDbIndex = (options.redis.db ?? 0) + 1;
      if (streamDbIndex > 15) {
        console.warn(
          `[remq] stream connection on db ${streamDbIndex} — Redis default max is 15. ` +
            'Increase "databases" in redis.conf or pass streamdb explicitly.',
        );
      }
      this.streamdb = new Redis({
        ...options.redis,
        db: streamDbIndex,
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
      });
      console.log(
        `[remq] stream connection auto-created on db ${streamDbIndex}`,
      );
    } else {
      this.streamdb = this.db;
      console.warn(
        '[remq] streamdb/redis not provided — reusing db connection for streams. ' +
          'XREADGROUP BLOCK can stall admin queries. Pass streamdb or redis to avoid this.',
      );
    }

    this.concurrency = options.concurrency ?? 1;
    this.processorOptions = options.processor || {};
    this.debug = options.debug ?? false;

    this.ctx = {
      ...(options.ctx || {} as TApp),
      emit: this.emit.bind(this),
      emitAsync: this.emitAsync.bind(this),
    } as TApp & { emit: EmitFunction; emitAsync: EmitAsyncFunction };

    this.expose = options.expose;
  }

  /**
   * Create the singleton Remq instance. Call once at app startup; use getInstance() elsewhere.
   * @param options - DB connections, concurrency, optional ctx and expose port
   * @returns The singleton Remq instance
   * @throws If called more than once (use getInstance() for subsequent access)
   */
  static create<TApp extends Record<string, unknown> = Record<string, unknown>>(
    options: JobManagerOptions<TApp>,
  ): Remq<TApp> {
    if (Remq.instance) {
      throw new Error(
        '[remq] Remq.create() called more than once. Use Remq.getInstance().',
      );
    }
    Remq.instance = new Remq(options);
    return Remq.instance as Remq<TApp>;
  }

  /** Reset singleton — test use only. */
  static _reset(): void {
    Remq.instance = undefined as any;
  }

  /**
   * Return the existing Remq singleton. Must call create() first.
   * @returns The singleton Remq instance
   */
  static getInstance<
    TApp extends Record<string, unknown> = Record<string, unknown>,
  >(): Remq<TApp> {
    return Remq.instance as Remq<TApp>;
  }

  // ─── Handler registration ─────────────────────────────────────────────────

  /**
   * Register a handler for an event.
   * Accepts either (event, handler, options?) or a JobDefinition from defineJob().
   * Returns this for fluent chaining.
   */
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
    this.queueStreams.add(`${queue}-stream`);

    // Debounce setup
    if (opts?.debounce !== undefined) {
      const debounceSeconds = Math.ceil(opts.debounce / 1000);
      this.handlerDebounce.set(
        handlerKey,
        new DebounceManager(debounceSeconds, undefined),
      );
    }

    // Cron registration — deferred to start() for dedup check
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

  /**
   * Build job payload. Returns [jobId, streamKey, stateKey, dataJson].
   * Pure function — no Redis writes. Caller decides write strategy.
   */
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

    let delayUntil = opts.delay ?? new Date();
    if (opts.delay) {
      delayUntil = opts.delay; // explicit delay takes precedence
    } else if (opts.repeat?.pattern) {
      delayUntil = parseCronExpression(opts.repeat.pattern).getNextDate(
        new Date(),
      );
    }

    const jobData: JobData = {
      id: jobId,
      state: {
        name: event,
        queue,
        data: payload,
        options: opts,
      },
      status: opts.repeat?.pattern ? 'delayed' : 'waiting',
      delayUntil: delayUntil instanceof Date
        ? delayUntil.getTime()
        : delayUntil,
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

    const streamKey = `${queue}-stream`;
    const stateKey = `queues:${queue}:${jobId}:${jobData.status}`;
    const dataJson = JSON.stringify(jobData);

    return [jobId, streamKey, stateKey, dataJson];
  }

  /**
   * Fire-and-forget emit. Returns jobId immediately.
   * State key written first, stream entry written after state lands.
   * If state write fails, stream write is skipped — dedup catches on restart.
   */
  emit(event: string, data?: unknown, options?: EmitOptions): string {
    const [jobId, streamKey, stateKey, dataJson] = this.#buildPayload(
      event,
      data,
      options,
    );

    // State first, then stream — chained so order is guaranteed
    this.#setJobState(stateKey, dataJson)
      .then(() => this.#xadd(streamKey, dataJson))
      .catch((err: unknown) => {
        console.error(`[remq] emit failed for ${event}:`, err);
      });

    return jobId;
  }

  /**
   * Awaitable emit. Resolves when both state key and stream entry are written.
   * Use for critical jobs where you need confirmation before returning to caller.
   */
  async emitAsync(
    event: string,
    data?: unknown,
    options?: EmitOptions,
  ): Promise<string> {
    const [jobId, streamKey, stateKey, dataJson] = this.#buildPayload(
      event,
      data,
      options,
    );

    // State first, then stream
    await this.#setJobState(stateKey, dataJson);
    await this.#xadd(streamKey, dataJson);

    return jobId;
  }

  /**
   * Enqueue an existing job payload directly to stream (no state write).
   * Used by RemqAdmin.promoteJob.
   */
  async enqueueJobToStream(
    queue: string,
    jobPayload: Record<string, unknown>,
  ): Promise<void> {
    await this.#xadd(`${queue}-stream`, JSON.stringify(jobPayload));
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
        console.error('[remq] jobFinished listener error:', err);
      }
    }
  }

  // ─── Redis primitives ─────────────────────────────────────────────────────

  async #xadd(streamKey: string, dataJson: string): Promise<string | null> {
    return await this.streamdb.xadd(streamKey, '*', 'data', dataJson);
  }

  async #setJobState(key: string, value: string): Promise<void> {
    const ttl = this.processorOptions?.jobStateTtlSeconds;
    if (typeof ttl === 'number' && ttl > 0) {
      await this.db.set(key, value, 'EX', ttl);
    } else {
      await this.db.set(key, value);
    }
  }

  /**
   * Pipeline DEL old key + SET new key in one round trip.
   * Used for state transitions: waiting→processing, processing→completed/failed.
   * Safe to pipeline — message is in PEL so no other consumer can claim it.
   */
  private async transitionState(
    delKey: string,
    setKey: string,
    value: string,
  ): Promise<void> {
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

  /**
   * Start the processor: ensure consumer groups, run cron dedup/cleanup, create processor,
   * and optionally start the WebSocket gateway if expose was set. Idempotent.
   */
  async start(): Promise<void> {
    if (this.isStarted) return;

    // Ensure consumer groups exist
    for (const streamKey of this.queueStreams) {
      await this.#ensureConsumerGroup(streamKey);
    }

    if (this.processor) {
      this.processor.stop();
      await this.drain();
    }

    // Cron dedup + stream cleanup
    // Stream entry is the liveness authority — emit only if stream entry missing
    for (const [, { event, queue, repeat, attempts }] of this.pendingCronJobs) {
      //   const cronLock = await this.db.del(`queues:${queue}:cron-lock:${event}`);
      //   console.log(`[remq] cron lock deleted for ${event}:`, cronLock);
      const jobId = genJobIdSync(event, {});
      const streamKey = `${queue}-stream`;

      // Scan stream for existing entry for this cron
      const streamEntries = await this.streamdb.xrange(
        streamKey,
        '-',
        '+',
      ) as [string, string[]][];

      const matchingEntries = streamEntries.filter(([, fields]) => {
        try {
          const dataIndex = fields.indexOf('data');
          if (dataIndex === -1) return false;
          const parsed = JSON.parse(fields[dataIndex + 1]);
          return parsed.id === jobId &&
            (parsed.status === 'delayed' || parsed.status === 'waiting');
        } catch {
          return false;
        }
      });

      console.log(
        `[remq] matching entries for ${event}:`,
        matchingEntries.length,
      );

      // Remove duplicates — keep only highest stream ID (freshest delayUntil)
      if (matchingEntries.length > 1) {
        const [, ...toDelete] = [...matchingEntries].reverse();
        const idsToDelete = toDelete.map(([id]) => id);
        await this.streamdb.xdel(streamKey, ...idsToDelete);
        console.log(
          `[remq] removed ${idsToDelete.length} duplicate stream entries for ${event}`,
        );
      }

      // Emit only if no stream entry exists
      if (matchingEntries.length >= 1) {
        const idsToDelete = matchingEntries.map(([id]) => id);
        // console.log(idsToDelete);
        await this.streamdb.xdel(streamKey, ...idsToDelete);
        // then re-emit with old delayUntil

        // Re-emit with original delayUntil preserved
        const [, fields] = matchingEntries[matchingEntries.length - 1]; // freshest entry
        const dataIndex = fields.indexOf('data');
        const existingJob = JSON.parse(fields[dataIndex + 1]);

        // Emit with original delayUntil — same schedule, fresh stream ID
        await this.emitAsync(event, {}, {
          queue,
          repeat,
          attempts,
          delay: new Date(existingJob.delayUntil),
        });
      } else {
        // first boot — no existing entry, emit fresh
        await this.emitAsync(event, {}, { queue, repeat, attempts });
      }
    }

    this.#createUnifiedProcessor();

    if (this.processor) {
      this.processor.start().catch((err) => {
        console.error('[remq] Error starting processor:', err);
      });
    }

    this.isStarted = true;
    this.#setupGracefulShutdown();

    if (this.expose != null) {
      this.wsServer = createWsGateway({
        port: this.expose,
        hostname: '0.0.0.0',
        remq: this,
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
            console.error('[remq] WS send job_finished error:', err);
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
      console.log(`Remq WS gateway listening on 0.0.0.0:${this.expose}`);
    }

    const streamList = Array.from(this.queueStreams).join(', ');
    console.log(
      `Remq started with ${this.queueStreams.size} queue(s) [${streamList}] and concurrency ${this.concurrency}`,
    );
  }

  // ─── Stop / drain ─────────────────────────────────────────────────────────

  /**
   * Stop the processor, close WebSocket gateway, and drain active jobs. Cleans up job-finished
   * listeners and socket maps. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    this.#jobFinishedUnsubscribe?.();
    this.#jobFinishedUnsubscribe = undefined;
    this.broadcastSockets.clear();
    this.jobIdToSockets.clear();
    this.socketToJobIds.clear();

    if (this.wsServer) {
      await this.wsServer.shutdown();
      this.wsServer = undefined;
    }

    if (this.processor) {
      this.processor.stop();
      await this.drain();
    }

    this.isStarted = false;
  }

  /**
   * Wait for all currently processing jobs to finish. Use after stop() to shut down gracefully.
   */
  async drain(): Promise<void> {
    if (this.processor) {
      await this.processor.waitForActiveJobs();
    }
  }

  // ─── Processor creation ───────────────────────────────────────────────────

  #createUnifiedProcessor(): void {
    const allStreamKeys = Array.from(this.queueStreams);

    // Build stream priority map from processor options
    // User passes queue names (e.g. 'payments'), we map to stream keys ('payments-stream')
    const streamPriority: Record<string, number> = {};
    const userPriority = this.processorOptions?.streamPriority ?? {};
    for (const [queue, priority] of Object.entries(userPriority)) {
      streamPriority[`${queue}-stream`] = priority;
    }

    const unifiedHandler = async (
      message: Message,
      ctx: MessageContext,
    ): Promise<void> => {
      const msg = message as unknown as ProcessableMessage;
      const jobData = msg.data;

      if (!jobData?.state?.name || !jobData?.state?.queue) {
        throw new Error(
          '[remq] Invalid job data: missing state.name or state.queue',
        );
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

      // Queue paused — leave in PEL, don't ACK
      if (isPaused === 'true') return;

      if (jobStatusData) {
        try {
          const parsed = JSON.parse(jobStatusData) as {
            status?: string;
            paused?: boolean;
          };
          // Skip already terminal jobs
          if (parsed.status === 'completed' || parsed.status === 'failed') {
            await ctx.ack();
            return;
          }
          // Job paused — leave in PEL, don't ACK
          if (parsed.paused === true) return;
        } catch {
          // Unparseable state — continue processing
        }
      }

      const handler = this.handlers.get(handlerKey);
      if (!handler) {
        throw new Error(
          `[remq] No handler for queue: ${queueName}, event: ${jobName}. ` +
            `Registered: ${Array.from(this.handlers.keys()).join(', ')}`,
        );
      }

      // Per-handler debounce
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
        streams: allStreamKeys,
        streamdb: this.streamdb,
        handler: unifiedHandler,
        concurrency: this.concurrency,
        group: 'processor',
        pollIntervalMs: this.processorOptions?.pollIntervalMs,
        visibilityTimeoutMs: this.processorOptions?.visibilityTimeoutMs,
        streamPriority,
        read: {
          count: this.processorOptions?.read?.count ??
            this.processorOptions?.readCount ?? 200,
          blockMs: this.processorOptions?.read?.blockMs,
        },
      },
      streamdb: this.streamdb,
      ...this.processorOptions,
    });
  }

  // ─── Job processing ───────────────────────────────────────────────────────

  /**
   * Process a single job.
   *
   * State transitions (audit only — ACK is owned by processor.ts):
   *   waiting/delayed → processing  (round trip 1: transitionState pipeline)
   *   processing → completed        (round trip 2: transitionState pipeline)
   *   processing → failed:execId    (round trip 2: transitionState pipeline)
   *
   * On success: notifies job finished, schedules next cron tick
   * On failure: writes failed state, notifies job finished, re-throws for processor
   */
  async #processJob(
    jobEntry: any,
    jobId: string,
    queueName: string,
    handler: JobHandler<TApp, any>,
    _ctx: MessageContext,
  ): Promise<void> {
    const maxLogsPerJob = this.processorOptions?.maxLogsPerJob;

    try {
      if (!jobEntry.logs) jobEntry.logs = [];

      // Sync logger — in-memory only, no Redis write per log entry
      if (!jobEntry.logger) {
        jobEntry.logger = (message: string | object) => {
          jobEntry.logs?.push({
            message: typeof message === 'string'
              ? message
              : JSON.stringify(message),
            timestamp: Date.now(),
          });
          this.#trimLogs(jobEntry);
        };
      }

      // Add processing log
      if (
        jobEntry.status !== 'processing' &&
        !jobEntry.logs.find((l: any) =>
          l.message === this.JOB_STATUS_MESSAGES.processing
        )
      ) {
        jobEntry.logs.push({
          message: this.JOB_STATUS_MESSAGES.processing,
          timestamp: Date.now(),
        });
        this.#trimLogs(jobEntry);
      }

      const processingData = {
        ...jobEntry,
        lastRun: Date.now(),
        status: 'processing',
      };

      const oldKey = `queues:${queueName}:${jobId}:${jobEntry.status}`;
      const processingKey = `queues:${queueName}:${jobId}:processing`;

      // Round trip 1: waiting/delayed → processing
      await this.transitionState(
        oldKey,
        processingKey,
        JSON.stringify(processingData),
      );

      if (this.debug) {
        const pid = typeof Deno !== 'undefined' && Deno.pid != null
          ? Deno.pid
          : (typeof process !== 'undefined' &&
            (process as { pid?: number }).pid) ?? '?';
        const workerId = this.#workerRunIndex++ % this.concurrency;
        console.log('[remq] PID', pid, 'worker_id', workerId, 'job_id', jobId);
      }

      // Build handler context
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
        socket: this.#createSocketContext(
          jobId,
          jobEntry.state.name!,
          jobEntry.state.queue!,
        ),
      };

      await handler(handlerCtx);

      // Build completed blob from in-memory data — no db.get needed
      const completedData = {
        ...processingData,
        logs: [
          ...(processingData.logs || []),
          {
            message: this.JOB_STATUS_MESSAGES.completed,
            timestamp: Date.now(),
          },
        ],
        status: 'completed',
      };
      this.#trimLogs(completedData);

      const execId = genExecId();
      const completedKey = `queues:${queueName}:${jobId}:completed:${execId}`;

      // Round trip 2: processing → completed
      await this.transitionState(
        processingKey,
        completedKey,
        JSON.stringify(completedData),
      );

      this.#notifyJobFinished({ jobId, queue: queueName, status: 'completed' });

      // Schedule next cron tick
      await this.#scheduleCronNextTick(jobEntry, queueName);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

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

      // Round trip 2: processing → failed:execId
      await this.transitionState(
        processingKey,
        failedKey,
        JSON.stringify(failedData),
      );

      const isConfigError = errorMessage.includes('No handler found') ||
        errorMessage.includes('No handlers registered') ||
        errorMessage.includes('is undefined');

      const willRetry = jobEntry.retryCount > 0 && !isConfigError;

      if (!willRetry) {
        this.#notifyJobFinished({
          jobId: jobEntry.id,
          queue: queueName,
          status: 'failed',
          error: errorMessage,
        });
      }

      // Reschedule cron regardless of failure — cron must never die on error
      await this.#scheduleCronNextTick(jobEntry, queueName);

      // Re-throw — processor.ts handles retry/DLQ/NACK
      throw error;
    }
  }

  // ─── Cron scheduling ──────────────────────────────────────────────────────

  /**
   * Schedule the next cron tick after a job completes (success or failure).
   *
   * Uses NX lock to prevent duplicate scheduling in multi-instance deployments.
   * Lock TTL = 90% of cron interval — expires before next tick fires.
   * Writes state key (delayed) before stream entry — dedup reads state on restart.
   */
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

    const nextJobJson = JSON.stringify(nextJobData);
    const jobId = (jobEntry.id ?? '') as string;
    const stateKey = `queues:${queueName}:${jobId}:delayed`;

    // State key first, then stream — dedup check reads state on restart
    await this.#setJobState(stateKey, nextJobJson);
    await this.#xadd(`${queueName}-stream`, nextJobJson);
  }

  // ─── Consumer group ───────────────────────────────────────────────────────

  async #ensureConsumerGroup(streamKey: string): Promise<void> {
    try {
      await this.streamdb.xgroup(
        'CREATE',
        streamKey,
        'processor',
        '0',
        'MKSTREAM',
      );
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (err?.message?.includes('BUSYGROUP')) return;
      throw error;
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  #createSocketContext(
    id: string,
    event: string,
    queue: string,
  ): JobSocketContext {
    if (this.expose == null) {
      return {
        update: () => {
          throw new Error(
            'ctx.socket.update() requires Remq to be started with expose option.',
          );
        },
      };
    }
    return {
      update: (data: unknown, progress?: number) =>
        this.#sendJobUpdate({
          id,
          event,
          queue,
          data,
          progress: progress ?? 0,
        }),
    };
  }

  #getSocketsForJob(jobId: string): Set<WebSocket> {
    const out = new Set<WebSocket>(this.jobIdToSockets.get(jobId) ?? []);
    for (const ws of this.broadcastSockets) {
      if (ws.readyState === WebSocket.OPEN) out.add(ws);
    }
    return out;
  }

  #sendJobUpdate({
    id,
    event,
    queue,
    data,
    progress,
  }: {
    id: string;
    event: string;
    queue: string;
    data: unknown;
    progress: number;
  }): void {
    const sockets = this.#getSocketsForJob(id);
    if (!sockets.size) return;
    const payloadStr = JSON.stringify({
      type: 'job_update',
      id,
      event,
      queue,
      data,
      progress,
    });
    for (const socket of sockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(payloadStr);
      } catch (err) {
        console.error('[remq] WS send job_update error:', err);
      }
    }
  }

  #sendJobRetry({
    id,
    event,
    queue,
    error,
    retryCount,
    retryDelayMs,
  }: {
    id: string;
    event: string;
    queue: string;
    error: string;
    retryCount: number;
    retryDelayMs: number;
  }): void {
    const sockets = this.#getSocketsForJob(id);
    if (!sockets.size) return;
    const payloadStr = JSON.stringify({
      type: 'job_retry',
      jobId: id,
      event,
      queue,
      error,
      retryCount,
      retryDelayMs,
    });
    for (const socket of sockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(payloadStr);
      } catch (err) {
        console.error('[remq] WS send job_retry error:', err);
      }
    }
  }

  #handleWsConnection(ws: WebSocket, req: Request): void {
    const wantBroadcast =
      req.headers.get('x-get-broadcast')?.toLowerCase() === 'true';
    if (wantBroadcast) this.broadcastSockets.add(ws);

    const addJobForSocket = (jobId: string) => {
      if (!this.socketToJobIds.has(ws)) this.socketToJobIds.set(ws, new Set());
      this.socketToJobIds.get(ws)!.add(jobId);
      if (!this.jobIdToSockets.has(jobId)) {
        this.jobIdToSockets.set(jobId, new Set());
      }
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
      console.log(`Received ${signal}, shutting down gracefully...`);
      await this.stop();
      console.log('Shutdown complete');
      if (typeof Deno !== 'undefined') {
        // @ts-ignore
        Deno.exit(0);
      } else if (typeof process !== 'undefined') {
        // @ts-ignore
        process.exit(0);
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
