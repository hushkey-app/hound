# Remq Example Usage

## Simple Setup (similar to original plugin.ts)

```typescript
import { Remq } from './mod.ts';
import { Redis } from 'ioredis';

// Create Redis connection
const db = new Redis({
  port: 6379,
  host: 'localhost',
  db: 1,
});

// Define context for your app
const contextApp = {};

// Initialize Remq (simple API)
const taskManager = Remq.create({
  db,
  ctx: contextApp,
  concurrency: 4,
  processor: {
    retry: {
      maxRetries: 3,
      retryDelayMs: 1000,
    },
    debounce: 300, // Optional: 5 minutes debounce
  },
});

// Register handler (sync, fluent)
taskManager.on('my-event', async (ctx) => {
  console.log('Processing:', ctx.name, ctx.data);
  await ctx.logger('Job started');

  // Your business logic here
  // ...

  // Emit child jobs if needed
  ctx.emit('child-job', { parentId: ctx.data.id });

  await ctx.logger('Job completed');
});

// Start processing
await taskManager.start();

export { taskManager };
```

## With Cron Jobs

```typescript
// Register a cron job (runs every 5 minutes)
taskManager.on('periodic-task', async (ctx) => {
  console.log('Cron job running:', new Date());
}, { queue: 'scheduler', repeat: { pattern: '*/5 * * * *' } });
```

## Emit Jobs (Execution)

```typescript
// Emit a simple job (queue defaults to 'default')
taskManager.emit('process-user', { userId: '123' });

// Emit with options
taskManager.emit('send-email', { to: 'user@example.com', subject: 'Hello' }, {
  queue: 'emails',
  retryCount: 3,
  delay: new Date(Date.now() + 60000), // Delay 1 minute
});
```

## Complete Example

```typescript
import { Remq } from '@core/mod.ts';
import { Redis } from 'ioredis';

const db = new Redis({ port: 6379, host: 'localhost', db: 1 });

const taskManager = Remq.create({
  db,
  ctx: {},
  concurrency: 4,
});

// Register handler (fluent)
taskManager.on('main-job', async (ctx) => {
  console.log(`Processing ${ctx.name} with data:`, ctx.data);
  await ctx.logger('Started processing');

  // Do work
  // ...

  ctx.emit('follow-up', { originalJob: ctx.name });
}, { queue: 'default' });

// Start
await taskManager.start();

// Emit jobs
taskManager.emit('main-job', { taskId: '123' });
```
