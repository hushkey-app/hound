# Roadmap

_Last updated: 01/05/2026_

Use checkboxes. Append `— done DD/MM/YYYY HH:MM` when ticking an item.

**Sample format:**

- [ ] Investigate ioredis pipeline batching for ZADD bursts — _added 29/04/2026 14:30_
- [x] Remove dead DLQ config — _done 29/04/2026 15:42_

## Stream-era cleanup

- [x] Remove `DlqConfig` + `processor.dlq.streamKey` — _done 29/04/2026 15:42_ (legacy streams DLQ; never wired up to management/replay; failed jobs already captured in `:failed` state keys)
- [x] Remove or simplify `ProcessableMessage` alias in `core/types/index.ts` — _done 29/04/2026 16:10_ (alias deleted; collapsed to `Message` in `Processor`, `Hound`, and `DebounceManager`)
- [x] Audit `core/CHANGELOG.md` references to streams / `XACK` / `XCLAIM` / `XPENDING` — _done 29/04/2026 16:15_ (historical entries kept; fixed v0.49.4 typo where `processor.dlq.streamKey` was "renamed to itself"; added cross-ref to `0.51.0` removal)
- [x] Audit `core/README.md` "Architecture comparison" table (Streams v0.49.3 vs Sorted-set) — _done 29/04/2026 16:18_ (moved to CHANGELOG `0.51.0` "Architecture comparison (legacy)" section; README replaced with one-line pointer)
- [x] Audit `www/`, `examples/`, root config for `streamdb`/`streamKey`/`streamPriority`/`XREAD`/etc — _done 29/04/2026 16:30_ (rewrote `www/server/docs/configuration.json` "Dead-letter queue" section to "Failed jobs"; updated descriptions in `manifest.json` + `configuration.json`; updated `www/server/docs/handlers.json` final-failure paragraph; only remaining "DLQ" mention is the intentional ROADMAP cross-ref)
- [x] Rename root `README.MD` → `README.md` — _done 29/04/2026 16:32_

## DLQ (deferred)

- [ ] Reconsider only if one of these workflows becomes a real ask:
  - Separate retention for failed jobs (longer TTL than completed)
  - Bulk replay primitive (`dlq.replay({ event })`) after a bug fix
  - Single watch surface across queues for alerting
  - Hot-path keyspace isolation during failure spikes
- [ ] If reintroduced: design as a first-class queue with management API integration, not a config flag.

## v0.51.0 shipped

- [x] `repeat.catchUp` — cron jobs no longer auto-recover on restart/Reaper by default (`catchUp: false`); opt in with `catchUp: true` for financial/compliance crons — _done 29/04/2026_
- [x] Remove dead `ctx.socket` docs (README + handlers.json) — stub always threw since `expose` was removed in v0.50.0 — _done 01/05/2026_

## Other

- [ ] Remove `ctx.socket` public surface — `JobSocketContext` type, `socket` field on `JobContext`, and the `ctx.socket.update()` stub in `core/libs/hound/mod.ts`. The `expose` option was removed in v0.50.0; the type is now a documentation lie — _added 01/05/2026_
- [x] `hound.emitBatch(jobs)` — emit multiple jobs atomically in a single Redis pipeline call. The gateway `/emit/batch` endpoint already existed; added `emitBatch()` to the Hound class, updated the gateway to use it, and added `EmitBatchEntry` to public types — _done 01/05/2026_
- [ ] Pipeline batching for ZADD bursts — when many jobs are emitted in a tight loop, batch them in a single ioredis pipeline instead of individual round trips. Investigate the threshold at which batching yields measurable throughput gains — _added 01/05/2026_
- [ ] OpenTelemetry middleware — a `hound.use()` middleware (or example plugin) that emits OTEL spans per job (duration, retry count, queue, status) and queue-depth metrics via the management events. Enables off-the-shelf Grafana/Datadog dashboards — _added 01/05/2026_
- [ ] Per-event rate limiting — `HandlerOptions.rateLimit: { maxPerSecond: number }` to cap handler execution rate without relying on debounce. Useful for outbound API calls with rate limits (Stripe, SendGrid) — _added 01/05/2026_
- [ ] Node.js / Bun native adapter — Hound currently requires Deno (`Deno.serve`, `Deno.env`, `Deno.Kv`). A thin compatibility package would let teams run the worker in Node or Bun. The generated `HoundClient` already works in any runtime; the gap is the worker side — _added 01/05/2026_
- [ ] Job progress / streaming — a way to push incremental progress from a running handler to a caller waiting via `emitAndWait`. Needs a design pass: lightweight approach might be periodic state-key writes that the waiter polls; richer approach is a pub/sub channel per job — _added 01/05/2026_
