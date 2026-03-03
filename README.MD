# REMQ

Redis-backed job queue and scheduler for Deno.

## Installation

### Prerequisites

- Deno 2.5 or higher
- Redis server running

### Use in this repo (workspace)

Add the workspace import alias to your `deno.json`:

```json
{
  "imports": {
    "@core/": "./core/"
  }
}
```

Then import from the workspace package:

```typescript
import { Remq } from "@core/mod.ts";
```

### Published package (JSR/npm)

When REMQ is published, install it from JSR or npm:

```bash
deno add jsr:@remq/remq
# or
deno add npm:@remq/remq
```

Then import from the registry:

```typescript
import { Remq } from "jsr:@remq/remq";
```

## Documentation

- **VitePress docs** — [`www/docs/`](www/docs/) (guides, quick start, API
  reference)
- **Core libs** —
  [`core/libs/task-manager/README.md`](core/libs/task-manager/README.md) (Remq)
  | [`core/libs/sdk/README.md`](core/libs/sdk/README.md) |
  [`core/libs/processor/README.md`](core/libs/processor/README.md) |
  [`core/libs/consumer/README.md`](core/libs/consumer/README.md)

## Up-and-running example

Minimal flow based on [`examples/remq.plugin.ts`](examples/remq.plugin.ts),
[`examples/scheduler/onrequest.ts`](examples/scheduler/onrequest.ts), and
[`examples/index.ts`](examples/index.ts):

```typescript
import { Remq } from "@core/mod.ts";
import { Redis } from "ioredis";

const redisOption = {
  host: "127.0.0.1",
  port: 6379,
  db: 1,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const db = new Redis(redisOption);
const streamdb = new Redis({ ...redisOption, db: redisOption.db + 1 });

const remq = Remq.create({
  db,
  streamdb,
  expose: 4000,
  ctx: {},
  concurrency: 1,
  processor: {
    retry: { maxRetries: 3, retryDelayMs: 1000 },
    maxLogsPerTask: 100, // self-cleaning: trim oldest logs per task
  },
});

taskManager.registerHandler({
  event: "on-request",
  handler: async (job, ctx) => {
    console.log("runs on request");
    console.log(job.data);
    // ctx.emit({ event: "other", data: {} });  // trigger more tasks
    // ctx.socket.update('step', 50);           // real-time update to WS client (BETA)
  },
  options: { attempts: 3 },
});

await taskManager.start();

taskManager.emit({
  event: "on-request",
  data: { name: "Jane Doe", email: "jane.doe@example.com" },
  options: { id: "onrequest" },
});
```

## Running the examples

Make sure Redis is running first (see Installation). From the repo root:

```bash
deno task dev
# or
deno run -A examples/index.ts
```

Examples in `examples/`:

| File                                                                                                           | Description                                                 |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`remq.plugin.ts`](examples/remq.plugin.ts)                                                                    | Remq setup (db, streamdb, ctx, processor options)           |
| [`index.ts`](examples/index.ts)                                                                                | Entry point — imports handlers, starts remq, emits test job |
| [`scheduler/start.ts`](examples/scheduler/start.ts)                                                            | Scheduler flow with cron pattern                            |
| [`scheduler/onrequest.ts`](examples/scheduler/onrequest.ts)                                                    | On-request handler with retries                             |
| [`crons/hello-world.ts`](examples/crons/hello-world.ts), [`crons/multi-jobs.ts`](examples/crons/multi-jobs.ts) | Cron jobs                                                   |

## Retry options: levels and combo

Retry settings come from two places; both must allow retries:

| Level                                     | Options                                     | Role                                                                  |
| ----------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| **Per-task** (`emit` / `registerHandler`) | `attempts` or `retryCount`, `retryDelayMs`  | How many retries this task gets; delay between retries                |
| **Processor** (`processor.retry`)         | `maxRetries`, `retryDelayMs`, `shouldRetry` | Global: enable retries (maxRetries > 0); filter which errors to retry |

- **`attempts` and `retryCount`** — Same thing; use one. Both set per-task retry
  count.
- **`shouldRetry`** — Processor only: `(error, attempt) => boolean`. Use it to
  retry transient errors (e.g. network) and skip permanent ones (e.g.
  validation). Do not put it in `emit` options.
- **`debounce`** — Handler only (`registerHandler`). Not an emit option.
- **Combo**: Retries happen only if `retryCount > 0` **and**
  `processor.retry.maxRetries > 0` **and** (if set)
  `shouldRetry(error, attempt)` returns true.

See [Core README — Retry options](core/README.md#retry-options-levels-and-combo)
for details.

---

## Self-cleaning logs: `maxLogsPerTask`

Set `processor.maxLogsPerTask` to cap log entries per task. Oldest logs are
trimmed, keeping Redis self-cleaning. See
[Core README — maxLogsPerTask](core/README.md#self-cleaning-logs-maxlogspertask).
For production, also see
[Redis: avoiding overload](core/README.md#redis-avoiding-overload-production)
(stream growth, log keys, completed/failed key accumulation).

---

## Real-time task updates: `ctx.socket.update` (BETA)

When you start Remq with `expose` (WebSocket port), tasks triggered over
WebSocket can send **progressive updates** to the client. Call
`ctx.socket.update(data, progress)` inside a handler to push JSON-serializable
payloads to the socket in real time.

**Use cases:** long-running tasks (report generation, batch jobs), live progress
(uploads, exports), multi-step workflows where the UI should show “Step 1/5
done” without polling.

**Client:** listen for `type: 'job_update'` messages
(`{ type: 'job_update', id, data, progress }`). To receive every job update
(broadcast), connect with header **`x-get-broadcast: true`**. See
[Core README — Real-time job updates](core/README.md#real-time-job-updates-ctxsocketupdate-beta)
for a full example.

---

## Upcoming

- **WS connection for remote processor** — WebSocket connection to run the
  processor remotely. Use a single powerful machine (e.g. 8 cores) as the
  worker; many clients connect over WS and only trigger events. No need to run
  the full stack on each client.
