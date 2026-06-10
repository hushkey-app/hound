import { assertEquals } from 'jsr:@std/assert@1';
import { InMemoryStorage } from '../libs/storage/in-memory.ts';
import { Reaper } from '../libs/consumer/reaper.ts';
import { sleep } from './helpers.ts';

Deno.test('Reaper: reclaims stalled jobs from processing into queue', async () => {
  const db = new InMemoryStorage();
  // Job stuck in processing for 60s — well past the 30s visibility timeout
  await db.zadd('queues:default:processing', Date.now() - 60_000, 'stalled-job');

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
});

Deno.test('Reaper: does not reclaim fresh processing jobs', async () => {
  const db = new InMemoryStorage();
  // Job claimed just now
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
  await db.zadd('queues:default:processing', Date.now() - 10_000, 'late-job');
  await sleep(100);

  // Still in processing — no sweep ran after stop
  assertEquals(await db.zcard('queues:default:processing'), 1);
});
