/**
 * HoundManagement tests — run against InMemoryStorage, no Redis needed.
 * Tests that require a live Hound use withHound().
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { HoundManagement } from '../libs/hound-management/mod.ts';
import { InMemoryStorage } from '../libs/storage/in-memory.ts';
import { makeDb, sleep, withHound } from './helpers.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type JobStatus = 'waiting' | 'delayed' | 'processing' | 'completed' | 'failed';

async function seedJob(
  db: InMemoryStorage,
  queue: string,
  jobId: string,
  status: JobStatus,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const payload = {
    id: jobId,
    state: { name: 'test.event', queue, data: { x: 1 }, options: {} },
    status,
    delayUntil: 0,
    lockUntil: 0,
    priority: 0,
    retryCount: 3,
    retryDelayMs: 1000,
    retryBackoff: 'fixed',
    retriedAttempts: 0,
    repeatCount: 0,
    repeatDelayMs: 0,
    logs: [],
    errors: [],
    timestamp: Date.now(),
    paused: false,
    ...overrides,
  };

  const key = status === 'completed' || status === 'failed'
    ? `queues:${queue}:${jobId}:${status}:exec1`
    : `queues:${queue}:${jobId}:${status}`;

  await db.set(key, JSON.stringify(payload));
}

function makeManagement(db: InMemoryStorage): HoundManagement {
  return new HoundManagement({ db });
}

// ─── jobs.find() ──────────────────────────────────────────────────────────────

Deno.test('jobs.find: returns empty array when no jobs exist', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.jobs.find(), []);
});

Deno.test('jobs.find: returns jobs across all active statuses', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-a', 'waiting');
  await seedJob(db, 'default', 'job-b', 'delayed');
  await seedJob(db, 'default', 'job-c', 'processing');
  const m = makeManagement(db);
  const jobs = await m.api.jobs.find();
  assertEquals(jobs.length, 3);
  assert(jobs.some((j) => j.id === 'job-a' && j.status === 'waiting'));
  assert(jobs.some((j) => j.id === 'job-b' && j.status === 'delayed'));
  assert(jobs.some((j) => j.id === 'job-c' && j.status === 'processing'));
});

Deno.test('jobs.find: returns jobs in terminal statuses', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-x', 'completed');
  await seedJob(db, 'default', 'job-y', 'failed');
  const m = makeManagement(db);
  const jobs = await m.api.jobs.find();
  assertEquals(jobs.length, 2);
  assert(jobs.some((j) => j.id === 'job-x' && j.status === 'completed'));
  assert(jobs.some((j) => j.id === 'job-y' && j.status === 'failed'));
});

Deno.test('jobs.find: deduplicates terminal jobs — latest timestamp wins', async () => {
  const db = makeDb();
  const now = Date.now();
  // Two completed executions for the same jobId — different execIds
  const base = {
    id: 'job-dup',
    state: { name: 'test.event', queue: 'default', data: {}, options: {} },
    status: 'completed',
    delayUntil: 0, lockUntil: 0, priority: 0, retryCount: 0, retryDelayMs: 1000,
    retryBackoff: 'fixed', retriedAttempts: 0, repeatCount: 0, repeatDelayMs: 0,
    logs: [], errors: [], paused: false,
  };
  await db.set('queues:default:job-dup:completed:exec1', JSON.stringify({ ...base, timestamp: now - 1000 }));
  await db.set('queues:default:job-dup:completed:exec2', JSON.stringify({ ...base, timestamp: now }));

  const m = makeManagement(db);
  const jobs = await m.api.jobs.find();
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].execId, 'exec2');
});

Deno.test('jobs.find: filters by queue', async () => {
  const db = makeDb();
  await seedJob(db, 'q-a', 'job-1', 'waiting');
  await seedJob(db, 'q-b', 'job-2', 'waiting');
  const m = makeManagement(db);
  const jobs = await m.api.jobs.find({ queue: 'q-a' });
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].queue, 'q-a');
});

Deno.test('jobs.find: filters by status', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-w', 'waiting');
  await seedJob(db, 'default', 'job-d', 'delayed');
  await seedJob(db, 'default', 'job-f', 'failed');
  const m = makeManagement(db);
  const waiting = await m.api.jobs.find({ status: 'waiting' });
  assertEquals(waiting.length, 1);
  assertEquals(waiting[0].id, 'job-w');
});

Deno.test('jobs.find: filters by queue AND status', async () => {
  const db = makeDb();
  await seedJob(db, 'q-a', 'job-1', 'waiting');
  await seedJob(db, 'q-a', 'job-2', 'delayed');
  await seedJob(db, 'q-b', 'job-3', 'waiting');
  const m = makeManagement(db);
  const results = await m.api.jobs.find({ queue: 'q-a', status: 'waiting' });
  assertEquals(results.length, 1);
  assertEquals(results[0].id, 'job-1');
});

// ─── jobs.get() ───────────────────────────────────────────────────────────────

Deno.test('jobs.get: returns null for nonexistent job', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.jobs.get('default:ghost'), null);
});

Deno.test('jobs.get: returns job record for existing key', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'waiting');
  const m = makeManagement(db);
  const job = await m.api.jobs.get('default:job-1');
  assert(job !== null);
  assertEquals(job.id, 'job-1');
  assertEquals(job.queue, 'default');
  assertEquals(job.status, 'waiting');
});

Deno.test('jobs.get: throws for malformed key', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  await assertRejects(() => m.api.jobs.get('nocolon'), Error, 'key must be in format');
});

// ─── jobs.delete() ────────────────────────────────────────────────────────────

Deno.test('jobs.delete: returns false for nonexistent job', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.jobs.delete('default:ghost'), false);
});

Deno.test('jobs.delete: removes active status key', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'waiting');
  const m = makeManagement(db);
  const deleted = await m.api.jobs.delete('default:job-1');
  assertEquals(deleted, true);
  assertEquals(await m.api.jobs.get('default:job-1'), null);
});

Deno.test('jobs.delete: removes terminal status keys', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'failed');
  const m = makeManagement(db);
  const deleted = await m.api.jobs.delete('default:job-1');
  assertEquals(deleted, true);
  assertEquals(await m.api.jobs.get('default:job-1'), null);
});

// ─── jobs.pause() ─────────────────────────────────────────────────────────────

Deno.test('jobs.pause: returns null for nonexistent job', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.jobs.pause('default:ghost'), null);
});

Deno.test('jobs.pause: sets paused=true and delayUntil=MAX_SAFE_INTEGER for waiting job', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'waiting');
  const m = makeManagement(db);
  const paused = await m.api.jobs.pause('default:job-1');
  assert(paused !== null);
  assertEquals(paused.paused, true);
  assertEquals(paused.delayUntil, Number.MAX_SAFE_INTEGER);
});

Deno.test('jobs.pause: throws for non-waiting/delayed job', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'processing');
  const m = makeManagement(db);
  await assertRejects(() => m.api.jobs.pause('default:job-1'), Error, 'Cannot pause');
});

// ─── jobs.resume() ────────────────────────────────────────────────────────────

Deno.test('jobs.resume: returns null for nonexistent job', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.jobs.resume('default:ghost'), null);
});

Deno.test('jobs.resume: resets paused flag and delayUntil for paused job', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'waiting');
  const m = makeManagement(db);

  await m.api.jobs.pause('default:job-1');
  const before = await m.api.jobs.get('default:job-1');
  assertEquals(before?.paused, true);

  const resumed = await m.api.jobs.resume('default:job-1');
  assert(resumed !== null);
  assertEquals(resumed.paused, false);
  assert(resumed.delayUntil <= Date.now() + 10);
});

Deno.test('jobs.resume: throws for non-paused job', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'waiting'); // paused:false by default
  const m = makeManagement(db);
  await assertRejects(() => m.api.jobs.resume('default:job-1'), Error, 'not paused');
});

// ─── jobs.promote() ───────────────────────────────────────────────────────────

Deno.test('jobs.promote: throws without Hound instance', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'delayed');
  const m = makeManagement(db);
  await assertRejects(() => m.api.jobs.promote('default:job-1'), Error, 'requires a Hound instance');
});

Deno.test('jobs.promote: returns null for nonexistent job', () =>
  withHound(async (hound, db) => {
    const m = new HoundManagement({ db, hound });
    assertEquals(await m.api.jobs.promote('default:ghost'), null);
  }));

Deno.test('jobs.promote: throws for non-delayed/waiting job', () =>
  withHound(async (hound, db) => {
    await seedJob(db, 'default', 'job-1', 'processing');
    const m = new HoundManagement({ db, hound });
    await assertRejects(() => m.api.jobs.promote('default:job-1'), Error, 'Cannot promote');
  }));

Deno.test('jobs.promote: sets delayUntil to now and re-enqueues delayed job', () =>
  withHound(async (hound, db) => {
    hound.on('test.event', async () => {});
    const future = Date.now() + 60_000;
    await seedJob(db, 'default', 'job-1', 'delayed', { delayUntil: future });
    const m = new HoundManagement({ db, hound });
    const promoted = await m.api.jobs.promote('default:job-1');
    assert(promoted !== null);
    assert(promoted.delayUntil <= Date.now() + 10);
  }));

Deno.test('jobs.promote: cron job runs early and recurrence survives', () =>
  withHound(async (hound, db) => {
    let runs = 0;
    hound.on('cron.event', async () => { runs++; });
    await hound.start();

    // Seed a cron tick scheduled far in the future.
    const future = Date.now() + 60_000;
    await seedJob(db, 'default', 'cron-1', 'delayed', {
      delayUntil: future,
      lockUntil: future,
      repeatCount: 1,
      state: {
        name: 'cron.event',
        queue: 'default',
        data: {},
        options: { repeat: { pattern: '*/5 * * * *', catchUp: false } },
      },
    });

    const m = new HoundManagement({ db, hound });
    const promoted = await m.api.jobs.promote('default:cron-1');
    assert(promoted !== null);
    assert(promoted.delayUntil <= Date.now() + 10);

    // Job should run once via promotion.
    await sleep(500);
    assertEquals(runs, 1);

    // After running, #scheduleCronNextTick should re-seed a future delayed entry
    // for the same id (cron recurrence preserved — emit() would have killed it).
    const next = await db.get('queues:default:cron-1:delayed');
    assert(next !== null, 'cron recurrence missing — next tick was not scheduled');
    const parsed = JSON.parse(next);
    assertEquals(parsed.repeatCount, 1);
    assert(parsed.delayUntil > Date.now(), 'next tick should be in the future');
    assertEquals(parsed.state.options.repeat.pattern, '*/5 * * * *');
  }));

// ─── jobs.retry() ─────────────────────────────────────────────────────────────

Deno.test('jobs.retry: throws without Hound instance', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-1', 'failed');
  const m = makeManagement(db);
  await assertRejects(() => m.api.jobs.retry('default:job-1'), Error, 'requires a Hound instance');
});

Deno.test('jobs.retry: returns null for nonexistent job', () =>
  withHound(async (hound, db) => {
    const m = new HoundManagement({ db, hound });
    assertEquals(await m.api.jobs.retry('default:ghost'), null);
  }));

Deno.test('jobs.retry: throws for non-failed job', () =>
  withHound(async (hound, db) => {
    await seedJob(db, 'default', 'job-1', 'completed');
    const m = new HoundManagement({ db, hound });
    await assertRejects(() => m.api.jobs.retry('default:job-1'), Error, 'Cannot retry');
  }));

Deno.test('jobs.retry: re-enqueues failed job and runs it to completion', () =>
  withHound(async (hound, db) => {
    let ran = false;
    hound.on('test.event', async () => { ran = true; });
    await hound.start();

    // Seed a failed job
    await seedJob(db, 'default', 'job-1', 'failed', { state: { name: 'test.event', queue: 'default', data: {}, options: {} } });

    const m = new HoundManagement({ db, hound });
    const result = await m.api.jobs.retry('default:job-1');
    assert(result !== null);
    assertEquals(result.status, 'failed');

    // Wait for the retried job to complete
    await sleep(500);
    assertEquals(ran, true);
  }));

// ─── queues.find() ────────────────────────────────────────────────────────────

Deno.test('queues.find: returns empty array when no queues', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.queues.find(), []);
});

Deno.test('queues.find: discovers queues from job state keys', async () => {
  const db = makeDb();
  await seedJob(db, 'q-a', 'job-1', 'waiting');
  await seedJob(db, 'q-b', 'job-2', 'processing');
  const m = makeManagement(db);
  const queues = await m.api.queues.find();
  const names = queues.map((q) => q.name).sort();
  assertEquals(names, ['q-a', 'q-b']);
});

Deno.test('queues.find: discovers queues from sorted-set queue keys', async () => {
  const db = makeDb();
  await db.zadd('queues:payments:q', Date.now(), 'job-1');
  const m = makeManagement(db);
  const queues = await m.api.queues.find();
  assert(queues.some((q) => q.name === 'payments'));
});

Deno.test('queues.find: reports paused=true for paused queues', async () => {
  const db = makeDb();
  await seedJob(db, 'q-a', 'job-1', 'waiting');
  await db.set('queues:q-a:paused', 'true');
  const m = makeManagement(db);
  const queues = await m.api.queues.find();
  assertEquals(queues[0].paused, true);
});

Deno.test('queues.find: returns correct queue length', async () => {
  const db = makeDb();
  const now = Date.now();
  await db.zadd('queues:default:q', now, 'job-1');
  await db.zadd('queues:default:q', now + 1, 'job-2');
  await seedJob(db, 'default', 'job-1', 'waiting');
  const m = makeManagement(db);
  const queues = await m.api.queues.find();
  const q = queues.find((x) => x.name === 'default');
  assert(q !== undefined);
  assertEquals(q.length, 2);
});

// ─── queues.pause() / resume() / running() ────────────────────────────────────

Deno.test('queues.running: returns true when queue is not paused', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  assertEquals(await m.api.queues.running('default'), true);
});

Deno.test('queues.pause: sets paused flag → running returns false', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  await m.api.queues.pause('default');
  assertEquals(await m.api.queues.running('default'), false);
});

Deno.test('queues.resume: removes paused flag → running returns true', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  await m.api.queues.pause('default');
  await m.api.queues.resume('default');
  assertEquals(await m.api.queues.running('default'), true);
});

// ─── queues.reset() ───────────────────────────────────────────────────────────

Deno.test('queues.reset: deletes all state keys and sorted-set for a queue', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-a', 'waiting');
  await seedJob(db, 'default', 'job-b', 'failed');
  await db.zadd('queues:default:q', Date.now(), 'job-a');
  await db.set('queues:default:paused', 'true');

  const m = makeManagement(db);
  await m.api.queues.reset('default');

  assertEquals(await m.api.jobs.find({ queue: 'default' }), []);
  assertEquals(await db.zcard('queues:default:q'), 0);
});

Deno.test('queues.reset: does not affect other queues', async () => {
  const db = makeDb();
  await seedJob(db, 'q-a', 'job-1', 'waiting');
  await seedJob(db, 'q-b', 'job-2', 'waiting');
  const m = makeManagement(db);
  await m.api.queues.reset('q-a');

  const remaining = await m.api.jobs.find();
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0].queue, 'q-b');
});

// ─── queues.stats() ───────────────────────────────────────────────────────────

Deno.test('queues.stats: returns all zeros for empty queue', async () => {
  const db = makeDb();
  const m = makeManagement(db);
  const stats = await m.api.queues.stats('empty');
  assertEquals(stats, { waiting: 0, delayed: 0, processing: 0, completed: 0, failed: 0, total: 0 });
});

Deno.test('queues.stats: counts each active status independently', async () => {
  const db = makeDb();
  await seedJob(db, 'default', 'job-w', 'waiting');
  await seedJob(db, 'default', 'job-d', 'delayed');
  await seedJob(db, 'default', 'job-p', 'processing');
  const m = makeManagement(db);
  const stats = await m.api.queues.stats('default');
  assertEquals(stats.waiting, 1);
  assertEquals(stats.delayed, 1);
  assertEquals(stats.processing, 1);
  assertEquals(stats.total, 3);
});

Deno.test('queues.stats: deduplicates terminal jobs by jobId', async () => {
  const db = makeDb();
  const base = {
    id: 'job-x',
    state: { name: 'test.event', queue: 'default', data: {}, options: {} },
    status: 'completed',
    delayUntil: 0, lockUntil: 0, priority: 0, retryCount: 0, retryDelayMs: 1000,
    retryBackoff: 'fixed', retriedAttempts: 0, repeatCount: 0, repeatDelayMs: 0,
    logs: [], errors: [], paused: false, timestamp: Date.now(),
  };
  // Same jobId, two executions
  await db.set('queues:default:job-x:completed:exec1', JSON.stringify(base));
  await db.set('queues:default:job-x:completed:exec2', JSON.stringify(base));
  // Different jobId
  await seedJob(db, 'default', 'job-y', 'completed');

  const m = makeManagement(db);
  const stats = await m.api.queues.stats('default');
  assertEquals(stats.completed, 2); // job-x (deduped) + job-y
});

Deno.test('queues.stats: only counts jobs for the target queue', async () => {
  const db = makeDb();
  await seedJob(db, 'q-a', 'job-1', 'waiting');
  await seedJob(db, 'q-a', 'job-2', 'failed');
  await seedJob(db, 'q-b', 'job-3', 'waiting');
  const m = makeManagement(db);
  const stats = await m.api.queues.stats('q-a');
  assertEquals(stats.total, 2);
  assertEquals(stats.waiting, 1);
  assertEquals(stats.failed, 1);
});

// ─── events.job ───────────────────────────────────────────────────────────────

Deno.test('events.job.finished: throws without Hound instance', () => {
  const db = makeDb();
  const m = makeManagement(db);
  let threw = false;
  try {
    m.events.job.finished(() => {});
  } catch (err: any) {
    threw = true;
    assert(err.message.includes('requires a Hound instance'));
  }
  assertEquals(threw, true);
});

Deno.test('events.job.finished: receives completed and failed events', () =>
  withHound(async (hound, db) => {
    hound.on('ok.event', async () => {});
    hound.on('fail.event', async () => { throw new Error('oops'); });
    await hound.start();

    const m = new HoundManagement({ db, hound });
    const received: string[] = [];
    const unsub = m.events.job.finished((p) => received.push(p.status));

    await hound.emitAndWait('ok.event', {}, { timeoutMs: 3000 }).catch(() => {});
    // trigger a known-failing job and wait briefly
    hound.emit('fail.event', {});
    await sleep(500);

    unsub();
    assert(received.includes('completed'));
    assert(received.includes('failed'));
  }));

Deno.test('events.job.completed: only fires for completed jobs', () =>
  withHound(async (hound, db) => {
    hound.on('ok.event2', async () => {});
    hound.on('fail.event2', async () => { throw new Error('x'); });
    await hound.start();

    const m = new HoundManagement({ db, hound });
    const statuses: string[] = [];
    const unsub = m.events.job.completed((p) => statuses.push(p.status));

    await hound.emitAndWait('ok.event2', {}, { timeoutMs: 3000 });
    hound.emit('fail.event2', {});
    await sleep(300);

    unsub();
    assert(statuses.every((s) => s === 'completed'));
  }));

Deno.test('events.job.failed: only fires for failed jobs', () =>
  withHound(async (hound, db) => {
    hound.on('ok.event3', async () => {});
    hound.on('fail.event3', async () => { throw new Error('x'); });
    await hound.start();

    const m = new HoundManagement({ db, hound });
    const statuses: string[] = [];
    const unsub = m.events.job.failed((p) => statuses.push(p.status));

    await hound.emitAndWait('ok.event3', {}, { timeoutMs: 3000 });
    hound.emit('fail.event3', {});
    await sleep(300);

    unsub();
    assert(statuses.every((s) => s === 'failed'));
  }));

Deno.test('events.job.finished: unsubscribe stops callback', () =>
  withHound(async (hound, db) => {
    hound.on('unsub.event', async () => {});
    await hound.start();

    const m = new HoundManagement({ db, hound });
    let count = 0;
    const unsub = m.events.job.finished(() => count++);
    unsub();

    await hound.emitAndWait('unsub.event', {}, { timeoutMs: 3000 });
    assertEquals(count, 0);
  }));
