core/libs/hound/mod.ts:380

pipe.exec() doesn't reject on per-op errors — returns [[err, val], ...].
Discarding the result + returning all jobIds means caller can hold a jobId for a
job that didn't land. Wrap in MULTI/EXEC so it's all-or-nothing per chunk.

core/libs/hound/mod.ts:364

Add internal chunking — cap at 200 to mirror consumer's claimCount. A 10k emit
should fan out into 50 atomic transactions, not one unbounded pipeline. Redis is
single-threaded; unbounded blocks every other client.

core/libs/hound/mod.ts:364

Missing JSDoc. Public JSR surface — needs @throws and a note that on rejection,
no jobs in the failed chunk landed (caller can safely retry — jobIds are
deterministic).

core/libs/hound/mod.ts:130

emit/emitAsync/emitAndWait are bound onto ctx for in-handler use. emitBatch
isn't. Either add it or call out the omission in JSDoc.

core/libs/gateways/gateway.ts:87

Only validates Array.isArray(jobs). First entry without event throws inside
#buildPayload and the whole batch dies with a generic 500. Validate each entry
has a non-empty event, return 400 with offending index.

core/tests/gateway.test.ts:19

Mock signature is Array<{event: string}> — ignores data and options, so the test
passes without proving the gateway forwards them. Mirror the real
EmitBatchEntry[] shape and assert one option (e.g. queue) round-trips.

core/tests/hound.test.ts:266

All four new tests run only against InMemoryStorage. Need: (1) a test stubbing
db.pipeline() to inject a failed op — assert emitBatch rejects and no orphan
state keys remain. (2) a test with jobStateTtlSeconds set, to confirm 'EX', ttl
flows through every backend's pipeline shim.

README.md:150

"Atomic" wording is misleading — ioredis pipelines are batched round trips, not
transactions. After the MULTI fix this becomes accurate. Until then, soften to
"batched in one round trip."

www/server/docs/emitting-jobs.json

Same — remove "atomically" until the implementation is wrapped in MULTI/EXEC.

---

# PR #11 — second-pass residuals (after contributor commit 62bf3b7)

Status of original list:
- mod.ts:380 silent partial failure → FIXED (now mod.ts:426, inspects results, throws on first error)
- mod.ts:364 chunk cap → FIXED (mod.ts:406, chunkSize = claimCount ?? 200, sequential MULTI/EXECs)
- gateway.ts:87 per-entry validation → FIXED (gateway.ts:94, returns 400 with offending index)
- "atomic" docs wording → PARTIAL (see backend parity below)
- Tests → PARTIAL (4 happy-path tests added; failure/TTL/chunking still missing)

## New: backend parity drift on multi()

core/libs/storage/in-memory.ts:213 and core/libs/storage/deno-kv.ts:244

multi() was added on InMemoryStorage and DenoKvStorage but just aliases pipeline()
— same class, no transactional rollback. So:
- Redis: real MULTI/EXEC, all-or-nothing.
- InMemory / Deno KV: sequential ops with per-op try/catch. Mid-batch failure
  throws AND leaves earlier writes in place. Caller sees "failed" but some
  jobs are queued. Invariant #1 violated on 2/3 backends.

Fix paths:
(a) Implement real atomicity. Deno KV has kv.atomic() natively (see
    deno-kv.ts:101). InMemory can buffer ops + apply at exec() in one pass,
    rollback on first error.
(b) Soften JSDoc on EmitBatchFunction / JobContext.emitBatch to "atomic on
    Redis; best-effort sequential on InMemory/Deno KV backends."

(a) is the correct answer for the contract. Aim for that.

## New: missing null-result guard on ioredis EXEC

core/libs/hound/mod.ts:426

ioredis multi().exec() can return null when the transaction is discarded
(WATCH conflict, conn drop mid-EXEC). The cast as [Error|null, unknown][]
hides this. Add before .find(...):

  if (!results) throw new Error('emitBatch: transaction discarded');

## Verify: emitBatch on per-job ctx

core/libs/hound/mod.ts:137

JobContext.emitBatch is now declared in types and bound onto this.ctx. Need
to confirm #processMessage actually spreads this.ctx.emitBatch into the
handler's ctx — otherwise the JSDoc lies. Quick grep on processor.

## Tests still owed

core/tests/hound.test.ts

(1) Failure-path: stub a backend whose multi().exec() returns [[Error, null], ...]
    or a pipeline op throws on the 3rd set. Assert emitBatch rejects AND no
    orphan state keys remain (grep keys after).
(2) TTL: emitBatch with jobStateTtlSeconds set, verify 'EX', ttl applied to
    every state key on every backend.
(3) Chunking-cap: emitBatch with N > claimCount (e.g. N=500, claimCount=200).
    Confirm multiple MULTI rounds run, all jobIds returned in order, no jobs
    dropped at chunk boundaries.
