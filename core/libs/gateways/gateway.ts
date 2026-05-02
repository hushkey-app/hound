/**
 * HTTP gateway — exposes Hound over REST.
 *
 * Emit endpoints:
 *   POST /emit                              — emit a single job, returns { jobId }
 *   POST /emit/batch                        — emit multiple jobs, returns { jobIds }
 *   GET  /health                            — liveness check
 *
 * Management endpoints (requires GatewayOptions.management):
 *   GET    /management/jobs                 — list all jobs (query: queue, status)
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
import type { EmitOptions } from '../../types/index.ts';
import type { Hound } from '../hound/mod.ts';
import type { HoundManagement, JobRecord, FindJobsOptions } from '../hound-management/mod.ts';

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
  /** Called once the server is bound and ready to accept connections. */
  onListen?: (addr: Deno.NetAddr) => void;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function checkAuth(req: Request, token?: string): Response | null {
  if (!token) return null;
  const header = req.headers.get('Authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (provided !== token) return new Response('Unauthorized', { status: 401 });
  return null;
}

export function createGateway(options: GatewayOptions): Deno.HttpServer<Deno.NetAddr> {
  const { port, hostname = '0.0.0.0', hound, auth, management, onListen } = options;

  return Deno.serve(
    { hostname, port, onListen },
    async (req: Request): Promise<Response> => {
      try {
        const authError = checkAuth(req, auth);
        if (authError) return authError;

        const url = new URL(req.url);

        if (req.method === 'GET' && url.pathname === '/health') {
          return json({ status: 'ok' });
        }

        if (req.method === 'POST' && url.pathname === '/emit') {
          const body = await req.json() as {
            event: string;
            data?: unknown;
            options?: EmitOptions;
          };
          if (!body?.event) return json({ error: 'event is required' }, 400);
          const jobId = await hound.emitAsync(body.event, body.data, body.options);
          return json({ jobId });
        }

        if (req.method === 'POST' && url.pathname === '/emit/batch') {
          const jobs = await req.json() as Array<{
            event: string;
            data?: unknown;
            options?: EmitOptions;
          }>;
          if (!Array.isArray(jobs)) return json({ error: 'body must be an array' }, 400);
          for (let i = 0; i < jobs.length; i++) {
            if (!jobs[i]?.event) return json({ error: `jobs[${i}].event is required` }, 400);
          }
          const jobIds = await hound.emitBatch(jobs);
          return json({ jobIds });
        }

        if (url.pathname.startsWith('/management')) {
          if (!management) return new Response(null, { status: 404 });
          return handleManagement(req, url, management);
        }

        return new Response(null, { status: 404 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: msg }, 500);
      }
    },
  );
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
        return json(await m.api.jobs.find(opts));
      }

      const [, queue, jobId, action] = segs;
      if (!queue || !jobId) return json({ error: 'missing queue or jobId in path' }, 400);
      const key = `${queue}:${jobId}`;

      if (req.method === 'GET' && !action) return json(await m.api.jobs.get(key));
      if (req.method === 'DELETE' && !action) return json({ deleted: await m.api.jobs.delete(key) });
      if (req.method === 'POST' && action === 'pause') return json(await m.api.jobs.pause(key));
      if (req.method === 'POST' && action === 'resume') return json(await m.api.jobs.resume(key));
      if (req.method === 'POST' && action === 'promote') return json(await m.api.jobs.promote(key));
      if (req.method === 'POST' && action === 'retry') return json(await m.api.jobs.retry(key));
    }

    if (segs[0] === 'queues') {
      if (req.method === 'GET' && segs.length === 1) return json(await m.api.queues.find());

      const [, queue, action] = segs;
      if (!queue) return json({ error: 'missing queue in path' }, 400);

      if (req.method === 'GET' && action === 'stats') return json(await m.api.queues.stats(queue));
      if (req.method === 'POST' && action === 'pause') { await m.api.queues.pause(queue); return json({ ok: true }); }
      if (req.method === 'POST' && action === 'resume') { await m.api.queues.resume(queue); return json({ ok: true }); }
      if (req.method === 'POST' && action === 'reset') { await m.api.queues.reset(queue); return json({ ok: true }); }
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}
