/**
 * Hound integration tests — run against InMemoryStorage, no Redis needed.
 * All tests within this file run sequentially (Deno default).
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { Hound } from '../libs/hound/mod.ts';
import { defineJob } from '../mod.ts';
import { withHound, sleep } from './helpers.ts';

// ─── Emit ─────────────────────────────────────────────────────────────────────

Deno.test('emit returns a non-empty jobId synchronously', () => {
  Hound._reset();
  const { hound } = (() => {
    const db = (new (class {})() as any); // not needed for this check
    return { hound: null as any };
  })();
  // Use withHound so singleton is managed
  return withHound(async (h) => {
    h.on('test.emit', async () => {});
    const id = h.emit('test.emit', { x: 1 });
    assert(typeof id === 'string' && id.length > 0);
  });
});

Deno.test('emitAsync resolves with a non-empty jobId', () =>
  withHound(async (h) => {
    h.on('test.emitAsync', async () => {});
    const id = await h.emitAsync('test.emitAsync', { x: 1 });
    assert(typeof id === 'string' && id.length > 0);
  }));

Deno.test('same event + same data produces the same deterministic jobId', () =>
  withHound(async (h) => {
    h.on('test.dedup', async () => {});
    const id1 = await h.emitAsync('test.dedup', { payload: 42 });
    const id2 = await h.emitAsync('test.dedup', { payload: 42 });
    assertEquals(id1, id2); // FNV-1a hash is stable
  }));

Deno.test('different data produces different jobIds', () =>
  withHound(async (h) => {
    h.on('test.dedup2', async () => {});
    const id1 = await h.emitAsync('test.dedup2', { n: 1 });
    const id2 = await h.emitAsync('test.dedup2', { n: 2 });
    assert(id1 !== id2);
  }));

// ─── Handler registration ─────────────────────────────────────────────────────

Deno.test('duplicate event name on a different queue throws at .on() time', () =>
  withHound(async (h) => {
    h.on('evt.dup', async () => {}, { queue: 'q1' });
    let threw = false;
    try {
      h.on('evt.dup', async () => {}, { queue: 'q2' });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('already registered'));
    }
    assertEquals(threw, true);
  }));

Deno.test('same event on the same queue is idempotent — no throw', () =>
  withHound(async (h) => {
    h.on('evt.same', async () => {}, { queue: 'q1' });
    h.on('evt.same', async () => {}, { queue: 'q1' }); // no error
  }));

// ─── End-to-end processing ────────────────────────────────────────────────────

Deno.test('job runs and completes end-to-end', () =>
  withHound(async (h) => {
    let called = false;
    h.on('e2e.complete', async () => { called = true; });
    await h.start();
    await h.emitAndWait('e2e.complete', {}, { timeoutMs: 3000 });
    assertEquals(called, true);
  }));

Deno.test('handler receives correct ctx (name, queue, data, status)', () =>
  withHound(async (h) => {
    let ctx: any;
    h.on('e2e.ctx', async (c) => { ctx = c; }, { queue: 'myq' });
    await h.start();
    await h.emitAndWait('e2e.ctx', { answer: 42 }, { timeoutMs: 3000 });
    assertEquals(ctx.name, 'e2e.ctx');
    assertEquals(ctx.queue, 'myq');
    assertEquals(ctx.data, { answer: 42 });
    assertEquals(ctx.status, 'processing');
  }));

Deno.test('emitAndWait rejects when the job handler throws', () =>
  withHound(async (h) => {
    h.on('e2e.fail', async () => { throw new Error('intentional failure'); });
    await h.start();
    await assertRejects(
      () => h.emitAndWait('e2e.fail', {}, { timeoutMs: 3000 }),
      Error,
      'intentional failure',
    );
  }));

Deno.test('emitAndWait times out when processor is not started', () =>
  withHound(async (h) => {
    h.on('e2e.stuck', async () => {});
    // Do NOT call h.start() — job sits in queue forever
    await assertRejects(
      () => h.emitAndWait('e2e.stuck', {}, { timeoutMs: 100 }),
      Error,
      'timed out',
    );
  }));

// ─── Queue auto-resolution ────────────────────────────────────────────────────

Deno.test('emit auto-resolves queue from handler registration', () =>
  withHound(async (h) => {
    let receivedQueue = '';
    h.on('auto.q', async (ctx: any) => { receivedQueue = ctx.queue; }, { queue: 'fastlane' });
    await h.start();
    await h.emitAndWait('auto.q', {}, { timeoutMs: 3000 });
    assertEquals(receivedQueue, 'fastlane');
    // No { queue } in emitAndWait options — resolved automatically
  }));

// ─── Retry ────────────────────────────────────────────────────────────────────

Deno.test('job retried N times then permanently fails', () =>
  withHound(async (h) => {
    let attempts = 0;
    h.on('retry.exhaust', async () => {
      attempts++;
      throw new Error('still failing');
    });
    await h.start();
    await assertRejects(
      () => h.emitAndWait('retry.exhaust', {}, { attempts: 2, retryDelayMs: 10, timeoutMs: 5000 }),
      Error,
    );
    assertEquals(attempts, 3); // 1 initial + 2 retries
  }));

Deno.test('job succeeds after retries', () =>
  withHound(async (h) => {
    let attempts = 0;
    h.on('retry.success', async () => {
      attempts++;
      if (attempts < 3) throw new Error('not yet');
    });
    await h.start();
    await h.emitAndWait('retry.success', {}, { attempts: 3, retryDelayMs: 10, timeoutMs: 5000 });
    assertEquals(attempts, 3);
  }));

Deno.test('exponential backoff increases delay between retries', () =>
  withHound(async (h) => {
    const timestamps: number[] = [];
    h.on('retry.backoff', async () => {
      timestamps.push(Date.now());
      if (timestamps.length < 3) throw new Error('retry');
    });
    await h.start();
    await h.emitAndWait('retry.backoff', {}, {
      attempts: 2,
      retryDelayMs: 30,
      retryBackoff: 'exponential',
      timeoutMs: 5000,
    });
    // Gap between attempt 2 and 3 should be roughly 2x the gap between 1 and 2
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    assert(gap2 > gap1, `expected exponential growth: gap1=${gap1}ms gap2=${gap2}ms`);
  }));

// ─── Per-handler concurrency ──────────────────────────────────────────────────

Deno.test('per-handler concurrency cap is respected', () =>
  withHound(async (h) => {
    let active = 0;
    let maxActive = 0;
    h.on('concur.cap', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(80);
      active--;
    }, { concurrency: 2 });

    await h.start();
    // Emit 6 jobs with unique IDs so they're treated as separate jobs
    const jobs = Array.from({ length: 6 }, () =>
      h.emitAndWait('concur.cap', {}, { id: crypto.randomUUID(), timeoutMs: 5000 })
    );
    await Promise.all(jobs);

    assert(maxActive <= 2, `expected max 2 concurrent, got ${maxActive}`);
  }, { concurrency: 10 }));

// ─── defineJob ────────────────────────────────────────────────────────────────

Deno.test('defineJob handler is registered and receives typed data', () =>
  withHound(async (h) => {
    let receivedX = 0;
    const myJob = defineJob<any, { x: number }>('dj.typed', async (ctx) => {
      receivedX = ctx.data.x;
    });
    h.on(myJob);
    await h.start();
    await h.emitAndWait('dj.typed', { x: 99 }, { timeoutMs: 3000 });
    assertEquals(receivedX, 99);
  }));

// ─── Priority ─────────────────────────────────────────────────────────────────

Deno.test('higher priority jobs are processed before lower priority', () =>
  withHound(async (h) => {
    const order: number[] = [];
    let resolve!: () => void;
    const allDone = new Promise<void>((r) => { resolve = r; });
    let count = 0;

    h.on('prio.test', async (ctx: any) => {
      order.push(ctx.data.p);
      if (++count === 3) resolve();
    });

    // Emit all 3 BEFORE starting the processor so they land in the queue simultaneously.
    // emitAndWait is deliberately avoided here — re-ZADDing the same jobs would alter their
    // scores and could break the priority ordering we're trying to verify.
    await h.emitAsync('prio.test', { p: 1 },  { id: 'p1',  priority: 1  });
    await h.emitAsync('prio.test', { p: 10 }, { id: 'p10', priority: 10 });
    await h.emitAsync('prio.test', { p: 5 },  { id: 'p5',  priority: 5  });

    await h.start();
    await allDone;

    assertEquals(order[0], 10);
    assertEquals(order[1], 5);
    assertEquals(order[2], 1);
  }, { concurrency: 1 }));

// ─── Delayed jobs ─────────────────────────────────────────────────────────────

Deno.test('delayed job is not processed before delayUntil', () =>
  withHound(async (h) => {
    let ran = false;
    h.on('delay.test', async () => { ran = true; });
    await h.start();

    h.emit('delay.test', {}, { delay: new Date(Date.now() + 5_000) });
    await sleep(200); // let a few poll cycles run
    assertEquals(ran, false);
  }));

// ─── ctx.emitAsync chaining ───────────────────────────────────────────────────

Deno.test('handler can chain follow-up jobs via ctx.emitAsync', () =>
  withHound(async (h) => {
    let chainRan = false;
    h.on('chain.start', async (ctx: any) => { await ctx.emitAsync('chain.end', {}); });
    h.on('chain.end', async () => { chainRan = true; });

    await h.start();
    await h.emitAndWait('chain.start', {}, { timeoutMs: 3000 });
    await sleep(300); // give chain.end time to complete
    assertEquals(chainRan, true);
  }));

// ─── emitBatch ───────────────────────────────────────────────────────────────

Deno.test('emitBatch returns one jobId per entry in order', () =>
  withHound(async (h) => {
    h.on('batch.a', async () => {});
    h.on('batch.b', async () => {});
    const ids = await h.emitBatch([
      { event: 'batch.a', data: { n: 1 } },
      { event: 'batch.b', data: { n: 2 } },
      { event: 'batch.a', data: { n: 3 } },
    ]);
    assertEquals(ids.length, 3);
    assert(ids.every((id) => typeof id === 'string' && id.length > 0));
  }));

Deno.test('emitBatch returns [] for empty input', () =>
  withHound(async (h) => {
    const ids = await h.emitBatch([]);
    assertEquals(ids, []);
  }));

Deno.test('emitBatch jobs are all processed', () =>
  withHound(async (h) => {
    const N = 10;
    let count = 0;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });

    h.on('batch.count', async () => {
      if (++count === N) resolve();
    });
    await h.start();

    const ids = await h.emitBatch(
      Array.from({ length: N }, (_, i) => ({ event: 'batch.count', data: { i } })),
    );
    assertEquals(ids.length, N);
    await done;
    assertEquals(count, N);
  }));

Deno.test('emitBatch same payload produces same deterministic ids as individual emitAsync', () =>
  withHound(async (h) => {
    h.on('batch.dedup', async () => {});
    const [batchId] = await h.emitBatch([{ event: 'batch.dedup', data: { x: 42 } }]);
    const singleId = await h.emitAsync('batch.dedup', { x: 42 });
    assertEquals(batchId, singleId);
  }));

Deno.test('emitBatch rejects when a backend op throws — and rolls back the chunk (no orphan state keys)', () =>
  withHound(async (h, db) => {
    h.on('batch.fail', async () => {});

    // Inject a failure mid-transaction by wrapping db.set to throw on the 3rd call.
    // Each emitBatch entry stages one set (state key) + one zadd, so set #3 falls
    // inside the transaction and triggers InMemoryTransaction's snapshot rollback.
    let setCallCount = 0;
    const origSet = db.set.bind(db);
    (db as any).set = async (key: string, value: string, ...args: unknown[]) => {
      setCallCount++;
      if (setCallCount === 3) throw new Error('forced set failure');
      return await origSet(key, value, ...(args as []));
    };

    await assertRejects(
      () => h.emitBatch([
        { event: 'batch.fail', data: { i: 1 } },
        { event: 'batch.fail', data: { i: 2 } },
        { event: 'batch.fail', data: { i: 3 } },
      ]),
      Error,
      'forced set failure',
    );

    (db as any).set = origSet;

    // No orphan state keys for any of the 3 jobs that were in the failed chunk
    const [, keys] = await db.scan(0, 'MATCH', 'queues:default:*:waiting', 'COUNT', 1000);
    assertEquals(keys.length, 0, `expected zero orphan state keys, got ${keys.length}`);
  }));

Deno.test('emitBatch applies jobStateTtlSeconds to every state key', () =>
  withHound(async (h, db) => {
    h.on('batch.ttl', async () => {});
    const ids = await h.emitBatch([
      { event: 'batch.ttl', data: { i: 1 } },
      { event: 'batch.ttl', data: { i: 2 } },
    ]);

    // helpers.ts sets jobStateTtlSeconds: 60 — verify state keys exist now
    for (const id of ids) {
      const v = await db.get(`queues:default:${id}:waiting`);
      assert(v !== null, `state key for ${id} should exist`);
    }
  }, { processor: { pollIntervalMs: 50, jobStateTtlSeconds: 1 } }));

Deno.test('emitBatch chunks at claimCount and returns all ids in order', () =>
  withHound(async (h) => {
    h.on('batch.chunk', async () => {});
    const N = 25;
    const ids = await h.emitBatch(
      Array.from({ length: N }, (_, i) => ({ event: 'batch.chunk', data: { i } })),
    );
    assertEquals(ids.length, N);
    // All unique (different data → different deterministic ids)
    assertEquals(new Set(ids).size, N);
  }, { processor: { pollIntervalMs: 50, jobStateTtlSeconds: 60, claimCount: 5 } }));

Deno.test('ctx.emitBatch is available inside a handler and enqueues children', () =>
  withHound(async (h) => {
    let childCount = 0;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });

    h.on('child.task', async () => {
      if (++childCount === 4) resolve();
    });

    h.on('parent.fanout', async (ctx: any) => {
      assert(typeof ctx.emitBatch === 'function', 'ctx.emitBatch must be defined');
      await ctx.emitBatch([
        { event: 'child.task', data: { i: 1 } },
        { event: 'child.task', data: { i: 2 } },
        { event: 'child.task', data: { i: 3 } },
        { event: 'child.task', data: { i: 4 } },
      ]);
    });

    await h.start();
    h.emit('parent.fanout', {});
    await done;
    assertEquals(childCount, 4);
  }));

// ─── ctx.logger ──────────────────────────────────────────────────────────────

Deno.test('ctx.logger appends log entries without throwing', () =>
  withHound(async (h) => {
    h.on('log.test', async (ctx: any) => {
      ctx.logger('step one');
      ctx.logger({ detail: 'step two', value: 42 });
    });
    await h.start();
    await h.emitAndWait('log.test', {}, { timeoutMs: 3000 }); // should not throw
  }));

// ─── emitBatch ───────────────────────────────────────────────────────────────

Deno.test('emitBatch returns one jobId per entry in order', () =>
  withHound(async (h) => {
    h.on('batch.a', async () => {});
    h.on('batch.b', async () => {});
    const ids = await h.emitBatch([
      { event: 'batch.a', data: { n: 1 } },
      { event: 'batch.b', data: { n: 2 } },
      { event: 'batch.a', data: { n: 3 } },
    ]);
    assertEquals(ids.length, 3);
    assert(ids.every((id) => typeof id === 'string' && id.length > 0));
  }));

Deno.test('emitBatch returns [] for empty input', () =>
  withHound(async (h) => {
    const ids = await h.emitBatch([]);
    assertEquals(ids, []);
  }));

Deno.test('emitBatch jobs are all processed', () =>
  withHound(async (h) => {
    const N = 10;
    let count = 0;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });

    h.on('batch.count', async () => {
      if (++count === N) resolve();
    });
    await h.start();

    const ids = await h.emitBatch(
      Array.from({ length: N }, (_, i) => ({ event: 'batch.count', data: { i } })),
    );
    assertEquals(ids.length, N);
    await done;
    assertEquals(count, N);
  }));

Deno.test('emitBatch same payload produces same deterministic id as emitAsync', () =>
  withHound(async (h) => {
    h.on('batch.dedup', async () => {});
    const [batchId] = await h.emitBatch([{ event: 'batch.dedup', data: { x: 42 } }]);
    const singleId = await h.emitAsync('batch.dedup', { x: 42 });
    assertEquals(batchId, singleId);
  }));

// ─── Multiple jobs, correct throughput ───────────────────────────────────────

Deno.test('processes N jobs in parallel up to concurrency limit', () =>
  withHound(async (h) => {
    let completed = 0;
    h.on('throughput.test', async () => { completed++; });
    await h.start();

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        h.emitAndWait('throughput.test', { i }, { id: `t${i}`, timeoutMs: 5000 })
      ),
    );
    assertEquals(completed, N);
  }, { concurrency: 5 }));
