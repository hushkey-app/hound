# Core API

Main modules for task/job processing with Redis Streams.

## API list

### TaskManager (`libs/task-manager/task-manager.ts`)

| Method | Signature |
|--------|-----------|
| `init` | `static init<T>(options): TaskManager<T>` |
| `registerHandler` | `registerHandler(options): Promise<void>` |
| `emit` | `emit(args: { event, queue?, data?, options? }): string` (returns task id) |
| `start` | `start(): Promise<void>` |
| `stop` | `stop(): Promise<void>` |
| `pauseQueue` | `pauseQueue(queue: string): Promise<void>` |
| `resumeQueue` | `resumeQueue(queue: string): Promise<void>` |
| `isQueuePaused` | `isQueuePaused(queue: string): Promise<boolean>` |

### Consumer (`libs/consumer/`)

| Class / Method | Description |
|----------------|-------------|
| `Consumer` | Main consumer class |
| `Consumer.constructor` | `(options: ConsumerOptions)` |
| `Consumer.start` | `start(options?): Promise<void>` |
| `Consumer.stop` | `stop(): void` |
| `Consumer.waitForActiveTasks` | `waitForActiveTasks(): Promise<void>` |
| `StreamReader` | Redis Stream reading with consumer groups |
| `ConcurrencyPool` | Manages concurrent message processing |

### Processor (`libs/processor/`)

| Class / Method | Description |
|----------------|-------------|
| `processor.maxLogsPerTask` | Trim oldest logs per task; keeps Redis self-cleaning (default: no limit) |
| `Processor` | Policy layer wrapping Consumer |
| `Processor.constructor` | `(options: ProcessorOptions)` |
| `Processor.start` | `start(options?): Promise<void>` |
| `Processor.stop` | `stop(): void` |
| `Processor.waitForActiveTasks` | `waitForActiveTasks(): Promise<void>` |
| `Processor.cleanup` | `cleanup(): void` |
| `DebounceManager` | Per-handler debouncing |

### Sdk (`libs/sdk/`)

| Method | Description |
|--------|-------------|
| `getJob` | `getJob(jobId, queue): Promise<AdminJobData \| null>` |
| `listJobs` | `listJobs(options?): Promise<AdminJobData[]>` |
| `deleteJob` | `deleteJob(jobId, queue): Promise<void>` |
| `retryJob` | `retryJob(jobId, queue): Promise<AdminJobData \| null>` |
| `cancelJob` | `cancelJob(jobId, queue): Promise<boolean>` |
| `getQueueStats` | `getQueueStats(queue): Promise<TaskStats>` |
| `getQueues` | `getQueues(): Promise<string[]>` |
| `getQueuesInfo` | `getQueuesInfo(): Promise<QueueInfo[]>` |
| `pauseQueue` | `pauseQueue(queue): Promise<void>` |
| `resumeQueue` | `resumeQueue(queue): Promise<void>` |
| `isQueuePaused` | `isQueuePaused(queue): Promise<boolean>` |
| `pauseJob` | `pauseJob(jobId, queue): Promise<AdminJobData \| null>` |
| `resumeJob` | `resumeJob(jobId, queue): Promise<AdminJobData \| null>` |

### Types

| Type | Module |
|------|--------|
| `TaskManagerOptions`, `TaskHandler`, `EmitFunction`, `UpdateFunction`, `RegisterHandlerOptions` | `types/task-manager.ts` |
| `ConsumerOptions`, `Message`, `MessageHandler`, `MessageContext`, `ConsumerEvents` | `types/` |
| `ProcessorOptions`, `ProcessableMessage`, `RetryConfig`, `DLQConfig`, `DebounceConfig` | `types/processor.ts` |
| `AdminJobData`, `ListJobsOptions`, `TaskStats`, `QueueInfo` | `types/admin.ts` |

---

## Retry options: levels and combo

Retry behavior depends on options at two levels. Both must allow retries.

### Per-task level (`emit` / `registerHandler.options`)

| Option | Role |
|--------|------|
| `attempts` or `retryCount` | Number of retries for this task (use one; they are the same) |
| `retryDelayMs` | Delay before each retry (ms) |

### Processor level (`processor.retry`)

| Option | Role |
|--------|------|
| `maxRetries` | Global switch: retries happen only if > 0 |
| `retryDelayMs` | Default delay before retries (overridden by per-task `retryDelayMs`) |
| `shouldRetry` | `(error: Error, attempt: number) => boolean` — filter which errors to retry; return `false` to skip retry (e.g. for validation errors) |

### Common mistakes

- **`attempts` and `retryCount` together** — Redundant. Use one.
- **`shouldRetry` in emit options** — Invalid. `shouldRetry` is a processor callback, not an emit option.
- **`debounce` in emit options** — Wrong level. Debounce is per-handler in `registerHandler`, not per emit.

### How the combo works

1. Task fails → processor checks `retryCount > 0` and `maxRetries > 0`.
2. If both true → calls `shouldRetry(error, attempt)` (if set).
3. If `shouldRetry` returns false → no retry (may go to DLQ).
4. Otherwise → retry; `retryCount` is decremented.

```ts
// Minimal: processor enables retries, per-task sets count
processor: { retry: { maxRetries: 5 } },
registerHandler({ event: 'foo', handler, options: { attempts: 3 } });  // 3 retries

// Filter errors: retry network, skip validation
processor: {
  retry: {
    maxRetries: 5,
    shouldRetry: (err) => !err.message.includes('validation'),
  },
},
```

---

## Real-time task updates: `ctx.socket.update` (BETA)

When the TaskManager is started with `expose` (WebSocket gateway), tasks triggered over WebSocket can send **progressive updates** to the client. Use `ctx.socket.update(data, progress)` inside a handler to push real-time payloads to the socket that requested the task.

- **Who receives updates**: By default, only the client that emitted the task gets `task_update` / `task_retry` / `task_finished` for that task. To receive **all** task updates (e.g. for dashboards), connect with the header **`x-get-broadcast: true`**; that connection will get every `task_update`, `task_retry`, and `task_finished` for any task.
- **Payload**: any JSON-serializable value (object, array, string, number). The client receives `{ type: 'task_update', taskId, data, progress }`.

### Use cases

- **Long-running tasks** — e.g. report generation, batch processing: send `{ step: 'fetching', progress: 20 }`, then `{ step: 'processing', progress: 60 }`, then `{ step: 'done', progress: 100 }`.
- **Live progress** — file uploads, exports, imports: stream percentage or current item so the UI can show a progress bar or log.
- **Streaming status** — multi-step workflows: notify the client after each step completes so they see “Step 1/5 done”, “Step 2/5 done”, etc., without polling.

### Example

**Handler (server):**

```ts
await tm.registerHandler({
  event: 'generate-report',
  handler: async (task, ctx) => {
    ctx.socket.update('started', 0);
    const raw = await fetchData();
    ctx.socket.update('fetching', 33);
    const report = await buildReport(raw);
    ctx.socket.update('building', 66);
    await saveReport(report);
    ctx.socket.update('done', 100);
  },
});
```

**Client (WebSocket):**

```ts
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'task_update') {
    console.log('Progress:', msg.data); // e.g. { step: 'building', progress: 66 }
  }
  if (msg.type === 'task_retry') {
    // Attempt failed; retry scheduled. Connection stays open for more updates/final task_finished.
    console.log('Retry scheduled:', msg.error, 'retries left:', msg.retryCount);
  }
  if (msg.type === 'task_finished') {
    console.log('Task done:', msg.status); // only sent when job completes or finally fails (no more retries)
  }
};
```

**Broadcast (all task updates):** Connect with header `x-get-broadcast: true` to receive every `task_update` / `task_retry` / `task_finished` for any task. Example from Node/Deno (browsers cannot set custom WebSocket headers; use a backend or a client that supports it):

```ts
import { WebSocket } from 'npm:ws'; // or Deno std ws
const ws = new WebSocket('http://localhost:4000', {
  headers: { 'x-get-broadcast': 'true' },
});
```

---

## Self-cleaning logs: `maxLogsPerTask`

Set `processor.maxLogsPerTask` to cap the number of log entries per task. Oldest logs are trimmed when the limit is exceeded, keeping Redis self-cleaning and preventing unbounded growth.

- **Behavior**: When logs exceed the limit, oldest entries are removed (FIFO).
- **Redis**: When `maxLogsPerTask` is set, individual log keys (`queues:queue:taskId:logs:*`) are not written; logs live only in the task status blob, reducing Redis keys.

```ts
processor: {
  maxLogsPerTask: 100,
}
```

---

## Redis: avoiding overload (production)

These patterns can stress or crash a Redis container if left unbounded. Mitigate as below.

| Risk | Cause | Mitigation |
|------|--------|------------|
| **Unbounded stream growth / process memory blowup** | Queue streams use `XADD` with no cap; consumer reads in batches. Unbounded streams can cause Redis and process memory to spike (e.g. 130MB → 3GB). | **Set `processor.streamMaxLen`** (e.g. `10000`). After each read+ACK the stream is trimmed (XTRIM MAXLEN ~), so the stream self-cleans. Optionally lower `processor.readCount` (default 200) if message payloads are large. |
| **Unbounded log keys** | When `maxLogsPerTask` is **not** set, each `task.logger()` call creates a Redis key `queues:queue:taskId:logs:uuid` and they are never deleted. | **Always set `processor.maxLogsPerTask`** (e.g. `100`) in production so logs live only in the task blob and per-log keys are not written. |
| **Accumulation of completed/failed keys** | `queues:queueName:taskId:completed` and `queues:queueName:taskId:failed` are never deleted. Key count grows with every finished task. | Accept for moderate volume, or add a TTL/background cleanup for old completed/failed keys (e.g. SDK or cron). |

**Recommended for production:** set `processor.maxLogsPerTask`, **`processor.streamMaxLen`** (e.g. `10000`), use Redis `maxmemory` + eviction, and monitor stream lengths and key count. If you see process memory spikes when loading remq, enable `streamMaxLen` and consider lowering `readCount` for large payloads.

---

## Quick init example

```ts
import { TaskManager } from './libs/task-manager/mod.ts';
import Redis from 'ioredis';

const redisOption = {
  port: 6379,
  host: 'localhost',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  db: 1,
};

const db = new Redis(redisOption);
const streamdb = new Redis({ ...redisOption, db: 2 }); // optional: separate stream connection

const tm = TaskManager.init({
  db,
  streamdb,
  ctx: {},
  concurrency: 2,
  processor: {
    retry: { maxRetries: 3, retryDelayMs: 1000 },
    dlq: {
      streamKey: 'remq-dlq',
      shouldSendToDLQ: (_, __, attempts) => attempts >= 3,
    },
    maxLogsPerTask: 100,
    streamMaxLen: 10000, // trim stream after each batch to avoid memory blowup
  },
});

// Register handler (ctx.emit for new tasks; ctx.socket.update for real-time WS updates when expose is set — see "Real-time task updates" above)
await tm.registerHandler({
  handler: async (job, ctx) => {
    console.log('Processing:', job.data);
    ctx.emit({ event: 'follow-up', data: { from: job.name } });
  },
  event: 'my-event',
  queue: 'default',
  options: {
    repeat: { pattern: '*/30 * * * * *' }, // every 30s
    attempts: 3,
  },
});

// Emit job
tm.emit({ event: 'my-event', data: { id: 1 } });

// Start
await tm.start();
```
