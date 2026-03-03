import { Remq } from '@core/libs/remq/mod.ts';
import { RemqAdmin } from '@core/libs/remq-admin/mod.ts';
import { Redis } from 'ioredis';

// Create Redis Option
const redisOption = {
  port: 6379,
  host: 'localhost',
  username: '',
  password: '',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  db: 1, //this will be assigned to 1 and stream will be assigned to 2, if you select 4 then it will be assigned to 4 and stream will be assigned to 5
};

// create a streamdb this enhances performance drastically and they get unaffected by the dashboard
const db = new Redis(redisOption);
// Handle connection errors so ECONNRESET / reconnects don't crash the process (ioredis auto-reconnects)
db.on('error', (err) => console.warn('[remq] Redis db error:', err.message));

// Optional: create separate streamdb connection for better performance
const streamdb = new Redis({ ...redisOption, db: redisOption.db + 1 });
streamdb.on(
  'error',
  (err) => console.warn('[remq] Redis streamdb error:', err.message),
);

// define the context for the app SAMPLE you pass your own context to the tasker so it will be always available, otherwise it will be undefined
const contextApp = {
  foo: 'bar',
};

// debug — remove after fix
// console.log('[remq] db index:', (db as any).options?.db);
// console.log('[remq] streamdb index:', (streamdb as any).options?.db);
// Initialize Remq (singleton)
const remq = Remq.create({
  db,
  streamdb,
  ctx: contextApp,
  expose: 4000, // WebSocket port; clients can send header x-get-broadcast: true to receive all task updates
  concurrency: 10, // the number of messages to process concurrently uses workers steal process strategy
  debug: false, // log PID, worker_id (slot 0..concurrency-1), job_id (e.g. [remq] PID 12345 worker_id 2 job_id on-request-1)
  processor: {
    // Throughput tip: higher pollIntervalMs lets the stream fill; short blockMs returns quickly with a batch.
    // Then high concurrency (e.g. 10) drains the batch in parallel — often faster than aggressive polling.
    read: {
      blockMs: 1000, // short block = get what's there fast; lower (e.g. 10) for throughput + fill-between-polls (default 1000)
      count: 200, // max messages per batch (default 200)
    },
    pollIntervalMs: 1000, // let work accumulate between reads; then read + process with concurrency (default 3000)
    maxLogsPerJob: 100, // trim oldest logs; keeps Redis self-cleaning
    // stream trimmed after ACK (MINID); streamMaxLen accepted but unused
    jobStateTtlSeconds: 604800, // 7 days; job state keys expire. Admin/SDK queries must handle missing keys (SCAN/GET)
    // readCount: 50, // optional: lower if message payloads are large (default 200)
  },
});

const admin = new RemqAdmin(db, remq);

export { admin, remq };
