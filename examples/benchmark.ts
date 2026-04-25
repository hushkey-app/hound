import { Hound, InMemoryStorage } from '@core/mod.ts';
import type { RedisConnection } from '@core/types/index.ts';

const REDIS_URL = Deno.env.get('REDIS_URL');

let db: RedisConnection;
let backend: string;

if (REDIS_URL) {
  const { Redis } = await import('npm:ioredis');
  db = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }) as RedisConnection;
  backend = 'Redis';
} else {
  db = new InMemoryStorage();
  backend = 'InMemory';
}

console.log(`[benchmark] Backend: ${backend}`);

// Fresh instance — no jobDirs, no crons, no extra handlers
const hound = Hound.create({
  db,
  concurrency: 10000,
  processor: {
    pollIntervalMs: 0,
    claimCount: 200,
    maxLogsPerJob: 200,
    jobStateTtlSeconds: 604800,
  },
});

await hound.benchmark({
  totalJobs: 99999,
  simulatedWorkMs: 0,
});

await hound.stop();
Deno.exit(0);
