# Core API

Main modules for job processing with Redis Streams.

## API list

### Remq (`libs/job-manager/remq.ts`)

| Method      | Signature                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------- |
| `create`    | `static create<TApp>(options): Remq<TApp>`                                                  |
| `on`        | `on(event, handler, options?): this` (sync, fluent)                                         |
| `emit`      | `emit(event, data?, options?): string` (returns job id; queue in options)                   |
| `emitAsync` | `emitAsync(event, data?, options?): Promise<string>` (same as emit but awaits Redis writes) |
| `start`     | `start(): Promise<void>`                                                                    |
| `stop`      | `stop(): Promise<void>`                                                                     |
| `drain`     | `drain(): Promise<void>` — wait for active tasks to finish                                  |

### Consumer (`libs/consumer/`)

| Class / Method               | Description                               |
| ---------------------------- | ----------------------------------------- |
| `Consumer`                   | Main consumer class                       |
| `Consumer.constructor`       | `(options: ConsumerOptions)`              |
| `Consumer.start`             | `start(options?): Promise<void>`          |
| `Consumer.stop`              | `stop(): void`                            |
| `Consumer.waitForActiveJobs` | `waitForActiveJobs(): Promise<void>`      |
| `StreamReader`               | Redis Stream reading with consumer groups |
| `ConcurrencyPool`            | Manages concurrent message processing     |

### Processor (`libs/processor/`)

| Class / Method                | Description                                                             |
| ----------------------------- | ----------------------------------------------------------------------- |
| `processor.maxLogsPerTask`    | Trim oldest logs per job; keeps Redis self-cleaning (default: no limit) |
| `Processor`                   | Policy layer wrapping Consumer                                          |
| `Processor.constructor`       | `(options: ProcessorOptions)`                                           |
| `Processor.start`             | `start(options?): Promise<void>`                                        |
| `Processor.stop`              | `stop(): void`                                                          |
| `Processor.waitForActiveJobs` | `waitForActiveJobs(): Promise<void>`                                    |
| `Processor.cleanup`           | `cleanup(): void`                                                       |
| `DebounceManager`             | Per-handler debouncing                                                  |

### RemqAdmin (`libs/sdk/`)

| Method          | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `getJob`        | `getJob(jobId, queue): Promise<Job \| null>`                         |
| `listJobs`      | `listJobs(options?): Promise<Job[]>`                                 |
| `deleteJob`     | `deleteJob(jobId, queue): Promise<void>`                             |
| `retryJob`      | `retryJob(jobId, queue): Promise<Job \| null>`                       |
| `cancelJob`     | `cancelJob(jobId, queue): Promise<boolean>`                          |
| `stats`         | `stats(queue): Promise<QueueStats>`                                  |
| `queues`        | `queues(): Promise<string[]>`                                        |
| `queuesInfo`    | `queuesInfo(): Promise<QueueInfo[]>`                                 |
| `pause`         | `pause(queue?): Promise<void>`                                       |
| `resume`        | `resume(queue?): Promise<void>`                                      |
| `isPaused`      | `isPaused(queue): Promise<boolean>`                                  |
| `onJobFinished` | `onJobFinished(cb): () => void` (requires `new RemqAdmin(db, remq)`) |
| `pauseJob`      | `pauseJob(jobId, queue): Promise<Job \| null>`                       |
| `resumeJob`     | `resumeJob(jobId, queue): Promise<Job \| null>`                      |

### Types

| Type                                                                                                                                             | Module               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `JobManagerOptions`, `JobHandler`, `JobContext`, `JobDefinition`, `defineJob`, `EmitFunction`, `EmitOptions`, `HandlerOptions`, `UpdateFunction` | `types/remq.ts`      |
| `ConsumerOptions`, `Message`, `MessageHandler`, `MessageContext`, `ConsumerEvents`                                                               | `types/`             |
| `ProcessorOptions`, `ProcessableMessage`, `RetryConfig`, `DLQConfig`, `DebounceConfig`                                                           | `types/processor.ts` |
| `Job`, `Job`, `ListOptions`, `QueueStats`, `QueueInfo`                                                                                           | `types/admin.ts`     |

---

## Retry options: levels and combo

Retry behavior depends on options at two levels. Both must allow retries.

### Per-job level (`emit` / `on` options)

| Option                     | Role                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `attempts` or `retryCount` | Number of retries for this job (use one; they are the same) |
| `retryDelayMs`             | Delay before each retry (ms)                                |

### Processor level (`processor.retry`)

| Option         | Role                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRetries`   | Global switch: retries happen only if > 0                                                                                              |
| `retryDelayMs` | Default delay before retries (overridden by per-job `retryDelayMs`)                                                                    |
| `shouldRetry`  | `(error: Error, attempt: number) => boolean` — filter which errors to retry; return `false` to skip retry (e.g. for validation errors) |

### Common mistakes

- **`attempts` and `retryCount` together** — Redundant. Use one.
- **`shouldRetry` in emit options** — Invalid. `shouldRetry` is a processor callback, not an emit option.
- **`debounce` in emit options** — Wrong level. Debounce is per-handler in `on()`, not per emit.

### How the combo works

1. Job fails → processor checks `retryCount > 0` and `maxRetries > 0`.
2. If both true → calls `shouldRetry(error, attempt)` (if set).
3. If `shouldRetry` returns false → no retry (may go to DLQ).
4. Otherwise → retry; `retryCount` is decremented.

```ts
// Minimal: processor enables retries, per-job sets count
processor: { retry: { maxRetries: 5 } },
on('foo', handler, { attempts: 3 });  // 3 retries

// Filter errors: retry network, skip validation
processor: {
  retry: {
    maxRetries: 5,
    shouldRetry: (err) => !err.message.includes('validation'),
  },
},
```

---

## Real-time job updates: `ctx.socket.update` (BETA)

When Remq is started with `expose` (WebSocket gateway), jobs triggered over WebSocket can send **progressive updates** to the client. Use `ctx.socket.update(data, progress)` inside a handler to push real-time payloads to the socket that requested the job.

- **Who receives updates**: By default, only the client that emitted the job gets `job_update` / `job_retry` / `job_finished` for that job. To receive **all** job updates (e.g. for dashboards), connect with the header **`x-get-broadcast: true`**; that connection will get every `job_update`, `job_retry`, and `job_finished` for any job.
- **Payload**: any JSON-serializable value (object, array, string, number). The client receives `{ type: 'job_update', id, data, progress }`.

### Use cases

- **Long-running tasks** — e.g. report generation, batch processing: send `{ step: 'fetching', progress: 20 }`, then `{ step: 'processing', progress: 60 }`, then `{ step: 'done', progress: 100 }`.
- **Live progress** — file uploads, exports, imports: stream percentage or current item so the UI can show a progress bar or log.
- **Streaming status** — multi-step workflows: notify the client after each step completes so they see “Step 1/5 done”, “Step 2/5 done”, etc., without polling.

### Example

**Handler (server):**

```ts
tm.on('generate-report', async (ctx) => {
  ctx.socket.update('started', 0);
  const raw = await fetchData();
  ctx.socket.update('fetching', 33);
  const report = await buildReport(raw);
  ctx.socket.update('building', 66);
  await saveReport(report);
  ctx.socket.update('done', 100);
});
```

**Client (WebSocket):**

```ts
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'job_update') {
    console.log('Progress:', msg.data); // e.g. { step: 'building', progress: 66 }
  }
  if (msg.type === 'job_retry') {
    // Attempt failed; retry scheduled. Connection stays open for more updates/final job_finished.
    console.log('Retry scheduled:', msg.error, 'retries left:', msg.retryCount);
  }
  if (msg.type === 'job_finished') {
    console.log('Job done:', msg.status); // only sent when job completes or finally fails (no more retries)
  }
};
```

**Broadcast (all job updates):** Connect with header `x-get-broadcast: true` to receive every `job_update` / `job_retry` / `job_finished` for any job. Example from Node/Deno (browsers cannot set custom WebSocket headers; use a backend or a client that supports it):

```ts
import { WebSocket } from 'npm:ws'; // or Deno std ws
const ws = new WebSocket('http://localhost:4000', {
  headers: { 'x-get-broadcast': 'true' },
});
```

---

## Self-cleaning logs: `maxLogsPerTask`

Set `processor.maxLogsPerTask` to cap the number of log entries per job. Oldest logs are trimmed when the limit is exceeded, keeping Redis self-cleaning and preventing unbounded growth.

- **Behavior**: When logs exceed the limit, oldest entries are removed (FIFO).
- **Redis**: When `maxLogsPerTask` is set, individual log keys (`queues:queue:taskId:logs:*`) are not written; logs live only in the job status blob, reducing Redis keys.

```ts
processor: {
  maxLogsPerTask: 100,
}
```

---

## Redis: avoiding overload (production)

These patterns can stress or crash a Redis container if left unbounded. Mitigate as below.

| Risk                                                | Cause                                                                                                                                                                             | Mitigation                                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unbounded stream growth / process memory blowup** | Queue streams grow with every emit/retry/cron; consumer reads in batches. Unbounded streams can cause Redis and process memory to spike (e.g. 130MB → 3GB).                       | Consumer trims after ACK with **XTRIM MINID ~** (only ACKed entries removed; unprocessed jobs never dropped). Stream stays bounded by natural backlog. Lower `processor.readCount` if message payloads are large.       |
| **Logs and job state keys never expire**            | Job state keys (waiting, delayed, processing, completed, failed) and logs in the job blob accumulate. (Per-entry log keys are no longer written; logs live only in the job blob.) | **Set `processor.jobStateTtlSeconds`** (e.g. `604800` for 7 days) so all job state keys expire. **Set `processor.maxLogsPerTask`** (e.g. `100`) to trim log entries inside the blob. |
| **Redis server memory**                             | Redis can grow until OOM if no cap is set.                                                                                                                                        | Set `maxmemory` and `maxmemory-policy` (e.g. `allkeys-lru`) in Redis config or at runtime: `CONFIG SET maxmemory 512mb` and `CONFIG SET maxmemory-policy allkeys-lru`.               |

**Recommended for production:** set `processor.maxLogsPerTask`, **`processor.jobStateTtlSeconds`** (e.g. 7 days), use Redis `maxmemory` + eviction, and monitor stream lengths and key count. Stream trimming is automatic (MINID after ACK).

**Quick wins (Redis server):** Cap memory and eviction so Redis does not OOM: `CONFIG SET maxmemory 512mb` and `CONFIG SET maxmemory-policy allkeys-lru`. Inspect key count: `DBSIZE`; key distribution: `SCAN` with pattern `queues:*` and `XLEN` on each `*-stream`.

---

## Quick init example

```ts
import { Remq } from './libs/job-manager/mod.ts';
import Redis from 'ioredis';

const redisOption = {
  port: 6379,
  host: 'localhost',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  db: 1,
};

const db = new Redis(redisOption);

// Pass redis config so Remq auto-creates stream connection on db+1 (recommended).
// If your main db is 15, Redis default max is 16 DBs (0–15); pass streamdb explicitly or increase "databases" in redis.conf.
const tm = Remq.create({
  db,
  redis: { host: 'localhost', port: 6379, db: 1 },
  ctx: {},
  concurrency: 2,
  processor: {
    retry: { maxRetries: 3, retryDelayMs: 1000 },
    dlq: {
      streamKey: 'remq-dlq',
      shouldSendToDLQ: (_, __, attempts) => attempts >= 3,
    },
    maxLogsPerTask: 100,
    // stream trimming: after ACK with MINID (no streamMaxLen at emit)
    jobStateTtlSeconds: 604800, // 7 days; job state keys expire to prevent unbounded growth
  },
});

// Register handler (ctx.emit for new tasks; ctx.socket.update for real-time WS updates when expose is set — see "Real-time job updates" above)
tm.on('my-event', async (ctx) => {
  console.log('Processing:', ctx.data);
  ctx.emit('follow-up', { from: ctx.name });
}, { queue: 'default', repeat: { pattern: '*/30 * * * * *' }, attempts: 3 });

// Emit job
tm.emit('my-event', { id: 1 });

// Start
await tm.start();
```
