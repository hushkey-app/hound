import { Hound, HoundManagement, InMemoryStorage } from '@core/mod.ts';
import type { RedisConnection } from '@core/types/index.ts';

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
  const { DenoKvStorage } = await import('@core/libs/storage/deno-kv.ts');
  db = await DenoKvStorage.open(DENO_KV || undefined);
  console.log('[hound] Using Deno KV' + (DENO_KV ? ` (${DENO_KV})` : ''));
} else {
  console.log('[hound] No REDIS_URL or DENO_KV — using InMemoryStorage');
  db = new InMemoryStorage();
}

const contextApp = {
  foo: 'bar',
};

const hound = Hound.create({
  db,
  ctx: contextApp,
  expose: 4000,
  concurrency: 10,
  processor: {
    pollIntervalMs: 1,
    claimCount: 200,
    maxLogsPerJob: 100,
    jobStateTtlSeconds: 604800, // 7 days
  },
});

const management = new HoundManagement({ db, hound });

export { hound, management };
