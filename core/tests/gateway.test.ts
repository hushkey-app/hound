/**
 * HTTP gateway integration tests — spins up a real Deno.serve on port 0
 * and makes actual fetch calls. No Redis required.
 */
import { assert, assertEquals } from 'jsr:@std/assert';
import { createGateway } from '../libs/gateways/gateway.ts';
import { HoundManagement } from '../libs/hound-management/mod.ts';
import { makeDb } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let jobSeq = 0;
type CapturedBatch = { event: string; data?: unknown; options?: unknown };
function mockHound(opts: { failOn?: string; capture?: { batch?: CapturedBatch[] } } = {}) {
  return {
    emitAsync: async (event: string) => {
      if (opts.failOn === event) throw new Error(`forced failure on ${event}`);
      return `job-${++jobSeq}-${event}`;
    },
    emitBatch: async (jobs: CapturedBatch[]) => {
      if (opts.capture?.batch) opts.capture.batch.push(...jobs);
      return jobs.map((j) => `job-${++jobSeq}-${j.event}`);
    },
  } as any;
}

async function withGateway<T>(
  hound: any,
  auth: string | undefined,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createGateway({ port: 0, hound, auth });
  const port = (server.addr as Deno.NetAddr).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await server.shutdown();
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

Deno.test('GET /health returns { status: "ok" }', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/health`);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { status: 'ok' });
  }));

// ─── POST /emit ───────────────────────────────────────────────────────────────

Deno.test('POST /emit returns { jobId }', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'user.created', data: { id: 1 } }),
    });
    assertEquals(res.status, 200);
    const body = await res.json() as { jobId: string };
    assert(typeof body.jobId === 'string');
    assert(body.jobId.includes('user.created'));
  }));

Deno.test('POST /emit returns 400 when event is missing', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assertEquals(res.status, 400);
    const body = await res.json() as { error: string };
    assert(body.error.includes('event is required'));
  }));

Deno.test('POST /emit returns 500 when hound.emitAsync throws', () =>
  withGateway(mockHound({ failOn: 'broken.event' }), undefined, async (base) => {
    const res = await fetch(`${base}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'broken.event' }),
    });
    assertEquals(res.status, 500);
    const body = await res.json() as { error: string };
    assert(body.error.includes('forced failure'));
  }));

Deno.test('POST /emit returns JSON { error } on malformed request body', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{',
    });
    assertEquals(res.status, 500);
    const body = await res.json() as { error: string };
    assert(typeof body.error === 'string' && body.error.length > 0);
  }));

// ─── POST /emit/batch ─────────────────────────────────────────────────────────

Deno.test('POST /emit/batch returns { jobIds } array', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { event: 'order.placed', data: { orderId: 1 } },
        { event: 'order.placed', data: { orderId: 2 } },
      ]),
    });
    assertEquals(res.status, 200);
    const body = await res.json() as { jobIds: string[] };
    assert(Array.isArray(body.jobIds));
    assertEquals(body.jobIds.length, 2);
  }));

Deno.test('POST /emit/batch returns 400 when body is not an array', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'oops' }),
    });
    assertEquals(res.status, 400);
    const body = await res.json() as { error: string };
    assert(body.error.includes('array'));
  }));

Deno.test('POST /emit/batch returns 400 with offending index when entry missing event', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { event: 'order.placed', data: { id: 1 } },
        { data: { id: 2 } },
      ]),
    });
    assertEquals(res.status, 400);
    const body = await res.json() as { error: string };
    assert(body.error.includes('jobs[1]'), `expected error to reference jobs[1], got: ${body.error}`);
  }));

Deno.test('POST /emit/batch forwards data + options to hound.emitBatch unchanged', () => {
  const captured: CapturedBatch[] = [];
  return withGateway(mockHound({ capture: { batch: captured } }), undefined, async (base) => {
    const res = await fetch(`${base}/emit/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          event: 'order.placed',
          data: { orderId: 42 },
          options: { queue: 'priority', priority: 10, attempts: 3 },
        },
      ]),
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(captured.length, 1);
    assertEquals(captured[0].event, 'order.placed');
    assertEquals(captured[0].data, { orderId: 42 });
    assertEquals(captured[0].options, { queue: 'priority', priority: 10, attempts: 3 });
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

Deno.test('request without token is rejected 401 when auth is configured', () =>
  withGateway(mockHound(), 'secret-token', async (base) => {
    const res = await fetch(`${base}/health`);
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }));

Deno.test('request with correct Bearer token is accepted', () =>
  withGateway(mockHound(), 'secret-token', async (base) => {
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assertEquals(res.status, 200);
    assertEquals((await res.json() as any).status, 'ok');
  }));

Deno.test('request with wrong token is rejected 401', () =>
  withGateway(mockHound(), 'secret-token', async (base) => {
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }));

// ─── 404 ──────────────────────────────────────────────────────────────────────

Deno.test('unknown route returns 404', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/unknown`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  }));

// ─── Management — no instance → 404 ──────────────────────────────────────────

Deno.test('GET /management/* returns 404 when no management instance passed', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/management/jobs`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  }));

// ─── Management helpers ───────────────────────────────────────────────────────

async function withMgmtGateway<T>(
  fn: (base: string, db: ReturnType<typeof makeDb>) => Promise<T>,
): Promise<T> {
  const db = makeDb();
  const management = new HoundManagement({ db });
  const server = createGateway({ port: 0, hound: mockHound(), management });
  const port = (server.addr as Deno.NetAddr).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base, db);
  } finally {
    await server.shutdown();
  }
}

async function seedJob(
  db: ReturnType<typeof makeDb>,
  queue: string,
  jobId: string,
  status: 'waiting' | 'delayed' | 'processing' | 'completed' | 'failed',
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const payload = {
    id: jobId,
    state: { name: 'test.event', queue, data: {}, options: {} },
    status,
    delayUntil: 0, lockUntil: 0, priority: 0, retryCount: 0, retryDelayMs: 1000,
    retryBackoff: 'fixed', retriedAttempts: 0, repeatCount: 0, repeatDelayMs: 0,
    logs: [], errors: [], timestamp: Date.now(), paused: false,
    ...overrides,
  };
  const key = status === 'completed' || status === 'failed'
    ? `queues:${queue}:${jobId}:${status}:exec1`
    : `queues:${queue}:${jobId}:${status}`;
  await db.set(key, JSON.stringify(payload));
}

const H = { 'Content-Type': 'application/json' };

// ─── GET /management/jobs ─────────────────────────────────────────────────────

Deno.test('GET /management/jobs returns all jobs', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-a', 'waiting');
    await seedJob(db, 'default', 'job-b', 'failed');
    const res = await fetch(`${base}/management/jobs`);
    assertEquals(res.status, 200);
    const jobs = await res.json() as any[];
    assertEquals(jobs.length, 2);
  }));

Deno.test('GET /management/jobs?queue= filters by queue', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'q-a', 'job-1', 'waiting');
    await seedJob(db, 'q-b', 'job-2', 'waiting');
    const res = await fetch(`${base}/management/jobs?queue=q-a`);
    assertEquals(res.status, 200);
    const jobs = await res.json() as any[];
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].queue, 'q-a');
  }));

Deno.test('GET /management/jobs?status= filters by status', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-w', 'waiting');
    await seedJob(db, 'default', 'job-f', 'failed');
    const res = await fetch(`${base}/management/jobs?status=waiting`);
    assertEquals(res.status, 200);
    const jobs = await res.json() as any[];
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].status, 'waiting');
  }));

// ─── GET /management/jobs/:queue/:jobId ───────────────────────────────────────

Deno.test('GET /management/jobs/:queue/:jobId returns job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/jobs/default/job-1`);
    assertEquals(res.status, 200);
    const job = await res.json() as any;
    assertEquals(job.id, 'job-1');
  }));

Deno.test('GET /management/jobs/:queue/:jobId returns null for missing job', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/jobs/default/ghost`);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), null);
  }));

// ─── DELETE /management/jobs/:queue/:jobId ────────────────────────────────────

Deno.test('DELETE /management/jobs/:queue/:jobId deletes and returns { deleted: true }', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/jobs/default/job-1`, { method: 'DELETE' });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { deleted: true });
  }));

Deno.test('DELETE /management/jobs/:queue/:jobId returns { deleted: false } for missing job', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/jobs/default/ghost`, { method: 'DELETE' });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { deleted: false });
  }));

// ─── POST /management/jobs/:queue/:jobId/pause ────────────────────────────────

Deno.test('POST /management/jobs/:queue/:jobId/pause pauses a waiting job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/jobs/default/job-1/pause`, { method: 'POST', headers: H });
    assertEquals(res.status, 200);
    const job = await res.json() as any;
    assertEquals(job.paused, true);
  }));

Deno.test('POST /management/jobs/:queue/:jobId/pause returns 500 for non-pauseable job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'processing');
    const res = await fetch(`${base}/management/jobs/default/job-1/pause`, { method: 'POST', headers: H });
    assertEquals(res.status, 500);
    const body = await res.json() as any;
    assert(body.error.includes('Cannot pause'));
  }));

// ─── POST /management/jobs/:queue/:jobId/resume ───────────────────────────────

Deno.test('POST /management/jobs/:queue/:jobId/resume resumes a paused job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting', { paused: true, delayUntil: Number.MAX_SAFE_INTEGER });
    const res = await fetch(`${base}/management/jobs/default/job-1/resume`, { method: 'POST', headers: H });
    assertEquals(res.status, 200);
    const job = await res.json() as any;
    assertEquals(job.paused, false);
  }));

// ─── GET /management/queues ───────────────────────────────────────────────────

Deno.test('GET /management/queues returns queue list', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'payments', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/queues`);
    assertEquals(res.status, 200);
    const queues = await res.json() as any[];
    assert(queues.some((q: any) => q.name === 'payments'));
  }));

// ─── GET /management/queues/:queue/stats ──────────────────────────────────────

Deno.test('GET /management/queues/:queue/stats returns per-status counts', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-w', 'waiting');
    await seedJob(db, 'default', 'job-f', 'failed');
    const res = await fetch(`${base}/management/queues/default/stats`);
    assertEquals(res.status, 200);
    const stats = await res.json() as any;
    assertEquals(stats.waiting, 1);
    assertEquals(stats.failed, 1);
    assertEquals(stats.total, 2);
  }));

// ─── POST /management/queues/:queue/pause|resume|reset ────────────────────────

Deno.test('POST /management/queues/:queue/pause pauses the queue', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/queues/default/pause`, { method: 'POST', headers: H });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  }));

Deno.test('POST /management/queues/:queue/resume resumes the queue', () =>
  withMgmtGateway(async (base) => {
    await (await fetch(`${base}/management/queues/default/pause`, { method: 'POST', headers: H })).body?.cancel();
    const res = await fetch(`${base}/management/queues/default/resume`, { method: 'POST', headers: H });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  }));

Deno.test('POST /management/queues/:queue/reset clears the queue', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/queues/default/reset`, { method: 'POST', headers: H });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    // Verify queue is empty
    const jobs = await fetch(`${base}/management/jobs?queue=default`).then((r) => r.json()) as any[];
    assertEquals(jobs.length, 0);
  }));
