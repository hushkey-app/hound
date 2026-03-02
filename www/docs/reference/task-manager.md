---
title: Remq
description: Configure and use the Remq API.
---

# Remq

`Remq` is the high-level API for defining tasks and processing them
through Redis streams. It wraps the lower-level Consumer + Processor and exposes
simple handler registration and task emission.

## Minimal example

```typescript
import { Remq } from 'npm:@leotermine/tasker';

const remq = Remq.create({ db });

remq
  .on('send-welcome', async (ctx) => {
    console.log('Sending welcome email for', ctx.data?.userId);
  });

remq.emit('send-welcome', { userId: 'user_123' });
```

## Initialization

### `Remq.create(options)`

Create or retrieve the singleton Remq instance.

```typescript
const remq = Remq.create({
  db,
  streamdb,
  ctx: { logger },
  concurrency: 4,
  processor: {
    retry: { maxRetries: 3, retryDelayMs: 1000 },
    dlq: { enabled: true },
  },
});
```

**Options:** `TaskManagerOptions<T>`

- `db`: Redis connection for job storage.
- `streamdb`: Optional Redis connection for stream operations (defaults to `db`).
- `ctx`: Context object merged into handler context.
- `concurrency`: Number of concurrent jobs (defaults to `1`).
- `processor`: Processor options forwarded to the internal Processor. For production, set `streamMaxLen` (e.g. `10000`) so queue streams are trimmed after each batch and do not grow unbounded; optionally set `readCount` lower if message payloads are large.

## Handler registration

### `on(event, handler, options?)`

Register a handler for an event name and optional queue. Returns `this` for chaining. Event names support dot notation (e.g. `'host.sync'`, `'user.welcome'`).

```typescript
remq
  .on('send-email', async (ctx) => {
    await ctx.emit('track-email', { id: ctx.data?.id });
  }, {
    queue: 'emails',
    repeat: { pattern: '0 0 * * *' },
    attempts: 3,
    debounce: 60000,
  });
```

**HandlerOptions:** `queue?`, `repeat?`, `attempts?`, `debounce?`

- Handlers receive a single `ctx: TaskContext<TApp, TData>` (job identity, data, logger, emit, socket, plus app context).

## Emitting tasks

### `emit(event, data?, options?)`

Trigger a task on a queue. Returns the task id.

```typescript
remq.emit('send-email', { id: '123' }, {
  queue: 'emails',
  delay: new Date(Date.now() + 60_000),
  retryCount: 2,
});
```

**EmitOptions:** `queue?` (default `'default'`), `id?`, `priority?`, `delay?` (Date), `retryCount?`, `retryDelayMs?`, `repeat?`, `attempts?`.

### `emit` via context

Handlers receive a context object that includes your custom `ctx` plus an
`emit` function. Use it to enqueue follow-up tasks while processing.

```typescript
remq.on('resize-image', async (ctx) => {
  await ctx.emit('notify-user', { userId: ctx.data?.userId });
});
```

## Lifecycle

### `start()`

Starts processing jobs for all registered handlers. This call is idempotent.

```typescript
await remq.start();
```

### `stop()`

Stops processing and waits for active tasks to finish (via `drain()`).

```typescript
await remq.stop();
```

**Lifecycle notes:**

- Call `on()` before `start()` so queues are wired up.
- To add new handlers at runtime, stop the instance, register handlers, and
  start again.

## Queue controls

- **Remq:** `drain()` — Wait for all active tasks to finish.
- **RemqAdmin:** Use `new RemqAdmin(db, remq)` then `admin.pause(queue?)`, `admin.resume(queue?)`, `admin.isPaused(queue)` for queue pause/resume and state.

## Next Steps

- [Consumer API](/reference/consumer)
- [Processor API](/reference/processor)
- [RemqAdmin API](/reference/sdk)
