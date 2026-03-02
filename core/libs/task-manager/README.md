# Remq

High-level API for task/job management. Simple, developer-friendly interface built on top of Consumer + Processor.

## Features

- **Simple API** - Easy to use, similar to the original ProcessingManager
- **on()** - Register handlers for events/jobs (sync, fluent; event names support dot notation e.g. 'host.sync', 'user.welcome')
- **emit()** - Trigger jobs/events
- **Built on Consumer + Processor** - Gets all the benefits (retries, DLQ, debouncing)
- **Automatic queue management** - Queues are created automatically
- **Context support** - Pass context to handlers with emit function

## Usage

### Basic Setup

```typescript
import { Remq } from './mod.ts';
import { Redis } from 'ioredis';

const db = new Redis({
  port: 6379,
  host: 'localhost',
  db: 1,
});

// Initialize Remq
const taskManager = Remq.create({
  db,
  ctx: {}, // Your app context
  concurrency: 4,
  processor: {
    retry: {
      maxRetries: 3,
      retryDelayMs: 1000,
    },
    debounce: 300, // Optional: 5 minutes debounce
  },
});

// Register handlers (fluent: .on().on()...)
taskManager
  .on('my-event', async (ctx) => {
    console.log('Processing:', ctx.name, ctx.data);
    await ctx.logger('Job started');

    // Do work...

    // Emit child jobs if needed
    ctx.emit('child-job', { parentId: ctx.data.id });

    await ctx.logger('Job completed');
  });

// Start processing
await taskManager.start();
```

### With Cron/Repeatable Jobs

```typescript
taskManager.on('daily-report', async (ctx) => {
  console.log('Cron job running:', new Date());
}, { queue: 'scheduler', repeat: { pattern: '0 0 * * *' } }); // Every day at midnight
```

### Emit Jobs

```typescript
// Emit a simple job (queue defaults to 'default')
taskManager.emit('process-user', { userId: '123' });

// Emit with options
taskManager.emit('send-email', { to: 'user@example.com' }, {
  queue: 'emails',
  retryCount: 3,
  delay: new Date(Date.now() + 60000), // Delay 1 minute
});
```

### Using Context

```typescript
interface AppContext {
  db: Database;
  cache: Cache;
  config: Config;
}

const taskManager = Remq.create<AppContext>({
  db: redisClient,
  ctx: {
    db: myDatabase,
    cache: myCache,
    config: myConfig,
  },
  concurrency: 4,
});

taskManager.on('process-user', async (ctx) => {
  // ctx = TaskContext<AppContext> — job identity + data + app context
  const user = await ctx.db.getUser(ctx.data.userId);
  await ctx.cache.set(`user:${user.id}`, user);

  ctx.emit('notify-user', { userId: user.id });
});
```

## API

### `Remq.create(options)`

Create or retrieve the singleton Remq instance.

**Options:**
- `db: RedisConnection` - Redis connection for job storage
- `ctx?: T` - Context object passed to handlers
- `concurrency?: number` - Number of concurrent jobs (default: 1)
- `streamdb?: RedisConnection` - Optional separate Redis connection for streams
- `processor?: { retry?, dlq?, debounce?, ignoreConfigErrors? }` - Processor options

### `on(event, handler, options?)`

Register a handler for an event/task. Sync, returns `this` for chaining. Event names support dot notation (e.g. `'host.sync'`, `'user.welcome'`).

**Parameters:**
- `event: string` - Event/task name
- `handler: TaskHandler<TApp, D>` - Handler function receiving single `ctx: TaskContext<TApp, D>`
- `options?: HandlerOptions` - `{ queue?, repeat?, attempts?, debounce? }`

**Handler signature:**
```typescript
(ctx: TaskContext<TApp, TData>) => Promise<void> | void
```

`TaskContext` includes: `id`, `name`, `queue`, `status`, `retryCount`, `retriedAttempts`, `data`, `logger`, `emit`, `socket`, plus app context (TApp) merged onto `ctx`.

### `emit(event, data?, options?)`

Emit/trigger a task/event. Returns job id.

**Parameters:**
- `event: string` - Event name
- `data?: unknown` - Payload (default `{}`)
- `options?: EmitOptions` - `queue` (default `'default'`), `id?`, `priority?`, `delay?`, `retryCount?`, `retryDelayMs?`, `repeat?`, `attempts?`
- `data?: unknown` - Job data (defaults to `{}`)
- `options?: { ... }` - Job options:
  - `id?: string` - Custom job id (defaults to hash of event + data)
  - `priority?: number` - Higher values process first (default: `0`)
  - `delayUntil?: Date` - When the job becomes eligible
  - `retryCount?: number` - Initial retry budget
  - `retryDelayMs?: number` - Delay between retries (default: `1000`)
  - `repeat?: { pattern: string }` - Cron pattern (e.g. `"0 * * * *"`)
  - `attempts?: number` - Shorthand for `retryCount`
  - `debounce?: number` - Debounce window in milliseconds

### `start()`

Start processing jobs. Creates consumer groups and starts processors.

### `stop()`

Stop processing jobs. Waits for active tasks to complete (via `drain()`).

### `drain()`

Wait for all active tasks to finish. Use before shutdown or when reconfiguring.

### `pause(queue?)` / `resume(queue?)`

Pause or resume queue(s). With no argument, pauses or resumes all registered queues; with a queue name, only that queue.

### `isPaused(queue)`

Returns whether the given queue is paused.

### `getContext()`

Get the context object (useful for accessing emit function outside handlers).

## Types

### `TaskHandler<T, D>`

Handler function invoked for each job.

**TaskContext fields:** `id`, `name`, `queue`, `status`, `retryCount`, `retriedAttempts`, `data`, `logger`, `emit`, `socket`, plus app context (TApp) merged onto `ctx`.

**Where used:**
- Passed to `on(event, handler, options?)` and stored per `queue:event`
- Invoked inside Remq when processing messages in `processJob()`

### `EmitFunction` / `EmitOptions`

`ctx.emit(event, data?, options?)` and `Remq.emit(event, data?, options?)` — both return job id.

**EmitOptions:** `queue?` (default `'default'`), `id?`, `priority?`, `delay?` (Date), `retryCount?`, `retryDelayMs?`, `repeat?`, `attempts?`. `delay` replaces the previous `delayUntil`; internally mapped to run-at time.

**Where used:**
- Exposed as `Remq.emit()` and injected onto handler context as `ctx.emit`
- Cron bootstrap in `on()` uses fire-and-forget `emit(event, {}, { queue, repeat, attempts })`

### `HandlerOptions`

Options for `on(event, handler, options?)`: `queue?`, `repeat?`, `attempts?`, `debounce?`.

### `TaskManagerOptions<TApp>`

Options for `Remq.create()`.

**Parameters:**
- `db: RedisConnection` - Redis connection for job storage (required)
- `expose?: number` - Port to expose a task-manager API (default: `4000`)
- `ctx?: T` - Context object passed to handlers
- `concurrency?: number` - Number of concurrent jobs (default: `1`)
- `streamdb?: RedisConnection` - Optional Redis connection for streams (defaults to `db`)
- `processor?: { retry?, dlq?, debounce?, ignoreConfigErrors? }` - Processor policy options

**Defaults (applied in constructor):**
- `concurrency` defaults to `1`
- `streamdb` defaults to `db`
- `processor` defaults to `{}` when omitted
- `ctx` defaults to `{}` and is augmented with `emit`

**Where used:**
- Stored in Remq constructor
- `concurrency` passed into `Processor` consumer options
- `streamdb` used by `emit()` and `ensureConsumerGroup()`
- `processor` spread into `new Processor(...)` in `createUnifiedProcessor()`
- `expose` is currently reserved (not read by Remq)

## Integration with Consumer + Processor

Remq uses Consumer + Processor internally, so you get all their features:

- ✅ Stable consumer IDs
- ✅ Correct ACK timing
- ✅ Retries with exponential backoff
- ✅ DLQ routing
- ✅ Debouncing
- ✅ Delay handling
- ✅ Multi-queue support

## Architecture

```
Remq (High-level API)
  ↓
Processor (Policy layer: retries, delays, DLQ, debounce)
  ↓
Consumer (Runtime engine: fetch, process, ack, events)
  ↓
Redis Streams
```
