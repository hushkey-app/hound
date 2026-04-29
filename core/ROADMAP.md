# Roadmap

_Last updated: 29/04/2026_

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

## Other

- [ ] 
