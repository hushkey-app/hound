/**
 * Remq - High-level API for job management
 *
 * Simple, developer-friendly API built on top of Consumer + Processor
 */

// export { Remq, SUBSCRIBE_Job_FINISHED } from './remq.ts';

import { Redis } from 'ioredis';
import { Processor } from '../processor/processor.ts';
import { DebounceManager } from '../processor/debounce-manager.ts';
import { createWsGateway } from '../gateways/ws.gateway.ts';
import type {
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  JobDefinition,
  JobHandler,
  JobManagerOptions,
  JobSocketContext,
  Message,
  MessageContext,
  ProcessableMessage,
  RedisConnection,
} from '../../types/index.ts';
import { genJobIdSync } from './utils.ts';
import { parseCronExpression } from 'cron-schedule';

export type {
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  JobContext,
  JobDefinition,
  JobHandler,
  JobManagerOptions,
} from '../../types/remq.ts';

/** Symbol for internal subscription (Sdk only). Not part of public API. */
export const SUBSCRIBE_JOB_FINISHED = Symbol.for('remq.subscribeJobFinished');

/**
 * Remq - High-level API for managing Jobs/jobs
 *
 * Based on old worker's robust processJob logic with cleaner naming
 */
export class Remq<
  TApp extends Record<string, unknown> = Record<string, unknown>,
> {
  private static instance: Remq<any>;

  private readonly db: RedisConnection;
  private readonly streamdb: RedisConnection;
  private readonly ctx: TApp & { emit: EmitFunction };
  private readonly concurrency: number;
  private readonly processorOptions: JobManagerOptions<TApp>['processor'];
  private readonly debug: boolean;

  private handlers: Map<string, JobHandler<TApp, any>> = new Map();
  private handlerDebounce: Map<string, DebounceManager> = new Map(); // handlerKey -> DebounceManager
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
  private readonly expose?: number;
  private wsServer?: ReturnType<typeof createWsGateway>;
  /** Sockets that requested broadcast via header x-get-broadcast: true */
  private readonly broadcastSockets = new Set<WebSocket>();
  readonly #jobFinishedListeners = new Set<
    (
      payload: {
        jobId: string;
        queue: string;
        status: 'completed' | 'failed';
        error?: string;
      },
    ) => void
  >();
  #jobFinishedUnsubscribe?: () => void;
  private readonly jobIdToSockets = new Map<string, Set<WebSocket>>();
  private readonly socketToJobIds = new Map<WebSocket, Set<string>>();
  #workerRunIndex = 0; // used for debug log worker_id (0..concurrency-1)

  // Job status messages (like old worker line 71-80)
  private readonly JOB_STATUS_MESSAGES = {
    processing: 'Job execution started',
    completed: 'Job completed successfully',
    delayed: (date: string) => `Job delayed until ${date}`,
    waiting: 'Job queued and waiting to be processed',
    failed: (error: string) => `Job failed: ${error}`,
  };

  private constructor(options: JobManagerOptions<TApp>) {
    this.db = options.db;
    if (options.streamdb) {
      this.streamdb = options.streamdb;
    } else if (options.redis) {
      // Auto-create dedicated stream connection on db+1.
      // XREADGROUP BLOCK holds the connection for up to blockMs — if shared with
      // db, all admin queries (SCAN, GET) queue behind the block. Separate
      // connection prevents this entirely.
      const streamDbIndex = (options.redis.db ?? 0) + 1;
      if (streamDbIndex > 15) {
        console.warn(
          `[remq] stream connection on db ${streamDbIndex} — Redis default max is 15 (db 0-15). ` +
            'Increase "databases" in redis.conf or pass streamdb explicitly.',
        );
      }
      this.streamdb = new Redis({
        ...options.redis,
        db: streamDbIndex,
        // stream connection never needs ready check — MKSTREAM handles missing keys
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
      });
      console.log(
        `[remq] stream connection auto-created on db ${streamDbIndex}`,
      );
    } else {
      // Backwards-compatible fallback: reuse db connection for streams.
      // This can cause XREADGROUP BLOCK to stall admin queries; prefer passing
      // streamdb or redis so Remq can use a dedicated connection.
      this.streamdb = this.db;
      console.warn(
        '[remq] streamdb/redis not provided; reusing db connection for stream operations. ' +
          'This preserves backwards compatibility but XREADGROUP BLOCK can stall admin queries. ' +
          'Pass streamdb (dedicated Redis connection) or redis (connection config) to avoid this.',
      );
    }
    this.concurrency = options.concurrency ?? 1;
    this.processorOptions = options.processor || {};
    this.debug = options.debug ?? false;

    this.ctx = {
      ...(options.ctx || {} as TApp),
      emit: this.emit.bind(this),
    } as TApp & { emit: EmitFunction };
    this.expose = options.expose;
  }

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

  /** Reset singleton for tests. Not part of public API. */
  static _reset(): void {
    Remq.instance = undefined as any;
  }

  static getInstance<
    TApp extends Record<string, unknown> = Record<string, unknown>,
  >(): Remq<TApp> {
    return Remq.instance as Remq<TApp>;
  }

  /**
   * Register a handler for an event/job. Event names support dot notation (e.g. 'host.sync', 'user.welcome').
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
      const def = eventOrDefinition;
      event = def.event;
      h = def.handler;
      opts = def.options;
    } else {
      event = eventOrDefinition;
      h = handler!;
      opts = options;
    }

    const queue = opts?.queue ?? 'default';
    const debounce = opts?.debounce;

    if (!event) {
      throw new Error('event is required');
    }

    if (!h) {
      throw new Error('handler is required');
    }

    const handlerKey = `${queue}:${event}`;
    this.handlers.set(handlerKey, h as JobHandler<TApp, any>);

    const streamKey = `${queue}-stream`;
    this.queueStreams.add(streamKey);

    if (debounce !== undefined) {
      const debounceSeconds = Math.ceil(debounce / 1000);
      const debounceManager = new DebounceManager(debounceSeconds, undefined);
      this.handlerDebounce.set(handlerKey, debounceManager);
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

  /**
   * Build job payload and optionally write to Redis. Returns [jobId, streamKey, stateKey, dataJson].
   */
  #buildAndWrite(
    event: string,
    data?: unknown,
    options?: EmitOptions,
    dryRun = false,
  ): [string, string, string, string] {
    const opts = options ?? {};
    const queue = opts.queue ?? 'default';
    const payload = data ?? {};

    if (!event) {
      throw new Error('event is required');
    }

    const jobId = opts.id ?? genJobIdSync(event, payload);

    let delayUntil = opts.delay ?? new Date();
    if (opts.repeat?.pattern) {
      delayUntil = parseCronExpression(opts.repeat.pattern).getNextDate(
        new Date(),
      );
    }

    const jobData = {
      id: jobId,
      state: {
        name: event,
        queue,
        data: payload,
        options: opts,
      },
      status: opts.repeat?.pattern ? 'delayed' : 'waiting',
      delayUntil: delayUntil.getTime(),
      lockUntil: Date.now(),
      priority: opts.priority ?? 0,
      retryCount: opts.retryCount ?? (opts.attempts ?? 0),
      retryDelayMs: opts.retryDelayMs ?? 1000,
      retriedAttempts: 0,
      repeatCount: opts.repeat?.pattern ? 1 : 0,
      repeatDelayMs: 0,
      logs: [{
        message: 'Added to the queue',
        timestamp: Date.now(),
      }],
      errors: [],
      timestamp: Date.now(),
    };

    const streamKey = `${queue}-stream`;
    const stateKey = `queues:${queue}:${jobId}:${jobData.status}`;
    const dataJson = JSON.stringify(jobData);

    if (!dryRun) {
      this.#xadd(streamKey, dataJson).catch((err: unknown) => {
        console.error(`Error emitting job to queue ${queue}:`, err);
      });
      this.#setJobState(stateKey, dataJson).catch((err: unknown) => {
        console.error(`Error storing job state:`, err);
      });
    }
    return [jobId, streamKey, stateKey, dataJson];
  }

  /**
   * Emit/trigger a job/event. Returns the job id so callers can track completion.
   */
  emit(event: string, data?: unknown, options?: EmitOptions): string {
    const [jobId] = this.#buildAndWrite(event, data, options);
    return jobId;
  }

  /**
   * Like emit() but waits for Redis writes to complete. Returns the job id.
   */
  async emitAsync(
    event: string,
    data?: unknown,
    options?: EmitOptions,
  ): Promise<string> {
    const [jobId, streamKey, stateKey, dataJson] = this.#buildAndWrite(
      event,
      data,
      options,
      true,
    );
    await Promise.all([
      this.#xadd(streamKey, dataJson),
      this.#setJobState(stateKey, dataJson),
    ]);
    return jobId;
  }

  /**
   * Enqueue an existing job payload to the queue stream (no state write).
   * Used by RemqAdmin.promoteJob to push a promoted job so the processor picks it up immediately.
   */
  async enqueueJobToStream(
    queue: string,
    jobPayload: Record<string, unknown>,
  ): Promise<void> {
    await this.#xadd(
      `${queue}-stream`,
      JSON.stringify(jobPayload),
    );
  }

  /** Internal: use RemqAdmin.onJobFinished() for public API. Keyed by symbol so not in public surface. */
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
        console.error('jobFinished listener error:', err);
      }
    }
  }

  /**
   * Add entry to stream. No MAXLEN at emit time — trimming is done after ACK
   * in the consumer using MINID so we never drop unprocessed jobs.
   */
  async #xadd(streamKey: string, dataJson: string): Promise<string | null> {
    return await this.streamdb.xadd(streamKey, '*', 'data', dataJson);
  }

  /**
   * Set a job state key with optional TTL to prevent unbounded Redis key growth.
   */
  async #setJobState(key: string, value: string): Promise<void> {
    const ttl = this.processorOptions?.jobStateTtlSeconds;
    if (typeof ttl === 'number' && ttl > 0) {
      await this.db.set(key, value, 'EX', ttl);
    } else {
      await this.db.set(key, value);
    }
  }

  /**
   * Trim oldest log entries when maxLogsPerJob is set (self-cleaning).
   */
  #trimLogs(
    jobEntry: { logs?: unknown[] },
    maxLogsPerJob: number | undefined,
  ): void {
    if (
      typeof maxLogsPerJob !== 'number' ||
      maxLogsPerJob <= 0 ||
      !jobEntry.logs?.length ||
      jobEntry.logs.length <= maxLogsPerJob
    ) return;
    const excess = jobEntry.logs.length - maxLogsPerJob;
    jobEntry.logs.splice(0, excess);
  }

  /**
   * Schedule the next cron tick (success or failure). Uses Redis lock so only one instance schedules.
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
    const lockTtl = Math.max(
      1,
      Math.ceil((nextRun - Date.now() + 10000) / 1000),
    );
    const locked = await this.db.set(lockKey, '1', 'EX', lockTtl, 'NX');
    if (locked) {
      await this.#xadd(
        `${queueName}-stream`,
        JSON.stringify({
          ...jobEntry,
          lockUntil: nextRun,
          delayUntil: nextRun,
          repeatCount: jobEntry.repeatCount,
          timestamp: Date.now(),
          status: 'delayed',
          lastRun: Date.now(),
        }),
      );
    }
  }

  /**
   * Socket context for the current job. When expose is not set, socket methods throw at runtime.
   */
  #createSocketContext(
    id: string,
    event: string,
    queue: string,
  ): JobSocketContext {
    if (this.expose == null) {
      return {
        update: () => {
          throw new Error(
            'ctx.socket.update() requires Remq to be started with option expose (WebSocket port). Real-time updates are only available when the job was triggered via WebSocket.',
          );
        },
      };
    }
    return {
      update: (data: unknown, progress?: number) =>
        this.sendJobUpdate({
          id,
          event,
          queue,
          data,
          progress: progress ?? 0,
        }),
    };
  }

  /**
   * Sockets that should receive updates for a job: emitters for this job plus any client that connected with x-get-broadcast: true.
   */
  #getSocketsForJobUpdate(jobId: string): Set<WebSocket> {
    const out = new Set<WebSocket>(this.jobIdToSockets.get(jobId) ?? []);
    for (const ws of this.broadcastSockets) {
      if (ws.readyState === WebSocket.OPEN) out.add(ws);
    }
    return out;
  }

  /**
   * Send a progressive update to WebSocket client(s) tracking this job (or all when exposeBroadcast).
   */
  private sendJobUpdate({
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
    const sockets = this.#getSocketsForJobUpdate(id);
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
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payloadStr);
        }
      } catch (err) {
        console.error('WS send job_update error:', err);
      }
    }
  }

  /**
   * Notify WebSocket client(s) that this job attempt failed and a retry is scheduled (or all when exposeBroadcast).
   */
  private sendJobRetry({
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
    const sockets = this.#getSocketsForJobUpdate(id);
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
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payloadStr);
        }
      } catch (err) {
        console.error('WS send job_retry error:', err);
      }
    }
  }

  /**
   * Start processing jobs
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    // Ensure consumer groups exist for all registered streams
    for (const streamKey of this.queueStreams) {
      await this.ensureConsumerGroup(streamKey);
    }

    // Stop existing processor if it exists (to recreate with all current streams)
    if (this.processor) {
      this.processor.stop();
      await this.drain();
    }

    // Cron dedup on restart: only emit if no existing job state for that cron
    for (const [, { event, queue, repeat, attempts }] of this.pendingCronJobs) {
      const jobId = genJobIdSync(event, {});
      const pipe = this.db.pipeline();
      ['waiting', 'delayed', 'processing'].forEach((s) =>
        pipe.exists(`queues:${queue}:${jobId}:${s}`)
      );
      const results = await pipe.exec() as [Error | null, number][];
      if (!results.some(([, exists]) => exists === 1)) {
        this.emit(event, {}, { queue, repeat, attempts });
      }
    }

    // Always recreate processor to include all currently registered handlers/queues
    // This ensures all registered streams are included (like old defaultWorker)
    this.createUnifiedProcessor();

    if (this.processor) {
      this.processor.start().catch((err) => {
        console.error('Error starting processor:', err);
      });
    }

    this.isStarted = true;
    this.setupGracefulShutdown();

    if (this.expose != null) {
      this.wsServer = createWsGateway({
        port: this.expose,
        hostname: '0.0.0.0',
        remq: this,
        onConnection: (ws, req) => this.handleWsConnection(ws, req),
      });
      this.#jobFinishedUnsubscribe = this[SUBSCRIBE_JOB_FINISHED](
        (payload) => {
          const sockets = this.#getSocketsForJobUpdate(payload.jobId);
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
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(payloadStr);
              }
            } catch (err) {
              console.error('WS send job_finished error:', err);
            }
          }
          const socketsThatHadJob = this.jobIdToSockets.get(payload.jobId);
          this.jobIdToSockets.delete(payload.jobId);
          if (socketsThatHadJob) {
            for (const ws of socketsThatHadJob) {
              this.socketToJobIds.get(ws)?.delete(payload.jobId);
            }
          }
        },
      );
      console.log(`Remq WS gateway listening on 0.0.0.0:${this.expose}`);
    }

    const streamList = Array.from(this.queueStreams).join(', ');
    console.log(
      `Remq started with ${this.queueStreams.size} queue(s) [${streamList}] and concurrency ${this.concurrency}`,
    );
  }

  /**
   * Handle WebSocket client: accept { type: 'emit', event, queue?, data?, options? }, call emit,
   * reply with { type: 'queued', jobId } and later { type: 'job_finished', jobId, status, ... }.
   * If the client connected with header x-get-broadcast: true, they receive all job_update / job_retry / job_finished.
   */
  private handleWsConnection(ws: WebSocket, req: Request): void {
    const wantBroadcast =
      req.headers.get('x-get-broadcast')?.toLowerCase() === 'true';
    if (wantBroadcast) {
      this.broadcastSockets.add(ws);
    }
    const addJobForSocket = (jobId: string) => {
      if (!this.socketToJobIds.has(ws)) {
        this.socketToJobIds.set(ws, new Set());
      }
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
        // Accept both { type: 'emit', event, ... } and { event, data, options }
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

  /**
   * Stop processing jobs
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
   * Wait for all active Jobs to finish (e.g. before shutdown).
   */
  async drain(): Promise<void> {
    if (this.processor) {
      await this.processor.waitForActiveJobs();
    }
  }

  /**
   * Creates unified processor for all queues (like old defaultWorker)
   */
  private createUnifiedProcessor(): void {
    const allStreamKeys = Array.from(this.queueStreams);

    const unifiedMessageHandler = async (
      message: Message,
      ctx: MessageContext,
    ): Promise<void> => {
      const processableMessage = message as unknown as ProcessableMessage;
      const jobData = processableMessage.data;

      if (!jobData?.state?.name || !jobData?.state?.queue) {
        throw new Error('Invalid job data: missing state.name or state.queue');
      }

      const queueName = jobData.state.queue || 'default';
      const jobName = jobData.state.name!;
      const handlerKey = `${queueName}:${jobName}`;
      const jobId = jobData.id || processableMessage.id;

      // Check if queue is paused and job status in one pipeline (like old worker line 250-265, 305-309)
      const pipe = this.db.pipeline();
      pipe.get(`queues:${queueName}:paused`);
      pipe.get(
        `queues:${queueName}:${jobId}:${jobData.status || 'waiting'}`,
      );
      const [[, isPaused], [, jobStatusData]] = (await pipe.exec()) as [
        [Error | null, string | null],
        [Error | null, string | null],
      ];
      if (isPaused === 'true') {
        // Queue is paused - skip processing (don't ACK, let it be reclaimed)
        return;
      }
      if (jobStatusData) {
        try {
          const parsedJob = JSON.parse(jobStatusData) as {
            status?: string;
            paused?: boolean;
          };
          // Skip already-completed/failed jobs that reappear after SETID '0' reset
          if (
            parsedJob.status === 'completed' || parsedJob.status === 'failed'
          ) {
            await ctx.ack();
            return;
          }
          if (parsedJob.paused === true) {
            // Job is paused - skip processing (don't ACK, let it be reclaimed)
            return;
          }
        } catch {
          // If we can't parse, continue processing
        }
      }

      const handler = this.handlers.get(handlerKey);

      if (!handler) {
        const registeredHandlers = Array.from(this.handlers.keys()).join(', ');
        throw new Error(
          `No handler found for queue: ${queueName}, event: ${jobName}. Registered handlers: ${registeredHandlers}`,
        );
      }

      // Check handler-specific debounce (if configured in options.debounce)
      const debounceManager = this.handlerDebounce.get(handlerKey);
      if (debounceManager) {
        if (
          !debounceManager.shouldProcess(
            processableMessage as {
              id: string;
              data?: unknown;
              [key: string]: unknown;
            },
          )
        ) {
          await ctx.ack();
          return; // Skip - debounced
        }
        // Mark as processed after handler completes
        const originalHandler = handler;
        const wrappedHandler = async (ctx: any) => {
          await originalHandler(ctx);
          debounceManager.markProcessed(
            processableMessage as {
              id: string;
              data?: unknown;
              [key: string]: unknown;
            },
          );
        };
        await this.processJob(
          jobData,
          jobId,
          queueName,
          wrappedHandler,
        );
      } else {
        // Process job (copied from old worker #processJob line 355-586)
        await this.processJob(jobData, jobId, queueName, handler);
      }
    };

    this.processor = new Processor({
      consumer: {
        streams: allStreamKeys,
        streamdb: this.streamdb,
        handler: unifiedMessageHandler,
        concurrency: this.concurrency,
        group: 'processor',
        pollIntervalMs: this.processorOptions?.pollIntervalMs,
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

  /**
   * processJob — optimised drop-in replacement for remq/mod.ts
   *
   * Changes vs current:
   * - Round trips: 6 → 2 (happy path), 4 → 2 (failure path)
   * - Removed: redundant db.get(processingKey) after handler
   * - Removed: redundant db.del(completedKey) before writing completed (key doesn't exist yet)
   * - Added: transitionState() helper — pipelines del+set into 1 round trip
   * - All checks preserved: pause, debounce, retry, DLQ, cron, WS notify, log trim, TTL
   */

  // ─── Drop-in helper — add as private method on Remq class ─────────────────────

  /**
   * Pipeline del(oldKey) + set(newKey, value, EX ttl?) into a single round trip.
   * Safe: by the time we transition state, the message is already ACKed — no other
   * consumer can claim it, so there's no race between the del and set.
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

  // ─── Drop-in replacement for processJob ───────────────────────────────────────

  private async processJob(
    jobEntry: any,
    jobId: string,
    queueName: string,
    handler: JobHandler<TApp, any>,
  ): Promise<void> {
    const maxLogsPerJob = this.processorOptions?.maxLogsPerJob;

    try {
      // Ensure logs array
      if (!jobEntry.logs) jobEntry.logs = [];

      // Logger — writes to in-memory blob only, no per-entry Redis keys
      if (!jobEntry.logger) {
        jobEntry.logger = async (message: string | object) => {
          jobEntry.logs?.push({
            message: typeof message === 'string'
              ? message
              : JSON.stringify(message),
            timestamp: Date.now(),
          });
          this.#trimLogs(jobEntry, maxLogsPerJob);
        };
      }

      // Add processing log entry if not already present
      if (
        jobEntry.status !== 'processing' &&
        !jobEntry.logs.find((log: any) =>
          log.message === this.JOB_STATUS_MESSAGES.processing
        )
      ) {
        jobEntry.logs.push({
          message: this.JOB_STATUS_MESSAGES.processing,
          timestamp: Date.now(),
        });
        this.#trimLogs(jobEntry, maxLogsPerJob);
      }

      const processingData = {
        ...jobEntry,
        lastRun: Date.now(),
        status: 'processing',
      };

      const oldKey = `queues:${queueName}:${jobId}:${jobEntry.status}`;
      const processingKey = `queues:${queueName}:${jobId}:processing`;

      // Round trip 1: del old state key + set processing state
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

      // Build unified ctx — app context + job identity + capabilities
      const ctx = {
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
        socket: this.#createSocketContext(
          jobId,
          jobEntry.state.name!,
          jobEntry.state.queue!,
        ),
      };

      // Execute handler — all async work happens here
      await handler(ctx);

      // Build completed blob from in-memory processingData — no db.get needed
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
      this.#trimLogs(completedData, maxLogsPerJob);

      const completedKey = `queues:${queueName}:${jobId}:completed`;

      // Round trip 2: del processing state + set completed state
      await this.transitionState(
        processingKey,
        completedKey,
        JSON.stringify(completedData),
      );

      this.#notifyJobFinished({ jobId, queue: queueName, status: 'completed' });

      await this.#scheduleCronNextTick(jobEntry, queueName);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const isConfigError = errorMessage.includes('No handler found') ||
        errorMessage.includes('No handlers registered') ||
        errorMessage.includes('is undefined');

      const willRetry = jobEntry.retryCount > 0 && !isConfigError;

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
      this.#trimLogs(failedData, maxLogsPerJob);

      if (!willRetry) {
        // Final failure — persist failed state + notify WS
        const failedKey = `queues:${queueName}:${jobEntry.id}:failed`;

        // Round trip 2 (failure path): del processing state + set failed state
        await this.transitionState(
          `queues:${queueName}:${jobId}:processing`,
          failedKey,
          JSON.stringify(failedData),
        );

        this.#notifyJobFinished({
          jobId: jobEntry.id,
          queue: queueName,
          status: 'failed',
          error: errorMessage,
        });
      } else {
        // Will retry — notify WS of this attempt's failure
        this.sendJobRetry({
          id: jobEntry.id,
          event: jobEntry.state.name!,
          queue: queueName,
          error: errorMessage,
          retryCount: jobEntry.retryCount - 1,
          retryDelayMs: jobEntry.retryDelayMs || 1000,
        });
      }

      // Re-queue for retry — xadd only, no state key (delay + retryCount drives next attempt)
      if (willRetry) {
        const retryJob = {
          ...jobEntry,
          delayUntil: Date.now() + (jobEntry.retryDelayMs || 1000),
          lockUntil: Date.now(),
          retryCount: jobEntry.retryCount - 1,
          retriedAttempts: (jobEntry.retriedAttempts || 0) + 1,
          logs: [
            ...(jobEntry.logs || []),
            {
              message: `retrying ${jobEntry.retryCount} more times`,
              timestamp: Date.now(),
            },
          ],
        };
        this.#trimLogs(retryJob, maxLogsPerJob);
        await this.#xadd(`${queueName}-stream`, JSON.stringify(retryJob));
      }

      // Reschedule cron next tick regardless of failure so the cron is not dead
      await this.#scheduleCronNextTick(jobEntry, queueName);

      throw error; // Re-throw so Processor can handle
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      await this.stop();
      console.log('Shutdown complete');

      if (typeof Deno !== 'undefined') {
        // @ts-ignore
        Deno.exit(0);
      } else {
        // @ts-ignore
        if (typeof process !== 'undefined') {
          // @ts-ignore
          process.exit(0);
        }
      }
    };

    // @ts-ignore
    if (typeof Deno !== 'undefined') {
      // @ts-ignore
      Deno.addSignalListener('SIGINT', () => shutdown('SIGINT'));
      // @ts-ignore
      Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM'));
    } else {
      // @ts-ignore
      if (typeof process !== 'undefined') {
        // @ts-ignore
        process.on('SIGINT', () => shutdown('SIGINT'));
        // @ts-ignore
        process.on('SIGTERM', () => shutdown('SIGTERM'));
      }
    }
  }

  /**
   * Ensures consumer group exists
   */
  private async ensureConsumerGroup(streamKey: string): Promise<void> {
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
      if (err?.message?.includes('BUSYGROUP')) {
        // Reset last-delivered-id so jobs emitted before start() are not skipped
        await this.streamdb.xgroup('SETID', streamKey, 'processor', '0');
        return;
      }
      throw error;
    }
  }
}
