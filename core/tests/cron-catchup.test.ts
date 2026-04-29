/**
 * Cron catchUp behaviour — verifies that catchUp:false (default) skips stale
 * cron ticks on restart / Reaper recovery, and catchUp:true preserves the
 * legacy backfill-once behaviour.
 */
import { assert, assertEquals } from 'jsr:@std/assert';
import { Hound } from '../libs/hound/mod.ts';
import { genJobIdSync } from '../utils/id-gen.ts';
import { withHound, sleep } from './helpers.ts';

Deno.test('catchUp:false (default) — restart with stale delayUntil reschedules to next natural fire', async () => {
  Hound._reset();

  const event = 'cron.skip';
  const queue = 'default';
  const jobId = genJobIdSync(event, {});

  // Pre-seed a stale cron :delayed state — simulates a restart where the
  // previous tick's delayUntil is now in the past.
  const stalePast = Date.now() - 10 * 60_000; // 10 min ago
  await withHound(async (h, db) => {
    const stale = {
      id: jobId,
      state: {
        name: event,
        queue,
        data: {},
        options: { queue, repeat: { pattern: '* * * * *' } },
      },
      status: 'delayed',
      delayUntil: stalePast,
      lockUntil: stalePast,
      priority: 0,
      retryCount: 0,
      retryDelayMs: 1000,
      retryBackoff: 'fixed' as const,
      retriedAttempts: 0,
      repeatCount: 1,
      repeatDelayMs: 0,
      logs: [],
      errors: [],
      timestamp: stalePast,
    };
    await db.set(`queues:${queue}:${jobId}:delayed`, JSON.stringify(stale));

    let runs = 0;
    h.on(event, async () => {
      runs++;
    }, { queue, repeat: { pattern: '* * * * *' } });

    await h.start();

    // Read back the rescheduled state
    const after = await db.get(`queues:${queue}:${jobId}:delayed`);
    assert(after, 'delayed state should still exist');
    const parsed = JSON.parse(after);
    assert(parsed.delayUntil > Date.now(), 'should be rescheduled to a future time');
    assert(parsed.delayUntil <= Date.now() + 61_000, 'should be next natural fire (within 61s)');

    // No execution yet — next tick is in the future
    await sleep(100);
    assertEquals(runs, 0);
  });
});

Deno.test('catchUp:true — restart with stale delayUntil keeps original (fires immediately)', async () => {
  Hound._reset();

  const event = 'cron.catch';
  const queue = 'default';
  const jobId = genJobIdSync(event, {});
  const stalePast = Date.now() - 10 * 60_000;

  await withHound(async (h, db) => {
    const stale = {
      id: jobId,
      state: {
        name: event,
        queue,
        data: {},
        options: { queue, repeat: { pattern: '* * * * *', catchUp: true } },
      },
      status: 'delayed',
      delayUntil: stalePast,
      lockUntil: stalePast,
      priority: 0,
      retryCount: 0,
      retryDelayMs: 1000,
      retryBackoff: 'fixed' as const,
      retriedAttempts: 0,
      repeatCount: 1,
      repeatDelayMs: 0,
      logs: [],
      errors: [],
      timestamp: stalePast,
    };
    await db.set(`queues:${queue}:${jobId}:delayed`, JSON.stringify(stale));

    h.on(event, async () => {}, { queue, repeat: { pattern: '* * * * *', catchUp: true } });

    await h.start();

    const after = await db.get(`queues:${queue}:${jobId}:delayed`);
    assert(after, 'delayed state should still exist');
    const parsed = JSON.parse(after);
    assertEquals(parsed.delayUntil, stalePast, 'should preserve original stale delayUntil for backfill');
  });
});

Deno.test('catchUp without repeat.pattern throws on hound.on()', () =>
  withHound(async (h) => {
    let threw = false;
    try {
      h.on('cron.invalid.on', async () => {}, {
        repeat: { pattern: '', catchUp: false } as unknown as { pattern: string },
      });
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes('catchUp is only valid for cron jobs'));
    }
    assert(threw, 'expected throw when catchUp set without pattern');
  }));

Deno.test('catchUp without repeat.pattern throws on emit()', () =>
  withHound(async (h) => {
    h.on('cron.invalid.emit', async () => {});
    let threw = false;
    try {
      h.emit('cron.invalid.emit', {}, {
        repeat: { pattern: '', catchUp: true } as unknown as { pattern: string },
      });
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes('catchUp is only valid for cron jobs'));
    }
    assert(threw, 'expected throw when catchUp set without pattern on emit');
  }));

Deno.test('catchUp:false — consumer-side guard skips stale tick claimed from queue', async () => {
  Hound._reset();

  const event = 'cron.consume.skip';
  const queue = 'default';
  const jobId = genJobIdSync(event, {});
  const stalePast = Date.now() - 10 * 60_000;

  await withHound(async (h, db) => {
    let runs = 0;
    h.on(event, async () => {
      runs++;
    }, { queue, repeat: { pattern: '* * * * *' } });

    // Manually inject a stale cron entry directly onto the queue —
    // simulates Reaper requeueing a stalled processing entry with score=now,
    // bypassing the start() preflight.
    const stale = {
      id: jobId,
      state: {
        name: event,
        queue,
        data: {},
        options: { queue, repeat: { pattern: '* * * * *' } },
      },
      status: 'delayed',
      delayUntil: stalePast,
      lockUntil: stalePast,
      priority: 0,
      retryCount: 0,
      retryDelayMs: 1000,
      retryBackoff: 'fixed' as const,
      retriedAttempts: 0,
      repeatCount: 1,
      repeatDelayMs: 0,
      logs: [],
      errors: [],
      timestamp: stalePast,
    };

    await h.start();
    // Overwrite whatever start() put down — simulate the post-start Reaper resurrection.
    await db.set(`queues:${queue}:${jobId}:delayed`, JSON.stringify(stale));
    await db.zadd(`queues:${queue}:q`, Date.now(), jobId);

    // Wait for processor to claim and the catchUp guard to fire.
    await sleep(300);

    assertEquals(runs, 0, 'stale tick must not run when catchUp=false');
    const after = await db.get(`queues:${queue}:${jobId}:delayed`);
    assert(after, 'next tick should be rescheduled into :delayed');
    const parsed = JSON.parse(after);
    assert(parsed.delayUntil > Date.now(), 'next delayUntil must be in the future');
  });
});
