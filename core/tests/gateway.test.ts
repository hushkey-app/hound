/**
 * HTTP gateway integration tests — spins up a real Deno.serve on port 0
 * and makes actual fetch calls. No Redis required.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createGateway } from '../libs/gateways/gateway.ts';
import { HoundManagement } from '../libs/hound-management/mod.ts';
import { makeDb } from './helpers.ts';
import { indexKey, QUEUE_REGISTRY_KEY } from '../libs/consumer/job-index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let jobSeq = 0;
type CapturedBatch = { event: string; data?: unknown; options?: unknown };
function mockHound(
  opts: { failOn?: string; capture?: { batch?: CapturedBatch[] } } = {},
) {
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
  withGateway(
    mockHound({ failOn: 'broken.event' }),
    undefined,
    async (base) => {
      const res = await fetch(`${base}/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'broken.event' }),
      });
      assertEquals(res.status, 500);
      const body = await res.json() as { error: string };
      assert(body.error.includes('forced failure'));
    },
  ));

Deno.test('POST /emit returns 400 on malformed request body', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{',
    });
    assertEquals(res.status, 400);
    const body = await res.json() as { error: string };
    assert(body.error.includes('invalid JSON'));
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
    assert(
      body.error.includes('jobs[1]'),
      `expected error to reference jobs[1], got: ${body.error}`,
    );
  }));

Deno.test('POST /emit/batch forwards data + options to hound.emitBatch unchanged', () => {
  const captured: CapturedBatch[] = [];
  return withGateway(
    mockHound({ capture: { batch: captured } }),
    undefined,
    async (base) => {
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
      assertEquals(captured[0].options, {
        queue: 'priority',
        priority: 10,
        attempts: 3,
      });
    },
  );
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
    delayUntil: 0,
    lockUntil: 0,
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
    paused: false,
    ...overrides,
  };
  const key = status === 'completed' || status === 'failed'
    ? `queues:${queue}:${jobId}:${status}:exec1`
    : `queues:${queue}:${jobId}:${status}`;
  await db.set(key, JSON.stringify(payload));
  // Mirror the engine's index upkeep — management reads are index-backed.
  await db.zadd(indexKey(queue, status), payload.timestamp as number, key);
  await db.zadd(QUEUE_REGISTRY_KEY, Date.now(), queue);
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

Deno.test('GET /management/jobs/:queue/:jobId returns 404 for missing job', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/jobs/default/ghost`);
    assertEquals(res.status, 404);
    const body = await res.json() as any;
    assert(body.error.includes('not found'));
  }));

Deno.test('POST /management/jobs/:queue/:jobId/pause returns 404 for missing job', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/jobs/default/ghost/pause`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  }));

// ─── DELETE /management/jobs/:queue/:jobId ────────────────────────────────────

Deno.test('DELETE /management/jobs/:queue/:jobId deletes and returns { deleted: true }', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/jobs/default/job-1`, {
      method: 'DELETE',
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { deleted: true });
  }));

Deno.test('DELETE /management/jobs/:queue/:jobId returns { deleted: false } for missing job', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/jobs/default/ghost`, {
      method: 'DELETE',
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { deleted: false });
  }));

// ─── POST /management/jobs/:queue/:jobId/pause ────────────────────────────────

Deno.test('POST /management/jobs/:queue/:jobId/pause pauses a waiting job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/jobs/default/job-1/pause`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 200);
    const job = await res.json() as any;
    assertEquals(job.paused, true);
  }));

Deno.test('POST /management/jobs/:queue/:jobId/pause returns 500 for non-pauseable job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'processing');
    const res = await fetch(`${base}/management/jobs/default/job-1/pause`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 500);
    const body = await res.json() as any;
    assert(body.error.includes('Cannot pause'));
  }));

// ─── POST /management/jobs/:queue/:jobId/resume ───────────────────────────────

Deno.test('POST /management/jobs/:queue/:jobId/resume resumes a paused job', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting', {
      paused: true,
      delayUntil: Number.MAX_SAFE_INTEGER,
    });
    const res = await fetch(`${base}/management/jobs/default/job-1/resume`, {
      method: 'POST',
      headers: H,
    });
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
    const res = await fetch(`${base}/management/queues/default/pause`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  }));

Deno.test('POST /management/queues/:queue/resume resumes the queue', () =>
  withMgmtGateway(async (base) => {
    await (await fetch(`${base}/management/queues/default/pause`, {
      method: 'POST',
      headers: H,
    })).body?.cancel();
    const res = await fetch(`${base}/management/queues/default/resume`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  }));

Deno.test('POST /management/queues/:queue/reset clears the queue', () =>
  withMgmtGateway(async (base, db) => {
    await seedJob(db, 'default', 'job-1', 'waiting');
    const res = await fetch(`${base}/management/queues/default/reset`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    // Verify queue is empty
    const jobs = await fetch(`${base}/management/jobs?queue=default`).then((
      r,
    ) => r.json()) as any[];
    assertEquals(jobs.length, 0);
  }));

// ─── POST /emit/wait ──────────────────────────────────────────────────────────

import { HoundTimeoutError } from '../utils/errors.ts';

function mockWaitHound(behavior: 'complete' | 'fail' | 'timeout') {
  return {
    emitAndWait: async (
      _event: string,
      _data: unknown,
      options?: { id?: string; timeoutMs?: number },
    ) => {
      if (behavior === 'fail') throw new Error('handler exploded');
      if (behavior === 'timeout') {
        throw new HoundTimeoutError(
          `Job ${options?.id} timed out after ${options?.timeoutMs}ms`,
        );
      }
      return options?.id ?? 'job-wait-1';
    },
  } as any;
}

Deno.test('POST /emit/wait returns { jobId, status: completed } on success', () =>
  withGateway(mockWaitHound('complete'), undefined, async (base) => {
    const res = await fetch(`${base}/emit/wait`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ event: 'user.created', data: { id: 1 } }),
    });
    assertEquals(res.status, 200);
    const body = await res.json() as any;
    assertEquals(body.status, 'completed');
    assert(typeof body.jobId === 'string' && body.jobId.length > 0);
  }));

Deno.test('POST /emit/wait reports job failure with status failed + error', () =>
  withGateway(mockWaitHound('fail'), undefined, async (base) => {
    const res = await fetch(`${base}/emit/wait`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ event: 'user.created', data: { id: 1 } }),
    });
    assertEquals(res.status, 200);
    const body = await res.json() as any;
    assertEquals(body.status, 'failed');
    assert(body.error.includes('handler exploded'));
    assert(typeof body.jobId === 'string');
  }));

Deno.test('POST /emit/wait returns 408 on wait timeout', () =>
  withGateway(mockWaitHound('timeout'), undefined, async (base) => {
    const res = await fetch(`${base}/emit/wait`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ event: 'user.created', data: { id: 1 } }),
    });
    assertEquals(res.status, 408);
    const body = await res.json() as any;
    assert(body.error.includes('timed out'));
  }));

Deno.test('POST /emit/wait returns 400 when event is missing', () =>
  withGateway(mockWaitHound('complete'), undefined, async (base) => {
    const res = await fetch(`${base}/emit/wait`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ data: {} }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  }));

// ─── Body size cap ────────────────────────────────────────────────────────────

Deno.test('request body over maxBodyBytes is rejected 413', async () => {
  const server = createGateway({
    port: 0,
    hound: mockHound(),
    maxBodyBytes: 64,
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const res = await fetch(`${base}/emit`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        event: 'big.payload',
        data: { blob: 'x'.repeat(200) },
      }),
    });
    assertEquals(res.status, 413);
    const body = await res.json() as any;
    assert(body.error.includes('exceeds'));
  } finally {
    await server.shutdown();
  }
});

// ─── GET /events (SSE) ────────────────────────────────────────────────────────

function mockSseHound() {
  const listeners = new Set<(p: unknown) => void>();
  const h = {
    fire: (p: unknown) => {
      for (const cb of listeners) cb(p);
    },
  } as any;
  h[Symbol.for('hound.subscribeJobFinished')] = (cb: (p: unknown) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  return h;
}

Deno.test('GET /events streams job-finished payloads as SSE', async () => {
  const hound = mockSseHound();
  const server = createGateway({ port: 0, hound });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const res = await fetch(`${base}/events`);
    assertEquals(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let buf = decoder.decode((await reader.read()).value);
    assert(buf.includes(': connected'));

    hound.fire({ jobId: 'j1', queue: 'default', status: 'completed' });
    while (!buf.includes('job.finished')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    assert(buf.includes('event: job.finished'));
    assert(buf.includes('"jobId":"j1"'));
    await reader.cancel();
  } finally {
    await server.shutdown();
  }
});

Deno.test('server.shutdown() closes open SSE connections instead of hanging', async () => {
  const hound = mockSseHound();
  const server = createGateway({ port: 0, hound });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  await reader.read(); // ': connected'

  await server.shutdown(); // must resolve — SSE cleanup closes the stream

  while (!(await reader.read()).done) { /* drain remaining bytes */ }
});

// ─── GET /management/jobs pagination ──────────────────────────────────────────

Deno.test('GET /management/jobs?limit=&offset= paginates results', () =>
  withMgmtGateway(async (base, db) => {
    const now = Date.now();
    await seedJob(db, 'default', 'job-1', 'waiting', { timestamp: now - 2000 });
    await seedJob(db, 'default', 'job-2', 'waiting', { timestamp: now - 1000 });
    await seedJob(db, 'default', 'job-3', 'waiting', { timestamp: now });

    const page1 = await fetch(`${base}/management/jobs?limit=2`).then((r) =>
      r.json()
    ) as any[];
    assertEquals(page1.length, 2);
    assertEquals(page1[0].id, 'job-3'); // newest first

    const page2 = await fetch(`${base}/management/jobs?limit=2&offset=2`).then((
      r,
    ) => r.json()) as any[];
    assertEquals(page2.length, 1);
    assertEquals(page2[0].id, 'job-1');
  }));

Deno.test('GET /management/jobs rejects non-integer limit with 400', () =>
  withMgmtGateway(async (base) => {
    const res = await fetch(`${base}/management/jobs?limit=abc`);
    assertEquals(res.status, 400);
    const body = await res.json() as any;
    assert(body.error.includes('limit'));
  }));

// ─── Root index ───────────────────────────────────────────────────────────────

Deno.test('GET / lists available endpoints', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/`);
    assertEquals(res.status, 200);
    const body = await res.json() as { service: string; endpoints: string[] };
    assertEquals(body.service, 'hound-gateway');
    assert(body.endpoints.some((e) => e.includes('/emit/wait')));
    // No management instance — management routes not advertised
    assert(!body.endpoints.some((e) => e.includes('/management')));
  }));

Deno.test('unknown route returns JSON 404', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/nope`);
    assertEquals(res.status, 404);
    const body = await res.json() as any;
    assert(body.error.includes('not found'));
  }));

// ─── CORS ─────────────────────────────────────────────────────────────────────

Deno.test('cors: OPTIONS preflight answered without auth, responses carry origin header', async () => {
  const server = createGateway({
    port: 0,
    hound: mockHound(),
    auth: 'secret-token',
    cors: 'https://dash.example.com',
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    // Preflight: no Authorization header, must still succeed
    const pre = await fetch(`${base}/emit`, { method: 'OPTIONS' });
    assertEquals(pre.status, 204);
    assertEquals(
      pre.headers.get('access-control-allow-origin'),
      'https://dash.example.com',
    );
    assert(
      pre.headers.get('access-control-allow-headers')?.includes(
        'Authorization',
      ),
    );
    await pre.body?.cancel();

    // Actual request: auth enforced, response carries the origin header
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get('access-control-allow-origin'),
      'https://dash.example.com',
    );
    await res.body?.cancel();

    const denied = await fetch(`${base}/health`);
    assertEquals(denied.status, 401);
    assertEquals(
      denied.headers.get('access-control-allow-origin'),
      'https://dash.example.com',
    );
    await denied.body?.cancel();
  } finally {
    await server.shutdown();
  }
});

Deno.test('cors: true allows any origin', async () => {
  const server = createGateway({ port: 0, hound: mockHound(), cors: true });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const res = await fetch(`${base}/health`);
    assertEquals(res.headers.get('access-control-allow-origin'), '*');
    await res.body?.cancel();
  } finally {
    await server.shutdown();
  }
});

Deno.test('cors off by default — no origin header', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/health`);
    assertEquals(res.headers.get('access-control-allow-origin'), null);
    await res.body?.cancel();
  }));

// ─── GET /metrics ─────────────────────────────────────────────────────────────

function mockMetricsHound() {
  return {
    metrics: async () => ({
      uptimeSeconds: 5,
      totals: { completed: 2, failed: 1 },
      queues: [
        { name: 'default', length: 3, processing: 1, completed: 2, failed: 1 },
      ],
    }),
  } as any;
}

Deno.test('GET /metrics renders Prometheus text', () =>
  withGateway(mockMetricsHound(), undefined, async (base) => {
    const res = await fetch(`${base}/metrics`);
    assertEquals(res.status, 200);
    assert(res.headers.get('content-type')?.startsWith('text/plain'));
    const body = await res.text();
    assert(body.includes('hound_uptime_seconds 5'));
    assert(body.includes('hound_queue_length{queue="default"} 3'));
    assert(body.includes('hound_jobs_processing{queue="default"} 1'));
    assert(body.includes('hound_jobs_completed_total{queue="default"} 2'));
    assert(body.includes('hound_jobs_failed_total{queue="default"} 1'));
  }));

Deno.test('GET /metrics returns 501 when hound has no metrics()', () =>
  withGateway(mockHound(), undefined, async (base) => {
    const res = await fetch(`${base}/metrics`);
    assertEquals(res.status, 501);
    await res.body?.cancel();
  }));

// ─── POST /management/reindex ─────────────────────────────────────────────────

Deno.test('POST /management/reindex rebuilds indexes for pre-index data', () =>
  withMgmtGateway(async (base, db) => {
    // Pre-index deployment: state key exists but no index entries
    await db.set(
      'queues:legacy:job-1:waiting',
      JSON.stringify({
        id: 'job-1',
        state: { name: 'test.event', queue: 'legacy', data: {}, options: {} },
        status: 'waiting',
        timestamp: Date.now(),
        logs: [],
        errors: [],
      }),
    );

    const before = await fetch(`${base}/management/jobs?queue=legacy`)
      .then((r) => r.json()) as unknown[];
    assertEquals(before.length, 0); // invisible before reindex

    const res = await fetch(`${base}/management/reindex`, {
      method: 'POST',
      headers: H,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { indexed: 1 });

    const after = await fetch(`${base}/management/jobs?queue=legacy`)
      .then((r) => r.json()) as unknown[];
    assertEquals(after.length, 1);
  }));
