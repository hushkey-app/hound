import { Processor } from '../processor/processor.ts';
import { DebounceManager } from '../processor/debounce-manager.ts';
import { createWsGateway } from '../gateways/ws.gateway.ts';
import type {
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  Message,
  MessageContext,
  ProcessableMessage,
  RedisConnection,
  TaskHandler,
  TaskManagerOptions,
  TaskSocketContext,
  UpdateFunction,
} from '../../types/index.ts';
import { genJobIdSync } from './utils.ts';
import { parseCronExpression } from 'cron-schedule';

/**
 * Remq - High-level API for managing tasks/jobs
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
  private readonly processorOptions: TaskManagerOptions<TApp>['processor'];
  private readonly debug: boolean;

  private handlers: Map<string, TaskHandler<TApp, any>> = new Map();
  private handlerDebounce: Map<string, DebounceManager> = new Map(); // handlerKey -> DebounceManager
  private processor?: Processor;
  private queueStreams: Set<string> = new Set();
  private isStarted = false;
  private readonly expose?: number;
  private wsServer?: ReturnType<typeof createWsGateway>;
  /** Sockets that requested broadcast via header x-get-broadcast: true */
  private readonly broadcastSockets = new Set<WebSocket>();
  readonly #taskFinishedListeners = new Set<
    (
      payload: {
        taskId: string;
        queue: string;
        status: 'completed' | 'failed';
        error?: string;
      },
    ) => void
  >();
  #taskFinishedUnsubscribe?: () => void;
  private readonly taskIdToSockets = new Map<string, Set<WebSocket>>();
  private readonly socketToTaskIds = new Map<WebSocket, Set<string>>();
  #workerRunIndex = 0; // used for debug log worker_id (0..concurrency-1)

  // Job status messages (like old worker line 71-80)
  private readonly JOB_STATUS_MESSAGES = {
    processing: 'Job execution started',
    completed: 'Job completed successfully',
    delayed: (date: string) => `Job delayed until ${date}`,
    waiting: 'Job queued and waiting to be processed',
    failed: (error: string) => `Job failed: ${error}`,
  };

  private constructor(options: TaskManagerOptions<TApp>) {
    this.db = options.db;
    this.streamdb = options.streamdb || options.db;
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
    options: TaskManagerOptions<TApp>,
  ): Remq<TApp> {
    if (!Remq.instance) {
      Remq.instance = new Remq(options);
    }
    return Remq.instance as Remq<TApp>;
  }

  static getInstance<
    TApp extends Record<string, unknown> = Record<string, unknown>,
  >(): Remq<TApp> {
    return Remq.instance as Remq<TApp>;
  }

  /**
   * Register a handler for an event/task. Event names support dot notation (e.g. 'host.sync', 'user.welcome').
   * Returns this for fluent chaining.
   */
  on<D = unknown>(
    event: string,
    handler: TaskHandler<TApp, D>,
    options?: HandlerOptions,
  ): this {
    const queue = options?.queue ?? 'default';
    const debounce = options?.debounce;

    if (!event) {
      throw new Error('event is required');
    }

    if (!handler) {
      throw new Error('handler is required');
    }

    const handlerKey = `${queue}:${event}`;
    this.handlers.set(handlerKey, handler as TaskHandler<TApp, any>);

    const streamKey = `${queue}-stream`;
    this.queueStreams.add(streamKey);

    if (debounce !== undefined) {
      const debounceSeconds = Math.ceil(debounce / 1000);
      const debounceManager = new DebounceManager(debounceSeconds, undefined);
      this.handlerDebounce.set(handlerKey, debounceManager);
    }

    // Cron bootstrap: fire-and-forget (no await)
    if (options?.repeat?.pattern) {
      this.emit(event, {}, {
        queue,
        repeat: { pattern: options.repeat.pattern },
        attempts: options.attempts,
      });
    }
    return this;
  }

  /**
   * Emit/trigger a task/event. Returns the job id so callers can track completion.
   */
  emit(event: string, data?: unknown, options?: EmitOptions): string {
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
    this.#xadd(streamKey, JSON.stringify(jobData)).catch((err: unknown) => {
      console.error(`Error emitting job to queue ${queue}:`, err);
    });

    const stateKey = `queues:${queue}:${jobId}:${jobData.status}`;
    this.#setJobState(stateKey, JSON.stringify(jobData)).catch(
      (err: unknown) => {
        console.error(`Error storing job state:`, err);
      },
    );
    return jobId;
  }

  /**
   * Subscribe to task completion/failure (e.g. for WebSocket reply).
   * Returns an unsubscribe function.
   */
  onTaskFinished(
    cb: (payload: {
      taskId: string;
      queue: string;
      status: 'completed' | 'failed';
      error?: string;
    }) => void,
  ): () => void {
    this.#taskFinishedListeners.add(cb);
    return () => this.#taskFinishedListeners.delete(cb);
  }

  #notifyTaskFinished(payload: {
    taskId: string;
    queue: string;
    status: 'completed' | 'failed';
    error?: string;
  }): void {
    for (const cb of this.#taskFinishedListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('taskFinished listener error:', err);
      }
    }
  }

  /**
   * Add entry to stream with optional MAXLEN to cap stream size at add time.
   */
  async #xadd(streamKey: string, dataJson: string): Promise<string | null> {
    const maxLen = this.processorOptions?.streamMaxLen;
    if (typeof maxLen === 'number' && maxLen > 0) {
      return await this.streamdb.xadd(
        streamKey,
        'MAXLEN',
        '~',
        maxLen,
        '*',
        'data',
        dataJson,
      );
    }
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
   * Trim oldest log entries when maxLogsPerTask is set (self-cleaning).
   */
  #trimLogs(
    jobEntry: { logs?: unknown[] },
    maxLogsPerTask: number | undefined,
  ): void {
    if (
      typeof maxLogsPerTask !== 'number' ||
      maxLogsPerTask <= 0 ||
      !jobEntry.logs?.length ||
      jobEntry.logs.length <= maxLogsPerTask
    ) return;
    const excess = jobEntry.logs.length - maxLogsPerTask;
    jobEntry.logs.splice(0, excess);
  }

  /**
   * Socket context for the current task. When expose is not set, socket methods throw at runtime.
   */
  #createSocketContext(
    id: string,
    event: string,
    queue: string,
  ): TaskSocketContext {
    if (this.expose == null) {
      return {
        update: () => {
          throw new Error(
            'ctx.socket.update() requires Remq to be started with option expose (WebSocket port). Real-time updates are only available when the task was triggered via WebSocket.',
          );
        },
      };
    }
    return {
      update: (data: unknown, progress?: number) =>
        this.sendTaskUpdate({
          id,
          event,
          queue,
          data,
          progress: progress ?? 0,
        }),
    };
  }

  /**
   * Sockets that should receive updates for a task: emitters for this task plus any client that connected with x-get-broadcast: true.
   */
  #getSocketsForTaskUpdate(taskId: string): Set<WebSocket> {
    const out = new Set<WebSocket>(this.taskIdToSockets.get(taskId) ?? []);
    for (const ws of this.broadcastSockets) {
      if (ws.readyState === WebSocket.OPEN) out.add(ws);
    }
    return out;
  }

  /**
   * Send a progressive update to WebSocket client(s) tracking this task (or all when exposeBroadcast).
   */
  private sendTaskUpdate({
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
    const sockets = this.#getSocketsForTaskUpdate(id);
    if (!sockets.size) return;
    const payloadStr = JSON.stringify({
      type: 'task_update',
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
        console.error('WS send task_update error:', err);
      }
    }
  }

  /**
   * Notify WebSocket client(s) that this task attempt failed and a retry is scheduled (or all when exposeBroadcast).
   */
  private sendTaskRetry({
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
    const sockets = this.#getSocketsForTaskUpdate(id);
    if (!sockets.size) return;
    const payloadStr = JSON.stringify({
      type: 'task_retry',
      taskId: id,
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
        console.error('WS send task_retry error:', err);
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
      this.#taskFinishedUnsubscribe = this.onTaskFinished((payload) => {
        const sockets = this.#getSocketsForTaskUpdate(payload.taskId);
        if (!sockets.size) return;
        const payloadStr = JSON.stringify({
          type: 'task_finished',
          taskId: payload.taskId,
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
            console.error('WS send task_finished error:', err);
          }
        }
        const socketsThatHadTask = this.taskIdToSockets.get(payload.taskId);
        this.taskIdToSockets.delete(payload.taskId);
        if (socketsThatHadTask) {
          for (const ws of socketsThatHadTask) {
            this.socketToTaskIds.get(ws)?.delete(payload.taskId);
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

  /**
   * Handle WebSocket client: accept { type: 'emit', event, queue?, data?, options? }, call emit,
   * reply with { type: 'queued', taskId } and later { type: 'task_finished', taskId, status, ... }.
   * If the client connected with header x-get-broadcast: true, they receive all task_update / task_retry / task_finished.
   */
  private handleWsConnection(ws: WebSocket, req: Request): void {
    const wantBroadcast =
      req.headers.get('x-get-broadcast')?.toLowerCase() === 'true';
    if (wantBroadcast) {
      this.broadcastSockets.add(ws);
    }
    const addTaskForSocket = (taskId: string) => {
      if (!this.socketToTaskIds.has(ws)) {
        this.socketToTaskIds.set(ws, new Set());
      }
      this.socketToTaskIds.get(ws)!.add(taskId);
      if (!this.taskIdToSockets.has(taskId)) {
        this.taskIdToSockets.set(taskId, new Set());
      }
      this.taskIdToSockets.get(taskId)!.add(ws);
    };
    const removeSocket = () => {
      this.broadcastSockets.delete(ws);
      const taskIds = this.socketToTaskIds.get(ws);
      if (taskIds) {
        for (const taskId of taskIds) {
          this.taskIdToSockets.get(taskId)?.delete(ws);
          if (this.taskIdToSockets.get(taskId)?.size === 0) {
            this.taskIdToSockets.delete(taskId);
          }
        }
        this.socketToTaskIds.delete(ws);
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
          const taskId = this.emit(msg.event, msg.data, {
            queue: msg.queue,
            ...msg.options,
          } as EmitOptions);
          addTaskForSocket(taskId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'queued', taskId }));
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
    this.#taskFinishedUnsubscribe?.();
    this.#taskFinishedUnsubscribe = undefined;
    this.broadcastSockets.clear();
    this.taskIdToSockets.clear();
    this.socketToTaskIds.clear();
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
   * Wait for all active tasks to finish (e.g. before shutdown).
   */
  async drain(): Promise<void> {
    if (this.processor) {
      await this.processor.waitForActiveTasks();
    }
  }

  /**
   * Pause one or all queues (stops processing new jobs). With no arg, pauses all registered queues.
   */
  async pause(queue?: string): Promise<void> {
    const queues = queue != null
      ? [queue]
      : Array.from(this.queueStreams).map((k) => k.replace(/-stream$/, ''));
    for (const q of queues) {
      await this.db.set(`queues:${q}:paused`, 'true');
    }
  }

  /**
   * Resume one or all queues. With no arg, resumes all registered queues.
   */
  async resume(queue?: string): Promise<void> {
    const queues = queue != null
      ? [queue]
      : Array.from(this.queueStreams).map((k) => k.replace(/-stream$/, ''));
    for (const q of queues) {
      await this.db.del(`queues:${q}:paused`);
    }
  }

  /**
   * Check if a queue is paused.
   */
  async isPaused(queue: string): Promise<boolean> {
    const pausedKey = `queues:${queue}:paused`;
    const isPaused = await this.db.get(pausedKey);
    return isPaused === 'true';
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

      const state = jobData.state;
      const stateAny = state as any;

      const queueName = state.queue || 'default';
      const jobName = state.name!;
      const handlerKey = `${queueName}:${jobName}`;
      const jobId = jobData.id || processableMessage.id;

      // Check if queue is paused (like old worker line 250-265)
      const pausedKey = `queues:${queueName}:paused`;
      const isPaused = await this.db.get(pausedKey);
      if (isPaused === 'true') {
        // Queue is paused - skip processing (don't ACK, let it be reclaimed)
        return;
      }

      // Check if individual job is paused (like old worker line 305-309)
      // Get current job data to check paused flag
      const jobStatusKey = `queues:${queueName}:${jobId}:${
        jobData.status || 'waiting'
      }`;
      const jobStatusData = await this.db.get(jobStatusKey);
      if (jobStatusData) {
        try {
          const parsedJob = JSON.parse(jobStatusData) as any;
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
          state,
          stateAny,
          wrappedHandler,
          processableMessage,
        );
      } else {
        // Process job (copied from old worker #processJob line 355-586)
        await this.processJob(
          jobData,
          jobId,
          queueName,
          state,
          stateAny,
          handler,
          processableMessage,
        );
      }
    };

    this.processor = new Processor({
      consumer: {
        streams: allStreamKeys,
        streamdb: this.streamdb,
        handler: unifiedMessageHandler,
        concurrency: this.concurrency,
        group: 'processor',
        streamMaxLen: this.processorOptions?.streamMaxLen,
        pollIntervalMs: this.processorOptions?.pollIntervalMs,
        read: {
          count: this.processorOptions?.read?.count ?? this.processorOptions?.readCount ?? 200,
          blockMs: this.processorOptions?.read?.blockMs,
        },
      },
      streamdb: this.streamdb,
      ...this.processorOptions,
    });
  }

  /**
   * Process a task (copied from old worker #processJob - robust logic)
   */
  private async processJob(
    jobEntry: any, // JobData from message
    jobId: string,
    queueName: string,
    state: any,
    stateAny: any,
    handler: TaskHandler<TApp, any>,
    processableMessage: ProcessableMessage,
  ): Promise<void> {
    try {
      // Step 1: Delete old status key FIRST (like old worker line 357)
      await this.db.del(`queues:${queueName}:${jobId}:${jobEntry.status}`);

      // Ensure job has logs array (like old worker line 360-362)
      if (!jobEntry.logs) {
        jobEntry.logs = [];
      }

      // Add logger function (like old worker line 365-383)
      const maxLogsPerTask = this.processorOptions?.maxLogsPerTask;
      if (!jobEntry.logger) {
        jobEntry.logger = async (message: string | object) => {
          const logEntry = {
            message: typeof message === 'string'
              ? message
              : JSON.stringify(message),
            timestamp: Date.now(),
          };

          jobEntry.logs?.push(logEntry);
          this.#trimLogs(jobEntry, maxLogsPerTask);
          // Logs live only in job blob (no per-entry Redis keys) to avoid key explosion
        };
      }

      // Add processing status to logs (like old worker line 385-397)
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
        this.#trimLogs(jobEntry, maxLogsPerTask);
      }

      // Update status to processing (like old worker line 399-409)
      const processingData = {
        ...jobEntry,
        lastRun: Date.now(),
        status: 'processing',
      };

      const processingKey =
        `queues:${queueName}:${processingData.id}:${processingData.status}`;
      await this.#setJobState(processingKey, JSON.stringify(processingData));

      if (this.debug) {
        const pid = typeof Deno !== 'undefined' && Deno.pid != null
          ? Deno.pid
          : (typeof process !== 'undefined' && (process as { pid?: number }).pid) ?? '?';
        const workerId = this.#workerRunIndex++ % this.concurrency; // logical slot 0..concurrency-1
        console.log('[remq] PID', pid, 'worker_id', workerId, 'job_id', jobId);
      }

      // Build unified ctx (job identity + payload + capabilities + app context)
      const ctx = {
        ...this.ctx,
        id: jobId,
        name: state.name!,
        queue: state.queue!,
        status: processingData.status,
        retryCount: jobEntry.retryCount ?? 0,
        retriedAttempts: jobEntry.retriedAttempts ?? 0,
        data: state.data,
        logger: jobEntry.logger,
        emit: this.emit.bind(this),
        socket: this.#createSocketContext(jobId, state.name!, state.queue!),
      };
      await handler(ctx);

      // After processing, get any logs (like old worker line 414-419)
      const currentJobData = await this.db.get(processingKey);
      const currentJob = currentJobData
        ? JSON.parse(currentJobData)
        : processingData;

      // Combine logs and update status to completed (like old worker line 421-429)
      const completedLogs = [...(currentJob.logs || []), {
        message: this.JOB_STATUS_MESSAGES.completed,
        timestamp: Date.now(),
      }];
      const completedData = {
        ...currentJob,
        logs: completedLogs,
        status: 'completed',
      };
      this.#trimLogs(completedData, this.processorOptions?.maxLogsPerTask);

      // Store completed state (like old worker line 431-438)
      await this.db.del(
        `queues:${queueName}:${completedData.id}:${completedData.status}`,
      ).catch(() => {});
      await this.db.del(processingKey);
      const completedKey = `queues:${queueName}:${completedData.id}:completed`;
      await this.#setJobState(completedKey, JSON.stringify(completedData));
      this.#notifyTaskFinished({
        taskId: jobId,
        queue: queueName,
        status: 'completed',
      });

      // Handle job repetition (like old worker line 451-479)
      // IMPORTANT: Use jobEntry.id (original ID) not completedData.id to preserve cron ID
      if (
        jobEntry.repeatCount > 0 && jobEntry?.state?.options?.repeat?.pattern
      ) {
        const cron = parseCronExpression(jobEntry.state.options.repeat.pattern);

        const newJob = {
          ...jobEntry, // Use original jobEntry to preserve ID (like old worker line 459)
          lockUntil: cron.getNextDate(new Date()).getTime(),
          delayUntil: cron.getNextDate(new Date()).getTime(),
          repeatCount: jobEntry.repeatCount, // Keep same for infinite cron (like old worker line 466)
          timestamp: Date.now(),
          status: 'delayed',
          lastRun: Date.now(),
        };

        // Re-emit to stream (like old worker line 473-478 - just xadd, no Redis key storage)
        await this.#xadd(`${queueName}-stream`, JSON.stringify(newJob));
      }
    } catch (error: unknown) {
      // Handle failed state (like old worker line 493-585)
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
      this.#trimLogs(failedData, this.processorOptions?.maxLogsPerTask);

      if (!willRetry) {
        // Only persist failed state and notify WS when job is finally done (no more retries).
        const failedKey = `queues:${queueName}:${jobEntry.id}:failed`;
        await this.#setJobState(failedKey, JSON.stringify(failedData));
        this.#notifyTaskFinished({
          taskId: jobEntry.id,
          queue: queueName,
          status: 'failed',
          error: errorMessage,
        });
      } else {
        // Retrying: keep WS subscribed and tell client this attempt failed and retry is scheduled.
        this.sendTaskRetry({
          id: jobEntry.id,
          event: state.name!,
          queue: queueName,
          error: errorMessage,
          retryCount: jobEntry.retryCount - 1,
          retryDelayMs: jobEntry.retryDelayMs || 1000,
        });
      }

      // Handle retry (like old worker line 527-551)
      if (willRetry) {
        const retryLogs = [...(jobEntry.logs || []), {
          message: `retrying ${jobEntry.retryCount} more times`,
          timestamp: Date.now(),
        }];
        const retryJob = {
          ...jobEntry,
          delayUntil: Date.now() + (jobEntry.retryDelayMs || 1000),
          lockUntil: Date.now(),
          retryCount: jobEntry.retryCount - 1,
          retriedAttempts: (jobEntry.retriedAttempts || 0) + 1,
          logs: retryLogs,
        };
        this.#trimLogs(retryJob, this.processorOptions?.maxLogsPerTask);

        await this.#xadd(`${queueName}-stream`, JSON.stringify(retryJob));
      }

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
        return;
      }
      throw error;
    }
  }
}
