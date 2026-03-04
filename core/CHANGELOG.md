# Changelog

All notable changes to this project will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [0.30.0] - 2026-03-04

### Breaking Changes

- `Remq.create()` now throws if called more than once (was silently ignoring options)
- `streamdb` or `redis` config now required — sharing `db` for streams is no longer silent, shows deprecation warning

### Added

- `emitAsync()` — awaited emit; stream write is guaranteed, state key is best-effort (see Fixed)
- `enqueueJobToStream()` — internal hook for `RemqAdmin.promoteJob()`
- Auto-create dedicated stream connection on `db+1` via `redis` config option
- `Remq._reset()` — singleton reset for tests

### Fixed

- `emitAsync()` partial writes — stream is written first; if state key write fails, job still processes and a warning is logged (avoids silent orphan when stream failed but state key succeeded)
- `XGROUP SETID '0'` on restart — jobs emitted before `start()` no longer skipped
- Stream self-cleaning via `XTRIM MINID` after ACK — replaces unsafe `MAXLEN` that silently dropped unprocessed jobs
- Cron dedup on restart — no duplicate scheduler entries across restarts
- Cron survives handler failures — next tick always scheduled via NX lock
- Multi-instance cron safety — Redis NX lock prevents duplicate scheduling across cluster
- completed/failed job skip guard — safe replay after `SETID '0'` reset
- Pipeline pause checks — 1 Redis round trip instead of 2 per message

### Performance

- Throughput: 377 → 841 jobs/sec (+123%)
- Latency: 2.65ms → 1.18ms per job (-55%)
- Redis round trips: 6 → 2 per job (happy path)

## [0.29.0] - ...
