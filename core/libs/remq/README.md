# Remq

High-level API for job management. Simple, developer-friendly interface built on top of Consumer + Processor.

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

// Initialize Remq (redis config auto-creates stream connection on db+1)
const taskManager = Remq.create({
  db,
  redis: { host: 'localhost', port: 6379, db: 1 },
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
  redis: { host: 'localhost', port: 6379, db: 1 }, // or pass streamdb for full control
  ctx: {
    db: myDatabase,
    cache: myCache,
    config: myConfig,
  },
  concurrency: 4,
});

taskManager.on('process-user', async (ctx) => {
  // ctx = JobContext<AppContext> — job identity + data + app context
  const user = await ctx.db.getUser(ctx.data.userId);
  await ctx.cache.set(`user:${user.id}`, user);

  ctx.emit('notify-user', { userId: user.id });
});
```

## API

### `Remq.create(options)`

Create the singleton Remq instance. **Throws** if called more than once; use `Remq.getInstance()` to get the existing instance. For tests, use `Remq._reset()` to clear the singleton before creating again.

**Options:**

- `db: RedisConnection` - Redis connection for job storage (required)
- `ctx?: T` - Context object passed to handlers
- `concurrency?: number` - Number of concurrent jobs (default: 1)
- `streamdb?: RedisConnection` - Optional dedicated Redis connection for streams. If omitted, Remq falls back to reusing `db` but this can let XREADGROUP BLOCK stall admin queries; prefer providing a dedicated `streamdb` or `redis` config so Remq can auto-create one on db+1.
- `redis?: RedisOptions` - Connection config to auto-create stream connection on db+1 (recommended when `streamdb` is not provided). Avoids XREADGROUP BLOCK stalling admin queries.
- `processor?: { retry?, dlq?, debounce?, ignoreConfigErrors? }` - Processor options

### `on(eventOrDefinition, handler?, options?)`

Register a handler for an event/job. Sync, returns `this` for chaining. Event names support dot notation (e.g. `'host.sync'`, `'user.welcome'`).

**Signatures:**

- `on(event, handler, options?)` — event name, handler function, optional options
- `on(definition)` — pass a `JobDefinition` from `defineJob()` (handler and options come from the definition)

**Parameters:**

- `eventOrDefinition: string | JobDefinition<TApp, D>` - Event/job name or a job definition from `defineJob()`
- `handler?: JobHandler<TApp, D>` - Handler function (required when first arg is string)
- `options?: HandlerOptions` - `{ queue?, repeat?, attempts?, debounce? }`

**Handler signature:**

```typescript
(ctx: JobContext<TApp, TData>) => Promise<void> | void
```

`JobContext` includes: `id`, `name`, `queue`, `status`, `retryCount`, `retriedAttempts`, `data`, `logger`, `emit`, `socket`, plus app context (TApp) merged onto `ctx`.

### `defineJob(event, handler, options?)`

Typed factory for job definitions. Zero runtime overhead. Use with `remq.on(jobDefinition)` for a clean file-per-job pattern and full `TData` inference in the handler.

```typescript
// jobs/user.welcome.ts
import { defineJob } from '@remq/core';

export default defineJob('user.welcome', async (ctx) => {
  await ctx.mailer.send(ctx.data.email);
}, { queue: 'emails', attempts: 3 });

// index.ts
import userWelcome from './jobs/user.welcome.ts';
remq.on(userWelcome).start();
```

With typed data:

```typescript
interface HostSyncData {
  hostId: string;
  region: 'jp' | 'au';
}
defineJob<AppCtx, HostSyncData>('host.sync', async (ctx) => {
  // ctx.data.hostId, ctx.data.region are typed
  await ctx.services.hosts.sync(ctx.data.hostId, ctx.data.region);
}, { queue: 'sync', repeat: { pattern: '0 * * * *' } });
```

### `emit(event, data?, options?)`

Emit/trigger a job/event. Returns job id. Fire-and-forget: Redis writes are not awaited.

### `emitAsync(event, data?, options?)`

Like `emit()` but returns `Promise<string>`. Use when you need to wait for Redis writes to complete before continuing (e.g. before shutting down or for tests).

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

**Queue control and job-finished:** Use `RemqAdmin` for `pause(queue?)`, `resume(queue?)`, `isPaused(queue)`, and `onJobFinished(cb)` — construct with `new RemqAdmin(db, remq)` to enable `onJobFinished`.

### `getContext()`

Get the context object (useful for accessing emit function outside handlers).

## Types

### `JobHandler<T, D>`

Handler function invoked for each job.

**JobContext fields:** `id`, `name`, `queue`, `status`, `retryCount`, `retriedAttempts`, `data`, `logger`, `emit`, `socket`, plus app context (TApp) merged onto `ctx`.

**Where used:**

- Passed to `on(event, handler, options?)` or inside a `JobDefinition` from `defineJob()`, stored per `queue:event`
- Invoked inside Remq when processing messages in `processJob()`

### `JobDefinition<TApp, TData>`

Object shape returned by `defineJob()`: `{ event, handler, options? }`. Pass to `remq.on(definition)`.

### `EmitFunction` / `EmitOptions`

`ctx.emit(event, data?, options?)` and `Remq.emit(event, data?, options?)` — both return job id.

**EmitOptions:** `queue?` (default `'default'`), `id?`, `priority?`, `delay?` (Date), `retryCount?`, `retryDelayMs?`, `repeat?`, `attempts?`. `delay` replaces the previous `delayUntil`; internally mapped to run-at time.

**Where used:**

- Exposed as `Remq.emit()` and `Remq.emitAsync()`; injected onto handler context as `ctx.emit`
- Cron bootstrap in `on()` stores pending cron jobs; on `start()` they are emitted only if no existing job state exists (dedup on restart). When a cron job completes, the next tick is scheduled only if the current instance wins a Redis lock (`queues:{queue}:cron-lock:{jobName}`), so multiple instances (e.g. after XGROUP SETID '0') do not each requeue the same cron and cause multiple runs per tick.

### `HandlerOptions`

Options for `on(event, handler, options?)`: `queue?`, `repeat?`, `attempts?`, `debounce?`.

### `TaskManagerOptions<TApp>`

Options for `Remq.create()`.

**Parameters:**

- `db: RedisConnection` - Redis connection for job storage (required)
- `expose?: number` - Port to expose a job-manager API (default: `4000`)
- `ctx?: T` - Context object passed to handlers
- `concurrency?: number` - Number of concurrent jobs (default: `1`)
- `streamdb?: RedisConnection` - Optional dedicated Redis connection for streams. If omitted, Remq falls back to reusing `db` but this can let XREADGROUP BLOCK stall admin queries; prefer providing a dedicated `streamdb` or `redis` config so Remq can auto-create one on db+1.
- `redis?: RedisOptions` - Connection config to auto-create stream connection on db+1 (recommended when `streamdb` is not provided). Prevents XREADGROUP BLOCK from stalling admin queries.
- `processor?: { retry?, dlq?, debounce?, ignoreConfigErrors? }` - Processor policy options

**Defaults (applied in constructor):**

- `concurrency` defaults to `1`
- If `streamdb` and `redis` are both omitted, Remq reuses `db` for stream operations (backwards compatible) and logs a warning, since XREADGROUP BLOCK can stall admin queries.
- When `redis` is used, stream connection is created on db index + 1. If that index is > 15, Remq logs a warning (Redis default is 16 DBs, 0–15)—increase `databases` in redis.conf or pass `streamdb` explicitly.
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
