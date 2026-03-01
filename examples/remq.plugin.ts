import { TaskManager } from '@core/libs/task-manager/mod.ts';
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

// initialize the task manager (using new core API)
const remq = TaskManager.init({
  db,
  streamdb, // Optional: separate connection for streams
  ctx: contextApp,
  expose: 4000, // WebSocket port; clients can send header x-get-broadcast: true to receive all task updates
  concurrency: 2, // the number of messages to process concurrently uses workers steal process strategy
  processor: { // [default] processor options
    debounce: 1 * 60, // 100 minutes
    dlq: {
      streamKey: 'remq-dlq', // the stream key to send the failed messages to
      shouldSendToDLQ: (message, error, attempts) => {
        return attempts >= 3; // send to dlq if the message has been retried 3 times
      },
    },
    retry: {
      // maxRetries: 5,
      // retryDelayMs: 3000,
      // shouldRetry: (error, attempt) => true,
    },
    maxLogsPerTask: 100, // trim oldest logs; keeps Redis self-cleaning
    streamMaxLen: 1000, // trim stream after each read+ACK to prevent unbounded growth and process memory blowup
    // readCount: 50, // optional: lower if message payloads are large (default 200)
  },
});

export { remq };
