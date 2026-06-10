/**
 * Job index tests — engine-maintained index zsets, lazy repair, TTL trim,
 * and reindex() migration. Runs against InMemoryStorage, no Redis needed.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  indexKey,
  parseStateKey,
  QUEUE_REGISTRY_KEY,
} from '../libs/consumer/job-index.ts';
import { HoundManagement } from '../libs/hound-management/mod.ts';
import { Reaper } from '../libs/consumer/reaper.ts';
import { makeDb, sleep, withHound } from './helpers.ts';

// ─── parseStateKey ────────────────────────────────────────────────────────────

Deno.test('parseStateKey: active, terminal, and colon-containing jobIds', () => {
  assertEquals(parseStateKey('queues:default:job-1:waiting'), {
    queue: 'default',
    jobId: 'job-1',
    status: 'waiting',
  });
  assertEquals(parseStateKey('queues:emails:job-2:failed:ab12cd34'), {
    queue: 'emails',
    jobId: 'job-2',
    status: 'failed',
    execId: 'ab12cd34',
  });
  // jobIds containing colons still parse — status is suffix-anchored
  assertEquals(parseStateKey('queues:q:user:42:delayed'), {
    queue: 'q',
    jobId: 'user:42',
    status: 'delayed',
  });
  assertEquals(parseStateKey('queues:q:user:42:completed:ff00ff00'), {
    queue: 'q',
    jobId: 'user:42',
    status: 'completed',
    execId: 'ff00ff00',
  });
  // Non-state keys are rejected
  assertEquals(parseStateKey('queues:default:q'), null);
  assertEquals(parseStateKey('queues:default:paused'), null);
  assertEquals(parseStateKey('hound:idx:default:waiting'), null);
});

// ─── Engine maintains indexes ─────────────────────────────────────────────────

Deno.test('engine: emit indexes the waiting key; completion moves it to completed', () =>
  withHound(async (h, db) => {
    h.on('idx.flow', async () => {});
    await h.start();

    const jobId = await h.emitAndWait('idx.flow', { x: 1 }, {
      timeoutMs: 3000,
    });

    // Waiting index emptied by the transition, completed index has one exec
    assertEquals(await db.zcard(indexKey('default', 'waiting')), 0);
    assertEquals(await db.zcard(indexKey('default', 'processing')), 0);
    const completed = await db.zrangebyscore(
      indexKey('default', 'completed'),
      '-inf',
      '+inf',
    );
    assertEquals(completed.length, 1);
    assert(completed[0].startsWith(`queues:default:${jobId}:completed:`));

    // Queue registered for discovery
    const queues = await db.zrangebyscore(QUEUE_REGISTRY_KEY, '-inf', '+inf');
    assert(queues.includes('default'));
  }));

Deno.test('engine: failed job lands in the failed index', () =>
  withHound(async (h, db) => {
    h.on('idx.fail', async () => {
      throw new Error('boom');
    });
    await h.start();
    await h.emitAndWait('idx.fail', {}, { timeoutMs: 3000 }).catch(() => {});

    const failed = await db.zrangebyscore(
      indexKey('default', 'failed'),
      '-inf',
      '+inf',
    );
    assertEquals(failed.length, 1);
    assertEquals(await db.zcard(indexKey('default', 'processing')), 0);
  }));

// ─── Lazy repair ──────────────────────────────────────────────────────────────

Deno.test('find: removes index members whose state key has expired', async () => {
  const db = makeDb();
  // Index member with no backing state key — as left behind after TTL expiry
  await db.zadd(
    indexKey('default', 'waiting'),
    Date.now(),
    'queues:default:ghost:waiting',
  );
  await db.zadd(QUEUE_REGISTRY_KEY, Date.now(), 'default');

  const m = new HoundManagement({ db });
  assertEquals(await m.api.jobs.find(), []);
  // Stale member was repaired away
  assertEquals(await db.zcard(indexKey('default', 'waiting')), 0);
});

// ─── Reaper TTL trim ──────────────────────────────────────────────────────────

Deno.test('Reaper: trims index members older than jobStateTtlSeconds', async () => {
  const db = makeDb();
  const idx = indexKey('default', 'completed');
  await db.zadd(idx, Date.now() - 7200_000, 'queues:default:old:completed:a1'); // 2h old
  await db.zadd(idx, Date.now(), 'queues:default:new:completed:b2');

  const reaper = new Reaper({
    db,
    queues: ['default'],
    visibilityTimeoutMs: 30_000,
    intervalMs: 999_999,
    jobStateTtlSeconds: 3600, // 1h
  });
  reaper.start();
  await sleep(50);
  reaper.stop();

  const remaining = await db.zrangebyscore(idx, '-inf', '+inf');
  assertEquals(remaining, ['queues:default:new:completed:b2']);
});

// ─── reindex() ────────────────────────────────────────────────────────────────

Deno.test('reindex: rebuilds indexes and registry from pre-index state keys', async () => {
  const db = makeDb();
  const now = Date.now();
  const payload = (id: string, status: string, ts: number) =>
    JSON.stringify({
      id,
      state: { name: 'test.event', queue: 'legacy', data: {}, options: {} },
      status,
      timestamp: ts,
      logs: [],
      errors: [],
    });

  // Pre-index deployment: state keys exist, no indexes, no registry
  await db.set('queues:legacy:job-a:waiting', payload('job-a', 'waiting', now));
  await db.set(
    'queues:legacy:job-b:failed:e1',
    payload('job-b', 'failed', now - 500),
  );

  const m = new HoundManagement({ db });
  assertEquals(await m.api.jobs.find(), []); // invisible before reindex

  const indexed = await m.api.reindex();
  assertEquals(indexed, 2);

  const jobs = await m.api.jobs.find();
  assertEquals(jobs.length, 2);
  assertEquals(jobs[0].id, 'job-a'); // newest first
  assert((await m.api.queues.find()).some((q) => q.name === 'legacy'));

  const stats = await m.api.queues.stats('legacy');
  assertEquals(stats.waiting, 1);
  assertEquals(stats.failed, 1);
});
