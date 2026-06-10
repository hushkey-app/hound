/**
 * HTTP gateway — exposes Hound over REST.
 *
 * Emit endpoints:
 *   GET  /                                  — endpoint index
 *   POST /emit                              — emit a single job, returns { jobId }
 *   POST /emit/batch                        — emit multiple jobs, returns { jobIds }
 *   POST /emit/wait                         — emit and hold the connection until the job
 *                                             finishes; returns { jobId, status } (408 on wait timeout)
 *   GET  /events                            — SSE stream of job-finished events (query: queue)
 *   GET  /health                            — liveness check
 *   GET  /metrics                           — Prometheus text: queue lengths + job counters
 *
 * Management endpoints (requires GatewayOptions.management):
 *   GET    /management/jobs                 — list jobs (query: queue, status, limit, offset)
 *   GET    /management/jobs/:queue/:jobId   — get job
 *   DELETE /management/jobs/:queue/:jobId   — delete job
 *   POST   /management/jobs/:queue/:jobId/pause
 *   POST   /management/jobs/:queue/:jobId/resume
 *   POST   /management/jobs/:queue/:jobId/promote
 *   POST   /management/jobs/:queue/:jobId/retry
 *   GET    /management/queues               — list queues
 *   GET    /management/queues/:queue/stats  — per-status counts
 *   POST   /management/queues/:queue/pause
 *   POST   /management/queues/:queue/resume
 *   POST   /management/queues/:queue/reset
 *
 * Auth (optional): pass Authorization: Bearer <token> on all requests.
 *
 * @module
 */
import type { EmitOptions, HoundMetrics } from '../../types/index.ts';
import type { Hound } from '../hound/mod.ts';
import type {
  FindJobsOptions,
  HoundManagement,
  JobFinishedPayload,
  JobRecord,
} from '../hound-management/mod.ts';
import { genJobIdSync, isTimeoutError } from '../../utils/index.ts';

// Symbol.for — global registry, so no runtime import from hound/mod.ts is
// needed (createGateway is imported BY hound/mod.ts; a value import back
// would create a cycle).
const JOB_FINISHED = Symbol.for('hound.subscribeJobFinished');

export type GatewayOptions = {
  port: number;
  hostname?: string;
  hound: Hound<any>;
  /**
   * Pass a HoundManagement instance to enable the /management/* REST API.
   * When omitted, all /management/* routes return 404.
   */
  management?: HoundManagement;
  /** Optional Bearer token. When set, all requests must include Authorization: Bearer <token>. */
  auth?: string;
  /** Max accepted request body size in bytes. Default 1 MiB. Oversized bodies get 413. */
  maxBodyBytes?: number;
  /**
   * CORS for browser clients. `true` allows any origin (`*`); a string allows
   * that origin only. Adds the headers to every response and answers OPTIONS
   * preflights (which browsers send without Authorization). Off by default.
   */
  cors?: boolean | string;
  /** Called once the server is bound and ready to accept connections. */
  onListen?: (addr: Deno.NetAddr) => void;
};

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB
// Server-side ceiling for /emit/wait — keeps held connections bounded even
// when clients ask for absurd timeouts.
const MAX_WAIT_MS = 120_000;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Constant-time string compare — a plain !== short-circuits at the first
// differing byte, leaking token prefixes through response timing.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

/** Parse a JSON body with a size cap. Returns the parsed value or an error Response. */
async function readJson(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      res: json({ error: `request body exceeds ${maxBytes} bytes` }, 413),
    };
  }
  const text = await req.text();
  if (text.length > maxBytes) {
    return {
      ok: false,
      res: json({ error: `request body exceeds ${maxBytes} bytes` }, 413),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, res: json({ error: 'invalid JSON body' }, 400) };
  }
}

function checkAuth(req: Request, token?: string): Response | null {
  if (!token) return null;
  const header = req.headers.get('Authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!timingSafeEqual(provided, token)) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

export function createGateway(
  options: GatewayOptions,
): Deno.HttpServer<Deno.NetAddr> {
  const { port, hostname = '0.0.0.0', hound, auth, management, onListen } =
    options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const corsOrigin = options.cors === true ? '*' : options.cors || undefined;

  // Open SSE connections — closed on shutdown so the server can actually
  // drain (Deno.serve's shutdown waits for in-flight responses to finish).
  const sseCleanups = new Set<() => void>();

  const applyCors = (res: Response): Response => {
    if (!corsOrigin) return res;
    res.headers.set('Access-Control-Allow-Origin', corsOrigin);
    return res;
  };

  const handle = async (req: Request): Promise<Response> => {
    try {
      const authError = checkAuth(req, auth);
      if (authError) return authError;

      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/') {
        return json({
          service: 'hound-gateway',
          endpoints: [
            'GET  /',
            'GET  /health',
            'GET  /metrics',
            'GET  /events',
            'POST /emit',
            'POST /emit/batch',
            'POST /emit/wait',
            ...(management
              ? [
                'GET  /management/jobs',
                'GET  /management/jobs/:queue/:jobId',
                'DELETE /management/jobs/:queue/:jobId',
                'POST /management/jobs/:queue/:jobId/{pause|resume|promote|retry}',
                'GET  /management/queues',
                'GET  /management/queues/:queue/stats',
                'POST /management/queues/:queue/{pause|resume|reset}',
              ]
              : []),
          ],
        });
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok' });
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        if (typeof hound.metrics !== 'function') {
          return json(
            { error: 'metrics not supported by this hound instance' },
            501,
          );
        }
        return new Response(renderPrometheus(await hound.metrics()), {
          headers: { 'Content-Type': 'text/plain; version=0.0.4' },
        });
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        return handleEvents(url, hound, sseCleanups);
      }

      if (req.method === 'POST' && url.pathname === '/emit') {
        const parsed = await readJson(req, maxBodyBytes);
        if (!parsed.ok) return parsed.res;
        const body = parsed.value as {
          event: string;
          data?: unknown;
          options?: EmitOptions;
        };
        if (!body?.event) return json({ error: 'event is required' }, 400);
        const jobId = await hound.emitAsync(
          body.event,
          body.data,
          body.options,
        );
        return json({ jobId });
      }

      if (req.method === 'POST' && url.pathname === '/emit/batch') {
        const parsed = await readJson(req, maxBodyBytes);
        if (!parsed.ok) return parsed.res;
        const jobs = parsed.value as Array<{
          event: string;
          data?: unknown;
          options?: EmitOptions;
        }>;
        if (!Array.isArray(jobs)) {
          return json({ error: 'body must be an array' }, 400);
        }
        for (let i = 0; i < jobs.length; i++) {
          if (!jobs[i]?.event) {
            return json({ error: `jobs[${i}].event is required` }, 400);
          }
        }
        const jobIds = await hound.emitBatch(jobs);
        return json({ jobIds });
      }

      if (req.method === 'POST' && url.pathname === '/emit/wait') {
        const parsed = await readJson(req, maxBodyBytes);
        if (!parsed.ok) return parsed.res;
        const body = parsed.value as {
          event: string;
          data?: unknown;
          options?: EmitOptions & { timeoutMs?: number };
        };
        if (!body?.event) return json({ error: 'event is required' }, 400);

        const opts = body.options ?? {};
        const timeoutMs = Math.min(opts.timeoutMs ?? 30_000, MAX_WAIT_MS);
        // Pin the id so we can report it even when the job fails.
        const jobId = opts.id ?? genJobIdSync(body.event, body.data ?? {});

        try {
          await hound.emitAndWait(body.event, body.data, {
            ...opts,
            id: jobId,
            timeoutMs,
          });
          return json({ jobId, status: 'completed' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Wait timeout ≠ job failure: the job may still be queued or running.
          if (isTimeoutError(err)) return json({ jobId, error: msg }, 408);
          return json({ jobId, status: 'failed', error: msg });
        }
      }

      if (url.pathname.startsWith('/management')) {
        if (!management) return json({ error: 'not found' }, 404);
        return handleManagement(req, url, management);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
  };

  const server = Deno.serve(
    { hostname, port, onListen },
    async (req: Request): Promise<Response> => {
      // Preflight first — browsers send OPTIONS without Authorization.
      if (corsOrigin && req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '86400',
          },
        });
      }
      return applyCors(await handle(req));
    },
  );

  const shutdown = server.shutdown.bind(server);
  return Object.assign(server, {
    shutdown: (): Promise<void> => {
      for (const close of sseCleanups) {
        try {
          close();
        } catch { /* already closed */ }
      }
      sseCleanups.clear();
      return shutdown();
    },
  });
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function renderPrometheus(m: HoundMetrics): string {
  const esc = (s: string) => s.replace(/(["\\])/g, '\\$1');
  const lines: string[] = [
    '# TYPE hound_uptime_seconds gauge',
    `hound_uptime_seconds ${m.uptimeSeconds}`,
    '# TYPE hound_queue_length gauge',
    ...m.queues.map((q) =>
      `hound_queue_length{queue="${esc(q.name)}"} ${q.length}`
    ),
    '# TYPE hound_jobs_processing gauge',
    ...m.queues.map((q) =>
      `hound_jobs_processing{queue="${esc(q.name)}"} ${q.processing}`
    ),
    '# TYPE hound_jobs_completed_total counter',
    ...m.queues.map((q) =>
      `hound_jobs_completed_total{queue="${esc(q.name)}"} ${q.completed}`
    ),
    '# TYPE hound_jobs_failed_total counter',
    ...m.queues.map((q) =>
      `hound_jobs_failed_total{queue="${esc(q.name)}"} ${q.failed}`
    ),
  ];
  return lines.join('\n') + '\n';
}

// ─── SSE: job-finished events ─────────────────────────────────────────────────

function handleEvents(
  url: URL,
  hound: Hound<any>,
  sseCleanups: Set<() => void>,
): Response {
  const subscribe = (hound as unknown as Record<symbol, unknown>)[
    JOB_FINISHED
  ] as
    | ((cb: (payload: JobFinishedPayload) => void) => () => void)
    | undefined;
  if (typeof subscribe !== 'function') {
    return json({ error: 'events not supported by this hound instance' }, 501);
  }

  const queueFilter = url.searchParams.get('queue');
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch { /* stream already closed */ }
      };

      send(': connected\n\n');
      const unsubscribe = subscribe.call(hound, (payload) => {
        if (queueFilter && payload.queue !== queueFilter) return;
        send(`event: job.finished\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      // Heartbeat defeats idle proxy timeouts and surfaces dead connections.
      const heartbeat = setInterval(() => send(': ping\n\n'), 15_000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseCleanups.delete(cleanup);
        try {
          controller.close();
        } catch { /* already closed */ }
      };
      sseCleanups.add(cleanup);
    },
    cancel: () => cleanup(),
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

// ─── Management route handler ─────────────────────────────────────────────────

async function handleManagement(
  req: Request,
  url: URL,
  m: HoundManagement,
): Promise<Response> {
  // Strip leading /management/ and split into path segments
  const path = url.pathname.replace(/^\/management\/?/, '');
  const segs = path ? path.split('/') : [];
  // segs for jobs:   ['jobs'] | ['jobs', queue, jobId] | ['jobs', queue, jobId, action]
  // segs for queues: ['queues'] | ['queues', queue, action]

  try {
    if (segs[0] === 'jobs') {
      if (req.method === 'GET' && segs.length === 1) {
        const opts: FindJobsOptions = {};
        const q = url.searchParams.get('queue');
        const s = url.searchParams.get('status') as JobRecord['status'] | null;
        if (q) opts.queue = q;
        if (s) opts.status = s;
        for (const param of ['limit', 'offset'] as const) {
          const raw = url.searchParams.get(param);
          if (raw === null) continue;
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 0) {
            return json(
              { error: `${param} must be a non-negative integer` },
              400,
            );
          }
          opts[param] = n;
        }
        return json(await m.api.jobs.find(opts));
      }

      const [, queue, jobId, action] = segs;
      if (!queue || !jobId) {
        return json({ error: 'missing queue or jobId in path' }, 400);
      }
      const key = `${queue}:${jobId}`;

      // The jobs API returns null for unknown jobs — surface that as 404.
      const jobOr404 = (job: JobRecord | null) =>
        job ? json(job) : json({ error: 'job not found' }, 404);

      if (req.method === 'GET' && !action) {
        return jobOr404(await m.api.jobs.get(key));
      }
      if (req.method === 'DELETE' && !action) {
        return json({ deleted: await m.api.jobs.delete(key) });
      }
      if (req.method === 'POST' && action === 'pause') {
        return jobOr404(await m.api.jobs.pause(key));
      }
      if (req.method === 'POST' && action === 'resume') {
        return jobOr404(await m.api.jobs.resume(key));
      }
      if (req.method === 'POST' && action === 'promote') {
        return jobOr404(await m.api.jobs.promote(key));
      }
      if (req.method === 'POST' && action === 'retry') {
        return jobOr404(await m.api.jobs.retry(key));
      }
    }

    if (segs[0] === 'queues') {
      if (req.method === 'GET' && segs.length === 1) {
        return json(await m.api.queues.find());
      }

      const [, queue, action] = segs;
      if (!queue) return json({ error: 'missing queue in path' }, 400);

      if (req.method === 'GET' && action === 'stats') {
        return json(await m.api.queues.stats(queue));
      }
      if (req.method === 'POST' && action === 'pause') {
        await m.api.queues.pause(queue);
        return json({ ok: true });
      }
      if (req.method === 'POST' && action === 'resume') {
        await m.api.queues.resume(queue);
        return json({ ok: true });
      }
      if (req.method === 'POST' && action === 'reset') {
        await m.api.queues.reset(queue);
        return json({ ok: true });
      }
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}
