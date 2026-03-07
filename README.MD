# remq

Deno-native Redis Streams job queue. At-least-once delivery, crash recovery,
cron scheduling, and a management API.

```ts
import { Remq } from "@hushkey/remq";

const remq = Remq.create({ db, streamdb });

remq.on("email.send", async (ctx) => {
  await sendEmail(ctx.data.to);
});

await remq.start();
remq.emit("email.send", { to: "leo@hushkey.jp" });
```

---

## Installation

```ts
import { Remq } from "jsr:@hushkey/remq@^0.49.3";
```

---

## Creation

```ts
const remq = Remq.create(options); // creates singleton
const remq = Remq.getInstance(); // retrieves singleton
Remq._reset(); // test use only
```

---

## Registration

```ts
// Inline
remq.on("property.sync", async (ctx) => {
  await sync(ctx.data);
}, { queue: "sync", attempts: 3 });

// Type-safe via defineJob
const syncJob = defineJob<AppCtx, { propertyId: number }>({
  event: "property.sync",
  handler: async (ctx) => {
    ctx.data.propertyId; // typed as number
  },
  options: { queue: "sync", attempts: 3 },
});

remq.on(syncJob);
```

---

## Emission

```ts
// Fire and forget — returns jobId immediately
const jobId = remq.emit("property.sync", { propertyId: 1 });

// Awaitable — resolves when state key + stream entry are both written
const jobId = await remq.emitAsync("property.sync", { propertyId: 1 });
```

### Emit options

| Option         | Type                       | Description                                                 |
| -------------- | -------------------------- | ----------------------------------------------------------- |
| `queue`        | `string`                   | Target queue. Default `'default'`                           |
| `id`           | `string`                   | Explicit job ID. Defaults to FNV-1a hash of event + payload |
| `delay`        | `Date`                     | Don't process before this time                              |
| `attempts`     | `number`                   | Max retry attempts                                          |
| `retryDelayMs` | `number`                   | Delay between retries in ms. Default `1000`                 |
| `retryBackoff` | `'fixed' \| 'exponential'` | Backoff strategy. Default `'fixed'`                         |
| `repeat`       | `{ pattern: string }`      | Cron expression — makes job self-scheduling                 |
| `priority`     | `number`                   | Higher = processed first. Default `0`                       |

---

## Handler context

Every handler receives a typed `ctx` object:

```ts
remq.on('property.sync', async (ctx) => {
  ctx.id              // stable job ID
  ctx.name            // event name
  ctx.queue           // queue name
  ctx.data            // typed payload (via defineJob)
  ctx.retryCount      // remaining retries
  ctx.retriedAttempts // how many times retried so far
  ctx.logger('msg')   // sync logger — appended to job blob
  ctx.emit(...)       // fire and forget from handler
  ctx.emitAsync(...)  // awaitable emit from handler
  ctx.socket.update() // WebSocket progress update (requires expose)
})
```

### Handler options

| Option         | Type                       | Description                       |
| -------------- | -------------------------- | --------------------------------- |
| `queue`        | `string`                   | Target queue. Default `'default'` |
| `attempts`     | `number`                   | Max retry attempts                |
| `repeat`       | `{ pattern: string }`      | Cron expression                   |
| `debounce`     | `number`                   | Debounce window in ms             |
| `retryBackoff` | `'fixed' \| 'exponential'` | Backoff strategy                  |

---

## Lifecycle

```ts
await remq.start(); // ensure consumer groups, dedup crons, start processor
await remq.stop(); // stop processor, drain in-flight jobs, shut down WS gateway
await remq.drain(); // wait for all active jobs to complete
```

---

## Creation options

| Option        | Type          | Description                                                                          |
| ------------- | ------------- | ------------------------------------------------------------------------------------ |
| `db`          | `Redis`       | Primary connection — state keys, locks, pause flags                                  |
| `streamdb`    | `Redis`       | Dedicated stream connection. Prevents `XREADGROUP BLOCK` from stalling admin queries |
| `redis`       | `RedisConfig` | Auto-creates `streamdb` on `db+1`. Ignored if `streamdb` provided                    |
| `ctx`         | `TApp`        | App-level context injected into every handler as `ctx.*`                             |
| `concurrency` | `number`      | Max concurrent jobs across all queues. Default `1`                                   |
| `expose`      | `number`      | WebSocket gateway port for real-time job updates                                     |
| `debug`       | `boolean`     | Enable debug logging. Default `false`                                                |

### Processor options

| Option                          | Type                       | Description                                                                                  |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `processor.jobStateTtlSeconds`  | `number`                   | State key TTL. Required in production — prevents unbounded key growth                        |
| `processor.maxLogsPerJob`       | `number`                   | Max log entries per job. Oldest removed first                                                |
| `processor.pollIntervalMs`      | `number`                   | Poll interval when stream is empty. Default `3000`                                           |
| `processor.visibilityTimeoutMs` | `number`                   | How long before a stuck job is reclaimed. Default `30000`. Set to 3–5× your p99 job duration |
| `processor.read.count`          | `number`                   | Max messages per `XREADGROUP` call. Default `200`                                            |
| `processor.read.blockMs`        | `number`                   | `BLOCK` timeout in ms. Default `50`                                                          |
| `processor.streamPriority`      | `Record<string, number>`   | Read order across queues. Lower = higher priority                                            |
| `processor.retry.retryDelayMs`  | `number`                   | Global retry delay override                                                                  |
| `processor.retry.retryBackoff`  | `'fixed' \| 'exponential'` | Global backoff override                                                                      |
| `processor.dlq.streamKey`       | `string`                   | Dead letter queue stream key                                                                 |

---

## Stream priority

Prevents queue starvation under load. Queues not in the map are read last.

```ts
Remq.create({
  processor: {
    streamPriority: {
      payments: 1, // read first
      sync: 2, // read second
      default: 3, // read last
    },
  },
});
```

---

## Cron scheduling

Jobs with a `repeat.pattern` are self-scheduling — after each execution the next
tick is automatically queued. Cron state survives restart.

```ts
remq.on("reports.daily", async (ctx) => {
  await generateReport();
}, {
  queue: "scheduled",
  repeat: { pattern: "0 9 * * *" }, // every day at 9am
});
```

---

## Retry and backoff

```ts
remq.emit("payment.process", { amount: 100 }, {
  attempts: 5,
  retryDelayMs: 1000,
  retryBackoff: "exponential", // 1s, 2s, 4s, 8s, 16s — capped at 1hr
});
```

---

## WebSocket

```ts
// Server
Remq.create({ expose: 4000 });

// Handler — send progress updates to connected clients
remq.on("video.encode", async (ctx) => {
  await encodeChunk(1);
  ctx.socket.update({ progress: 33 });
  await encodeChunk(2);
  ctx.socket.update({ progress: 66 });
  await encodeChunk(3);
  ctx.socket.update({ progress: 100 });
});

// Client
const ws = new WebSocket("ws://localhost:4000");
ws.send(JSON.stringify({ event: "video.encode", data: { id: 1 } }));
ws.onmessage = ({ data }) => console.log(JSON.parse(data));
// { type: 'queued', jobId: '...' }
// { type: 'job_update', progress: 33, ... }
// { type: 'job_finished', status: 'completed', ... }
```

---

## Management API

```ts
import { RemqManagement } from "@hushkey/remq/management";

const management = new RemqManagement({ db, streamdb, remq });
```

### Jobs

```ts
await management.api.jobs.find(); // all jobs, most recent state per jobId
await management.api.jobs.get("default:jobId"); // single job by {queue}:{jobId}
await management.api.jobs.delete("default:jobId");
await management.api.jobs.promote("default:jobId"); // fire immediately
await management.api.jobs.pause("default:jobId"); // delay until Number.MAX_SAFE_INTEGER
```

### Queues

```ts
await management.api.queues.find(); // all queues including empty streams
await management.api.queues.pause("payments");
await management.api.queues.resume("payments");
await management.api.queues.reset("payments"); // flush all jobs + trim stream
await management.api.queues.running("payments"); // true if active, false if paused
```

### Events

```ts
// All terminal events
const unsub = management.events.job.finished((p) => {
  console.log(p.jobId, p.status, p.error);
});

// Filtered
management.events.job.completed((p) => notifyClient(p.jobId));
management.events.job.failed((p) => alertOncall(p.error));

// Unsubscribe
unsub();
```

---

## Delivery guarantees

remq uses Redis Streams consumer groups for at-least-once delivery.

- Messages stay in the PEL (Pending Entries List) until the handler completes
  successfully
- If the process crashes mid-job, the message is reclaimed on next startup via
  `XCLAIM`
- `visibilityTimeoutMs` controls how long before a stuck message is reclaimed —
  set it above your p99 job duration to avoid premature reclaim on slow jobs
- ACK happens automatically after handler success — no manual `ctx.ack()` needed

---

## Performance

| Metric                   | v0.24         | v0.49.3       |
| ------------------------ | ------------- | ------------- |
| Throughput               | ~889 jobs/sec | ~506 jobs/sec |
| Avg latency              | ~1.12ms       | ~1.98ms       |
| At-least-once delivery   | ✗             | ✓             |
| Crash recovery           | ✗             | ✓             |
| Exponential backoff      | ✗             | ✓             |
| Stream priority          | ✗             | ✓             |
| Cron restart reliability | Partial       | ✓             |

The throughput reduction is the cost of ACK-after-completion — each job requires
a confirmed `XACK` roundtrip before the next state transition. Correct behaviour
for a production job queue.

---

## License

MIT
