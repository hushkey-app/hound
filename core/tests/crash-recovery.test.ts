/**
 * Crash-recovery tests — jobs whose worker died mid-execution must be
 * re-executed after the Reaper re-enqueues them, not silently dropped.
 * Runs against InMemoryStorage, no Redis needed.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { sleep, withHound } from './helpers.ts';

/** Full JobData payload as the engine writes it, with overridable fields. */
function makeJobPayload(
  id: string,
  event: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    state: { name: event, queue: 'default', data: {}, options: {} },
    status: 'processing',
    delayUntil: Date.now(),
    lockUntil: Date.now(),
    priority: 0,
    retryCount: 0,
    retryDelayMs: 1000,
    retryBackoff: 'fixed',
    retriedAttempts: 0,
    repeatCount: 0,
    repeatDelayMs: 0,
    logs: [],
    errors: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

async function pollUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(25);
}

Deno.test('crash recovery: job with :processing state key is re-executed after Reaper requeue', () =>
  withHound(async (h, db) => {
    let ran = 0;
    h.on('crash.recovered', async () => {
      ran++;
    });

    // Simulate the post-crash state the Reaper leaves behind: the state key
    // was already transitioned to :processing by the dead worker, and the
    // Reaper has moved the jobId back into the queue sorted set.
    const id = 'crashed-1';
    await db.set(
      `queues:default:${id}:processing`,
      JSON.stringify(makeJobPayload(id, 'crash.recovered')),
    );
    await db.zadd('queues:default:q', Date.now() - 1000, id);

    await h.start();
    await pollUntil(() => ran === 1);

    assertEquals(ran, 1);
    // Terminal state written, no longer stuck in any sorted set
    assertEquals(await db.zcard('queues:default:q'), 0);
    assertEquals(await db.zcard('queues:default:processing'), 0);
  }));

Deno.test('crash recovery: cron tick with held exec lock still schedules the next tick', () =>
  withHound(async (h, db) => {
    let ran = 0;
    // Handler registered without repeat — the seeded payload carries the cron
    // options, mirroring a tick emitted by a previous (crashed) process.
    h.on('crash.cron', async () => {
      ran++;
    });

    const id = 'cron-crashed-1';
    const delayUntil = Date.now() - 1000;
    await db.set(
      `queues:default:${id}:processing`,
      JSON.stringify(makeJobPayload(id, 'crash.cron', {
        state: {
          name: 'crash.cron',
          queue: 'default',
          data: {},
          options: { repeat: { pattern: '* * * * *', catchUp: true } },
        },
        delayUntil,
        repeatCount: 1,
      })),
    );
    // The crashed run acquired the per-tick exec lock before dying
    await db.set(`queues:default:cron-exec:${id}:${delayUntil}`, '1');
    await db.zadd('queues:default:q', Date.now() - 1000, id);

    await h.start();
    await pollUntil(() => false, 500); // let a few claim cycles run

    // Tick was deduped by the exec lock — but the next tick must be scheduled
    assertEquals(ran, 0);
    const delayedRaw = await db.get(`queues:default:${id}:delayed`);
    assert(delayedRaw !== null, 'next cron tick state key should exist');
    const delayed = JSON.parse(delayedRaw!) as { delayUntil: number };
    assert(
      delayed.delayUntil > Date.now(),
      'next tick should be in the future',
    );
    const score = await db.zscore('queues:default:q', id);
    assert(
      score !== null && Number(score) > Date.now(),
      'next tick should be enqueued with a future score',
    );
    assertEquals(await db.zcard('queues:default:processing'), 0);
  }));

// ─── Paused-job parking ───────────────────────────────────────────────────────

Deno.test('paused job is parked at far-future score instead of Reaper churn', () =>
  withHound(async (h, db) => {
    let ran = 0;
    h.on('pause.parked', async () => {
      ran++;
    });

    // Job whose paused flag is set but whose queue score is already due —
    // the claim-time pause check must ACK it and park it, not leave it
    // un-ACKed for the Reaper to reclaim every sweep.
    const id = 'paused-1';
    await db.set(
      `queues:default:${id}:waiting`,
      JSON.stringify(
        makeJobPayload(id, 'pause.parked', { status: 'waiting', paused: true }),
      ),
    );
    await db.zadd('queues:default:q', Date.now() - 1000, id);

    await h.start();
    await pollUntil(() => false, 300); // let a few claim cycles run

    assertEquals(ran, 0);
    assertEquals(await db.zcard('queues:default:processing'), 0);
    const score = await db.zscore('queues:default:q', id);
    assertEquals(Number(score), Number.MAX_SAFE_INTEGER);
  }));
