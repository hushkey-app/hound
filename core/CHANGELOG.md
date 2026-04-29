# Changelog

## [0.51.0] - 2026-04-29

### Added

#### `repeat.catchUp` option

New boolean on `RepeatOptions` that controls how missed cron ticks are handled on restart or Reaper recovery.

- `catchUp: false` (default) — missed ticks are skipped; the next natural fire runs.
- `catchUp: true` — the missed tick is fired on recovery (legacy behaviour).

```ts
hound.on('reports.daily', handler, {
  repeat: { pattern: '0 9 * * *', catchUp: true }, // backfill on restart
});
```

Two guards enforce the semantics:

1. **Restart preflight in `start()`** — a persisted `:delayed` cron entry whose `delayUntil` is in the past is rewritten to the next natural fire when `catchUp:false`.
2. **Consumer-side guard in `#processJob`** — when claiming a cron job whose `delayUntil` is more than one cron interval old, the handler is skipped and the next natural tick is scheduled. Catches Reaper-resurrected entries that bypass the preflight.

The existing `cron-exec` lock (keyed by `jobId + delayUntil`) is preserved as belt-and-braces dedup.

**Validation:** `catchUp` is cron-only. Setting it on a non-cron job (no `repeat.pattern`) throws at `hound.on()` and `emit()`. Non-cron jobs are always recovered by the Reaper.

### Changed

- **Default cron behaviour for missed ticks is now `skip` (`catchUp:false`).** Previously a stalled cron entry resurrected by the Reaper would be fired immediately on next claim. Opt back in with `repeat: { catchUp: true }` for crons where every tick must run.

### Removed

- **`DlqConfig` type and `processor.dlq` option.** Stream-era leftover that targeted a sorted-set "DLQ" queue but was never integrated with the management API or replay tooling. Failed jobs are already captured in `:failed:{execId}` state keys and inspectable via `management.jobs.find({ status: 'failed' })` + retryable via `jobs.retry`. If a real DLQ workflow is needed (separate retention, bulk replay), it will be reintroduced as a first-class feature rather than a config flag with no consumers.
- Removed export `DlqConfig` from public types.
- Removed `#sendToDLQ` from `Processor`.
- **`ProcessableMessage` internal alias.** Was `type ProcessableMessage = Message` — collapsed to `Message` in `Processor`, `Hound`, and `DebounceManager` signatures. Not part of the public API.

### Architecture comparison (legacy)

The pre-v0.50.0 Streams architecture vs current sorted-set:

| Metric                   | Streams (v0.49.3) | Sorted-set (v0.50.0+) |
| ------------------------ | ----------------- | --------------------- |
| Throughput (Redis, max)  | ~506 jobs/s       | ~34,371 jobs/s        |
| At-least-once delivery   | ✓                 | ✓                     |
| Crash recovery           | ✓ (XCLAIM / PEL)  | ✓ (Reaper)            |
| Exponential backoff      | ✓                 | ✓                     |
| Queue priority           | ✓                 | ✓                     |
| Cron restart reliability | ✓                 | ✓                     |
| Storage backends         | Redis only        | Redis, InMemory, KV   |
| Single connection needed | ✗ (db + streamdb) | ✓                     |

## [0.50.1] - 2026-04-25

### Added

#### Auto-discovery (`jobDirs`)

Hound can now scan directories for `*.job.ts` files and register all exported `defineJob` definitions automatically on `start()`. No manual imports or `hound.on()` calls needed.

```ts
const hound = Hound.create({
  db,
  importMeta: import.meta,
  jobDirs: ['../_tasks', '../_scheduled'],
});

await hound.start(); // registers every *.job.ts in both dirs
```

- `importMeta` is required when `jobDirs` is set — used to resolve relative paths
- Both named and default exports are supported; multiple jobs per file are all registered
- The same `jobDirs` list is consumed by `generateTypes()` during codegen

#### Codegen — `generateTypes()` and `generateClient()`

New top-level exports. Scan `jobDirs` at build time and emit two files:

**`hound-types.ts`** — `HoundJobMap` interface mapping every event name to its payload type, inferred directly from `defineJob<App, Payload>` generics. No manual type wiring.

**`hound-client.ts`** — portable `HoundClient` class (zero runtime deps) that hits the HTTP gateway. Typed via `HoundJobMap` — wrong event names and mismatched payloads are compile-time errors. Works from any runtime: Deno, Node, Bun, browser.

```ts
import { generateClient, generateTypes } from 'jsr:@hushkey/hound';

const here = new URL('.', import.meta.url).pathname;

await generateTypes({
  jobDirs: ['../_tasks', '../_scheduled'],
  outputDir: '../gen',
}, here);
await generateClient({ outputDir: '../gen' }, here);
```

```ts
// gen/hound-types.ts (auto-generated)
export interface HoundJobMap {
  'user.read': { name: string; email: string };
  'mid-world': void;
}
```

`HoundClient` also exposes the full management API:

```ts
const client = new HoundClient('http://localhost:3000', { auth: token });

await client.emit('user.read', { name: 'Alice', email: 'alice@example.com' });
await client.management.jobs.find({ status: 'failed' });
await client.management.queues.stats('payments');
```

### Performance

Updated benchmark with 99,999 jobs and concurrency 10,000 (`pollIntervalMs: 0`):

| Metric      | InMemoryStorage  | Redis (local) |
| ----------- | ---------------- | ------------- |
| Throughput  | ~34,000 jobs/sec | ~511 jobs/sec |
| Latency p50 | 0.29ms           | 18.18ms       |
| Latency p95 | 0.48ms           | 29.77ms       |
| Latency p99 | 0.61ms           | 29.94ms       |
| Latency avg | 0.29ms           | 19.23ms       |

InMemoryStorage throughput scales linearly with concurrency — the previous 4,144 jobs/sec figure was measured at concurrency 10 with 100 jobs.

---

## [0.50.0] - 2026-04-25

### Breaking Changes

- `expose` option removed from `HoundOptions` — use `hound.listen()` instead
- `hound.listen()` is now the single way to start the HTTP gateway

### Added

#### `hound.listen()`

New method to start the HTTP gateway with optional management routes. Replaces the `expose` constructor option. Can be called before or after `hound.start()`. Returns `this`.

```ts
hound.listen(4000);
hound.listen('0.0.0.0', 4000);
hound.listen(4000, management);
hound.listen(4000, management, (addr) => console.log(addr.port));
```

#### Management API — new methods

- `jobs.find({ queue?, status? })` — filter by queue and/or status
- `jobs.retry(key)` — re-enqueue a failed job (requires Hound instance)
- `jobs.resume(key)` — unfreeze a paused job (counterpart to `jobs.pause()`)
- `queues.stats(key)` — per-status job counts: `{ waiting, delayed, processing, completed, failed, total }`

#### HTTP Management REST API

All management operations now available over HTTP when `management` is passed to `listen()`:

```
GET    /management/jobs[?queue=&status=]
GET    /management/jobs/:queue/:jobId
DELETE /management/jobs/:queue/:jobId
POST   /management/jobs/:queue/:jobId/pause|resume|promote|retry
GET    /management/queues
GET    /management/queues/:queue/stats
POST   /management/queues/:queue/pause|resume|reset
```

#### Generated `HoundClient.management`

`generateClient()` now emits `ManagementJobsClient` and `ManagementQueuesClient` classes on `client.management.jobs.*` and `client.management.queues.*`. Dashboard clients get full typed access to all management operations without any extra setup.

#### `createGateway` exported

`createGateway` and `GatewayOptions` are now part of the public API — use for standalone gateway setup outside of a Hound instance.

#### Complete public API surface

All previously missing types are now exported from the main package:
`HoundOptions`, `HandlerOptions`, `JobContext`, `JobHandler`, `RepeatOptions`, `JobLog`, `JobError`, `JobSocketContext`, `RetryConfig`, `DlqConfig`, `EmitFunction`, `EmitAsyncFunction`, `EmitAndWaitFunction`, `BenchmarkOptions`, `BenchmarkResult`, `StorageClient`, `RedisConnection`, `GatewayOptions`.

### Fixed

- `jobs.delete()` always returned `true` for any valid key format — now correctly returns `false` when no state keys exist in Redis

### Migration from 0.49.4

**Replace `expose` with `listen()`:**

```ts
// Before
const hound = Hound.create({ db, expose: 4000 });

// After
const management = new HoundManagement({ db, hound });
hound.listen(4000, management); // call after Hound.create, before or after start()
```

---

## [0.49.4] - 2026-04-25

### Summary

Redis Streams replaced with Redis sorted-set (`ZADD`) queues. `Remq` renamed to `Hound`, `RemqManagement` to `HoundManagement`. Crash recovery is now handled by a background **Reaper** instead of Redis PEL/XCLAIM. Storage is now abstracted — Redis, InMemoryStorage, and Deno KV all work. Single `db` connection required (no more `streamdb`).

---

### Breaking Changes

- `Remq` renamed to `Hound` — `import { Hound } from '@hushkey/hound'`
- `RemqManagement` renamed to `HoundManagement` — now exported from main `@hushkey/hound` package
- `streamdb` option removed — only `db` is required
- `processor.streamPriority` renamed to `processor.queuePriority`
- `processor.read.count` and `processor.read.blockMs` removed (stream-specific options)
- `processor.dlq.streamKey` kept the same name but its target is now a sorted-set queue, not a Redis Stream (later removed entirely — see `0.51.0`)
- `HoundManagement` constructor: `new HoundManagement({ db, hound })` — no `streamdb`

---

### Added

#### Sorted-Set Queue Architecture

- Queue: `queues:{queue}:q` ZADD scored by `delayUntil` ms
- Processing set: `queues:{queue}:processing` ZADD scored by `claimed_at` ms
- Atomic claim via Lua script — `ZRANGEBYSCORE + ZREM + ZADD` in a single round trip
- FIFO tie-breaking: fractional sequence added to score to preserve insertion order within the same millisecond

#### Reaper

- Background sweep that reclaims stalled jobs from the processing set back to the queue
- Runs every `visibilityTimeoutMs / 2` (min 5s) and on startup
- Replaces Redis PEL / `XCLAIM` — no stream consumer groups needed

#### Storage Abstraction

- New `StorageClient` interface — all internals program against it, never against ioredis directly
- `InMemoryStorage` — full sorted-set + pipeline support; zero dependencies; suitable for tests and local dev
- `DenoKvStorage` — Deno KV backend via `DenoKvStorage.open(path?)`

#### `ctx.emitAndWait`

- Handlers now have access to `ctx.emitAndWait(event, data, options)` — emits and blocks until the target job completes or times out
- Useful for job chains where the next step must succeed before proceeding

#### `processor.claimCount`

- New option (default `200`) — max jobs to claim per poll cycle, replaces `processor.read.count`

---

### Changed

- `processor.streamPriority` → `processor.queuePriority` (same shape, same semantics)
- Lifecycle comment: `start()` now initializes crons and starts both the Processor and the Reaper
- Management `queues.reset()` now flushes sorted-set queue and processing set instead of stream + consumer group
- Management `queues.find()` description updated — sorted-set based queue count

---

### Migration from 0.49.3

**Rename class and constructor:**

```ts
// Before
import { Remq, RemqManagement } from '@hushkey/hound';
const remq = Remq.create({ db, streamdb });
const management = new RemqManagement({ db, streamdb, remq });

// After
import { Hound, HoundManagement } from '@hushkey/hound';
const hound = Hound.create({ db });
const management = new HoundManagement({ db, hound });
```

**Rename processor option:**

```ts
// Before
processor: {
  streamPriority: {
    payments: 1;
  }
}

// After
processor: {
  queuePriority: {
    payments: 1;
  }
}
```

**Remove stream-specific options:**

```ts
// Before — remove these
processor: {
  read: { count: 200, blockMs: 50 },
}

// After — use claimCount instead
processor: {
  claimCount: 200,
}
```

---

## [0.49.3] - 2026-03-07

### Summary

This release prioritises reliability and API consistency over raw throughput. Throughput drops from ~889 jobs/sec to ~506 jobs/sec — a deliberate trade-off for at-least-once delivery guarantees, crash recovery, and a cleaner management interface.

---

### Breaking Changes

- `RemqAdmin` removed — replaced by `RemqManagement` with a new `management.api.*` interface
- `ctx.ack()` and `ctx.nack()` are now real operations — previously no-ops
- Job state keys for terminal states now include an execution ID suffix: `queues:{queue}:{jobId}:completed:{execId}` and `queues:{queue}:{jobId}:failed:{execId}`
- `ctx.logger` is now synchronous — was previously async with no justification

---

### Added

#### At-Least-Once Delivery

- Messages are no longer ACKed on read — they remain in the PEL until handler completion
- `ctx.ack()` calls `XACK` after successful handler execution, removing the message from the PEL
- `ctx.nack()` calls `XACK` on the original message after final failure — processor owns requeue strategy
- Crash recovery via `XCLAIM` — messages idle beyond `visibilityTimeoutMs` are reclaimed and redelivered on the next read cycle

#### Configurable Visibility Timeout

- New `processor.visibilityTimeoutMs` option (default `30000ms`) — replaces hardcoded 30s in xclaim
- Set to 3-5x your p99 job duration to avoid premature reclaim on slow jobs

#### Exponential Backoff

- New `retryBackoff: 'exponential' | 'fixed'` option on `EmitOptions` and `HandlerOptions`
- Exponential delay: `retryDelayMs * 2^retriedAttempts`, capped at 1 hour
- Default remains `fixed` — no breaking change for existing retry config

#### Stream Priority

- New `processor.streamPriority` option — controls read order across queues
- Lower number = higher priority = read first per cycle
- Prevents queue starvation under load: `{ payments: 1, sync: 2 }`

#### `ctx.emitAsync`

- Handlers now have access to `ctx.emitAsync()` — awaitable emit for critical job chains
- Resolves when both state key and stream entry are confirmed written

#### `RemqManagement`

- Replaces `RemqAdmin` entirely
- New namespace: `management.api.jobs.*` and `management.api.queues.*`
- New event system: `management.events.job.finished/completed/failed`

**Jobs API:**

- `management.api.jobs.find()` — returns all jobs, deduplicated by jobId, most recent terminal state wins
- `management.api.jobs.get(key)` — composite key `{queue}:{jobId}`, runs find then array.find
- `management.api.jobs.delete(key)` — deletes all state keys including all terminal executions
- `management.api.jobs.promote(key)` — fires job immediately, bypasses delay
- `management.api.jobs.pause(key)` — sets `delayUntil: Number.MAX_SAFE_INTEGER`, job never processes until promoted

**Queues API:**

- `management.api.queues.find()` — returns all registered queues including empty streams
- `management.api.queues.pause(key)` — sets paused flag, consumer skips the queue
- `management.api.queues.resume(key)` — removes paused flag
- `management.api.queues.reset(key)` — flushes all jobs, trims stream to empty, destroys consumer group
- `management.api.queues.running(key)` — returns true if queue is active, false if paused

**Events:**

- `management.events.job.finished(cb)` — fires on completed or failed
- `management.events.job.completed(cb)` — fires on completed only
- `management.events.job.failed(cb)` — fires on failed only
- All return an unsubscribe function

---

### Changed

#### Cron Reliability

- Fixed: cron lock TTL was `interval + 10000ms` — caused lock to outlive the interval, killing cron silently. Now `90% of interval`
- Fixed: `SETID 0` on `BUSYGROUP` during restart redelivered the entire stream. Now returns silently — cursor is correct, leave it alone
- Fixed: on restart, stale cron stream entries are deleted and re-emitted with the original `delayUntil` preserved — crons fire at the correct time after restart, not pushed forward by one interval
- Fixed: explicit `delay` option now takes precedence over cron pattern recompute in `#buildPayload`
- Cron locks are now per-execution context — new lock generated each tick, not carried across restarts

#### State Key Writes

- `emit()` now writes state key first, then stream entry (chained, not parallel) — state key being present before stream entry makes restart dedup reliable
- `emitAsync()` awaits both writes sequentially — guarantees ordering for critical paths

#### Stream Trimming

- `XTRIM` now uses `MINID` bounded by the oldest PEL entry post-ACK — never trims unprocessed messages
- Trim is skipped entirely when PEL is empty — no safe boundary means no trim
- Fixed: ioredis returns `XPENDING` entries as tuples `[id, consumer, idleMs, deliveryCount]`, not objects — was causing `XTRIM` with empty string MINID

#### Processor Architecture

- Debounce removed from `processor.ts` — now owned entirely by `mod.ts` per-handler
- `ConcurrencyPool` class removed — inlined as `maxConcurrency: number` in `consumer.ts`
- `processor.ts` no longer calls `ctx.ack()` — ACK is called after handler success only
- Delay requeue now sleeps up to 30s before requeueing — eliminates tight spin loop on delayed messages

#### Job ID Stability

- `genJobIdSync` now deep-sorts payload keys ascending before hashing — payloads built from different code paths with different key insertion order now produce the same jobId

#### Graceful Shutdown

- Fixed double SIGINT registration — `shutdownRegistered` guard prevents duplicate signal handlers across multiple `start()` calls

---

### Performance

| Metric                   | 0.24          | 0.49.3        |
| ------------------------ | ------------- | ------------- |
| Throughput               | ~889 jobs/sec | ~506 jobs/sec |
| Avg latency              | ~1.12ms       | ~1.98ms       |
| At-least-once delivery   | ✗             | ✓             |
| Crash recovery           | ✗             | ✓             |
| Cron restart reliability | Partial       | ✓             |
| Exponential backoff      | ✗             | ✓             |
| Stream priority          | ✗             | ✓             |

The throughput reduction is a direct consequence of ACK-after-completion — each job now requires a confirmed XACK roundtrip before the next state transition. This is the correct trade-off for a production job queue handling payments and property sync.

---

### Migration from 0.24

**Replace `RemqAdmin`:**

```ts
// Before
const admin = new RemqAdmin(db, remq);
await admin.listJobs({ queue: 'default' });
admin.onJobFinished(cb);

// After
const management = new RemqManagement({ db, streamdb, remq });
await management.api.jobs.find();
management.events.job.finished(cb);
```

**`ctx.ack()` / `ctx.nack()` are now real — remove any manual calls:**

```ts
// Before — ack was a no-op, some handlers called it manually
remq.on('event', async (ctx) => {
  await doWork();
  await ctx.ack(); // was no-op, harmless but misleading
});

// After — ack is called automatically by processor after handler returns
remq.on('event', async (ctx) => {
  await doWork();
  // no manual ack needed
});
```

**Set `visibilityTimeoutMs` explicitly:**

```ts
remq = Remq.create({
  processor: {
    visibilityTimeoutMs: 30_000, // set to 3-5x your p99 job duration
  },
});
```
