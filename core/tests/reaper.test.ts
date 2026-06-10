import { assert, assertEquals } from 'jsr:@std/assert@1';
import { InMemoryStorage } from '../libs/storage/in-memory.ts';
import { Reaper } from '../libs/consumer/reaper.ts';
import { sleep } from './helpers.ts';

/** Minimal processing-state payload as the engine writes it. */
function seedProcessing(
  db: InMemoryStorage,
  queue: string,
  jobId: string,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  return db.set(
    `queues:${queue}:${jobId}:processing`,
    JSON.stringify({
      id: jobId,
      state: { name: 'test.event', queue, data: {}, options: {} },
      status: 'processing',
      errors: [],
      ...overrides,
    }),
  );
}

Deno.test('Reaper: reclaims stalled jobs from processing into queue', async () => {
  const db = new InMemoryStorage();
  // Job stuck in processing for 60s — well past the 30s visibility timeout
  await seedProcessing(db, 'default', 'stalled-job');
  await db.zadd(
    'queues:default:processing',
    Date.now() - 60_000,
    'stalled-job',
  );

  const reaper = new Reaper({
    db,
    queues: ['default'],
    visibilityTimeoutMs: 30_000,
    intervalMs: 999_999, // no interval in this test
  });

  reaper.start();
  await sleep(50); // let the immediate sweep run
  reaper.stop();

  assertEquals(await db.zcard('queues:default:processing'), 0);
  assertEquals(await db.zcard('queues:default:q'), 1);
  // Reclaim is counted in the payload
  const raw = await db.get('queues:default:stalled-job:processing');
  assertEquals(JSON.parse(raw!).reclaims, 1);
});

Deno.test('Reaper: does not reclaim fresh processing jobs', async () => {
  const db = new InMemoryStorage();
  // Job claimed just now
  await seedProcessing(db, 'default', 'fresh-job');
  await db.zadd('queues:default:processing', Date.now(), 'fresh-job');

  const reaper = new Reaper({
    db,
    queues: ['default'],
    visibilityTimeoutMs: 30_000,
    intervalMs: 999_999,
  });

  reaper.start();
  await sleep(50);
  reaper.stop();

  assertEquals(await db.zcard('queues:default:processing'), 1);
  assertEquals(await db.zcard('queues:default:q'), 0);
});

Deno.test('Reaper: reclaims across multiple queues in one sweep', async () => {
  const db = new InMemoryStorage();
  const old = Date.now() - 60_000;
  await seedProcessing(db, 'alpha', 'job-a');
  await seedProcessing(db, 'beta', 'job-b');
  await db.zadd('queues:alpha:processing', old, 'job-a');
  await db.zadd('queues:beta:processing', old, 'job-b');

  const reaper = new Reaper({
    db,
    queues: ['alpha', 'beta'],
    visibilityTimeoutMs: 30_000,
    intervalMs: 999_999,
  });

  reaper.start();
  await sleep(50);
  reaper.stop();

  assertEquals(await db.zcard('queues:alpha:processing'), 0);
  assertEquals(await db.zcard('queues:beta:processing'), 0);
  assertEquals(await db.zcard('queues:alpha:q'), 1);
  assertEquals(await db.zcard('queues:beta:q'), 1);
});

Deno.test('Reaper: stop() prevents further sweeps', async () => {
  const db = new InMemoryStorage();

  const reaper = new Reaper({
    db,
    queues: ['default'],
    visibilityTimeoutMs: 1,
    intervalMs: 30, // fast interval
  });

  reaper.start();
  reaper.stop(); // stop immediately — initial sweep may run, interval won't

  // Add a stalled job AFTER stop; it should not be reclaimed by a subsequent interval
  await seedProcessing(db, 'default', 'late-job');
  await db.zadd('queues:default:processing', Date.now() - 10_000, 'late-job');
  await sleep(100);

  // Still in processing — no sweep ran after stop
  assertEquals(await db.zcard('queues:default:processing'), 1);
});

Deno.test('Reaper: drops orphan processing entries with no state key', async () => {
  const db = new InMemoryStorage();
  // No state key seeded — entry is an orphan (state deleted or TTL-expired)
  await db.zadd('queues:default:processing', Date.now() - 60_000, 'ghost');

  const reaper = new Reaper({
    db,
    queues: ['default'],
    visibilityTimeoutMs: 30_000,
    intervalMs: 999_999,
  });

  reaper.start();
  await sleep(50);
  reaper.stop();

  // Removed entirely — not requeued into a claim/ack churn loop
  assertEquals(await db.zcard('queues:default:processing'), 0);
  assertEquals(await db.zcard('queues:default:q'), 0);
});

Deno.test('Reaper: poison job is marked failed after maxReclaims', async () => {
  const db = new InMemoryStorage();
  const stale = Date.now() - 60_000;
  await seedProcessing(db, 'default', 'poison-1');
  await db.zadd('queues:default:processing', stale, 'poison-1');

  const published: unknown[] = [];
  const reaper = new Reaper({
    db,
    queues: ['default'],
    visibilityTimeoutMs: 30_000,
    intervalMs: 999_999,
    maxReclaims: 2,
    broker: {
      publish: (_ch, payload) => published.push(payload),
      subscribe: () => () => {},
    },
  });

  // Simulate the crash loop: each cycle the Reaper requeues, a consumer
  // claims, and the worker dies again (entry returns to processing, stale).
  for (let i = 0; i < 3; i++) {
    reaper.start();
    await sleep(30);
    reaper.stop();
    if (await db.zscore('queues:default:q', 'poison-1')) {
      await db.zrem('queues:default:q', 'poison-1');
      await db.zadd('queues:default:processing', stale, 'poison-1');
    }
  }

  // Third reclaim exceeds maxReclaims: 2 — job is dead-lettered
  const [, failedKeys] = await db.scan(
    '0',
    'MATCH',
    'queues:default:poison-1:failed:*',
    'COUNT',
    100,
  );
  assertEquals(failedKeys.length, 1);
  const failed = JSON.parse((await db.get(failedKeys[0]))!);
  assert(
    failed.errors.some((e: { message: string }) =>
      e.message.includes('poison')
    ),
  );
  assertEquals(await db.get('queues:default:poison-1:processing'), null);
  assertEquals(await db.zcard('queues:default:processing'), 0);
  assertEquals(await db.zcard('queues:default:q'), 0);
  // Terminal failure announced on the broker for waiters in other processes
  assertEquals(published.length, 1);
  assertEquals(
    (published[0] as { status: string; jobId: string }).status,
    'failed',
  );
});
