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

### Published package (JSR)

When REMQ is published, install from JSR:

```bash
deno add jsr:@hushkey/remq
```

Then import from the registry:

```typescript
import { Remq, defineJob } from "jsr:@hushkey/remq";
```

## Documentation

- **Site & docs** — [`www/`](www/) — Run `deno task serve` in `www/` (or `deno run -A www/main.ts` from repo root) to serve the site; version badge and docs are injected from `www/deno.json` (synced from `core/deno.json` at startup when run in the monorepo).
- **Core API** — [`core/README.md`](core/README.md) — Retry, DLQ, processor options, job state.
- **Lib READMEs** — [`core/libs/remq/README.md`](core/libs/remq/README.md) (Remq, emit, on, defineJob) | [`core/libs/remq-admin/README.md`](core/libs/remq-admin/README.md) (RemqAdmin) | [`core/libs/processor/README.md`](core/libs/processor/README.md) | [`core/libs/consumer/README.md`](core/libs/consumer/README.md).

## Up-and-running example

Minimal flow based on [`examples/remq.plugin.ts`](examples/remq.plugin.ts) and [`examples/index.ts`](examples/index.ts):

```typescript
import { Remq, defineJob } from "@core/mod.ts";
import { Redis } from "ioredis";

const opts = { host: "127.0.0.1", port: 6379, db: 1, maxRetriesPerRequest: null };
const db = new Redis(opts);
const streamdb = new Redis({ ...opts, db: opts.db + 1 });

const remq = Remq.create({
  db,
  streamdb,
  expose: 4000,
  ctx: {},
  concurrency: 1,
  processor: {
    retry: { maxRetries: 3, retryDelayMs: 1000 },
    maxLogsPerJob: 100, // self-cleaning: trim oldest logs per job
  },
});

const requestJob = defineJob<Record<string, unknown>, { name: string; email: string }>(
  "request",
  async (ctx) => {
    console.log(ctx.data);
    // ctx.emit("other", {});           // trigger more jobs
    // ctx.socket.update("step", 50);   // real-time update to WS client (BETA)
  },
  { queue: "default", attempts: 3 }
);

remq.on(requestJob);
await remq.start();

remq.emit("request", { name: "Jane Doe", email: "jane.doe@example.com" }, { id: "onrequest" });
```

## Running the examples

Make sure Redis is running first (see Installation). From the repo root:

```bash
deno task dev
# or
deno run -A examples/index.ts
```

Examples in `examples/`:

| File | Description |
|------|-------------|
| [`remq.plugin.ts`](examples/remq.plugin.ts) | Remq setup (db, streamdb, ctx, processor options, RemqAdmin) |
| [`index.ts`](examples/index.ts) | Entry point — registers jobs, starts remq, runs benchmark |
| [`benchmarks/request.job.ts`](examples/benchmarks/request.job.ts) | Request job with `defineJob`; used by benchmark |
| [`_scheduled/hello-world.ts`](examples/_scheduled/hello-world.ts), [`_scheduled/multi-jobs.ts`](examples/_scheduled/multi-jobs.ts) | Cron/scheduled jobs |

## Retry options: levels and combo

Retry settings come from two places; both must allow retries:

| Level | Options | Role |
|-------|---------|------|
| **Per-job** (`emit` / `on`) | `attempts` or `retryCount`, `retryDelayMs` | How many retries this job gets; delay between retries |
| **Processor** (`processor.retry`) | `maxRetries`, `retryDelayMs`, `shouldRetry` | Global: enable retries (maxRetries > 0); filter which errors to retry |

- **`attempts` and `retryCount`** — Same thing; use one. Both set per-job retry count.
- **`shouldRetry`** — Processor only: `(error, attempt) => boolean`. Use it to retry transient errors (e.g. network) and skip permanent ones (e.g. validation). Do not put it in `emit` options.
- **`debounce`** — Handler only (`on` options). Not an emit option.
- **Combo**: Retries happen only if `attempts` / `retryCount` > 0 **and** `processor.retry.maxRetries > 0` **and** (if set) `shouldRetry(error, attempt)` returns true.

See [Core README — Retry options](core/README.md#retry-options-levels-and-combo)
for details.

---

## Self-cleaning logs: `maxLogsPerJob`

Set `processor.maxLogsPerJob` to cap log entries per job. Oldest logs are trimmed, keeping Redis self-cleaning. See [Core README — maxLogsPerJob](core/README.md#self-cleaning-logs-maxlogspertask). For production, also see [Redis: avoiding overload](core/README.md#redis-avoiding-overload-production) (stream growth, log keys, completed/failed key accumulation).

---

## Real-time job updates: `ctx.socket.update` (BETA)

When you start Remq with `expose` (WebSocket port), jobs can send **progressive updates** to the client. Call
`ctx.socket.update(data, progress)` inside a handler to push JSON-serializable
payloads to the socket in real time.

**Use cases:** long-running jobs (report generation, batch work), live progress
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
