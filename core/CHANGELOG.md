# Changelog

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
