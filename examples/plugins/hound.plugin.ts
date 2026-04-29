import { Hound, HoundManagement, InMemoryStorage } from '@hushkey/hound/mod.ts';
import type { RedisConnection } from '@hushkey/hound/types/index.ts';
import type { TypedHound } from '@hushkey/hound/mod.ts';
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

const contextApp = {
  foo: 'bar',
};

const _hound = Hound.create({
  db,
  ctx: contextApp,
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

const management = new HoundManagement({ db, hound: _hound });

_hound.listen(4000, management, (ctx) => {
  console.log(ctx.hostname, ctx.port, ctx.transport);
});

export const hound = _hound as TypedHound<typeof contextApp, HoundJobMap>;
export { management };
