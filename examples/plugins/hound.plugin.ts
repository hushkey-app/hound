import {
  Broker,
  Hound,
  HoundApp,
  InMemoryStorage,
} from '@hushkey/hound/mod.ts';
import type { BrokerConnection } from '@hushkey/hound/mod.ts';
import type { RedisConnection } from '@hushkey/hound/types/index.ts';
import type { HoundJobMap } from '../gen/hound-types.ts';

const REDIS_URL = Deno.env.get('REDIS_URL');
const DENO_KV = Deno.env.get('DENO_KV');

let db: RedisConnection;

if (REDIS_URL) {
  const { Redis } = await import('npm:ioredis');
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  redis.on(
    'error',
    (err: Error) => console.warn('[hound] Redis error:', err.message),
  );
  db = redis as RedisConnection;
  console.log('[hound] Using Redis');
} else if (DENO_KV !== undefined) {
  const { DenoKvStorage } = await import(
    '@hushkey/hound/libs/storage/deno-kv.ts'
  );
  db = await DenoKvStorage.open(DENO_KV || undefined);
  console.log('[hound] Using Deno KV' + (DENO_KV ? ` (${DENO_KV})` : ''));
} else {
  console.log('[hound] No REDIS_URL or DENO_KV — using InMemoryStorage');
  db = new InMemoryStorage();
}

// Broker — fire-and-forget pub/sub for live events, separate from durable
// jobs. With Redis the subscriber connection is derived via duplicate();
// InMemoryStorage delivers in-process. Deno KV has no pub/sub surface, so
// the broker is skipped on that backend.
export const broker =
  typeof (db as Partial<BrokerConnection>).publish === 'function'
    ? new Broker({ pub: db as unknown as BrokerConnection })
    : undefined;

const contextApp = {
  foo: 'bar',
};

const app = new HoundApp<typeof contextApp, HoundJobMap>({
  db,
  ctx: contextApp,
  // With a broker, job-finished events cross process boundaries: emitAndWait
  // and the gateway's /events stream see jobs completed by other workers.
  broker,
  importMeta: import.meta,
  concurrency: 10,
  processor: {
    pollIntervalMs: 1000,
    claimCount: 200,
    maxLogsPerJob: 100,
    jobStateTtlSeconds: 604800, // 7 days
  },
  jobDirs: ['../_scheduled', '../_tasks'],
});

// app.listen() wires the management API into the gateway automatically.
const PORT = Number(Deno.env.get('HOUND_PORT') ?? 4000);
app.listen(PORT, (ctx) => {
  console.log(ctx.hostname, ctx.port, ctx.transport);
});

export const { hound, management, defineJob } = app;
