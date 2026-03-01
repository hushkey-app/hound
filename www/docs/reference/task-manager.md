---
title: TaskManager
description: Configure and use the TaskManager API.
---

# TaskManager

The `TaskManager` is the high-level API for defining jobs and processing them
through Redis streams. It wraps the lower-level Consumer + Processor and exposes
simple handler registration and job emission.

## Minimal example

```typescript
const taskManager = TaskManager.init({ db });

await taskManager.registerHandler({
  event: 'send-welcome',
  handler: async (job) => {
    console.log('Sending welcome email for', job.data?.userId);
  },
});

await taskManager.emit({
  event: 'send-welcome',
  data: { userId: 'user_123' },
});
```

## Initialization

### `TaskManager.init(options)`

Create or retrieve the singleton TaskManager instance.

```typescript
const taskManager = TaskManager.init({
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

### `registerHandler(options)`

Register a handler for an event name and optional queue.

```typescript
await taskManager.registerHandler({
  event: 'send-email',
  queue: 'emails',
  handler: async (job, ctx) => {
    await ctx.emit({
      event: 'track-email',
      data: { id: job.data?.id },
    });
  },
  options: {
    repeat: { pattern: '0 0 * * *' },
    attempts: 3,
    debounce: 60000,
  },
});
```

**Options:** `RegisterHandlerOptions<T, D>`

- `handler`: Function invoked for matching jobs.
- `event`: Event/job name.
- `queue`: Queue name (defaults to `default`).
- `options.repeat.pattern`: Cron expression for repeatable jobs.
- `options.attempts`: Maximum retry attempts for the job.
- `options.debounce`: Debounce window in milliseconds for this handler.

## Emitting jobs

### `emit(args)`

Trigger a job on a queue.

```typescript
taskManager.emit({
  event: 'send-email',
  queue: 'emails',
  data: { id: '123' },
  options: {
    delayUntil: new Date(Date.now() + 60_000),
    retryCount: 2,
  },
});
```

**Args:**

- `event`: Event/job name (required).
- `queue`: Queue name (defaults to `default`).
- `data`: Job payload (defaults to `{}`).
- `options`: Job options and metadata.
  - `id`: Custom job id (defaults to a hash of `event` + `data`).
  - `priority`: Higher numbers are processed first (default `0`).
  - `delayUntil`: Date when the job becomes eligible (e.g. `new Date(Date.now() + 60_000)`).
  - `retryCount`: Initial retry budget for the job.
  - `retryDelayMs`: Delay between retries in milliseconds (default `1000`).
  - `repeat`: Repeat configuration for cron-like jobs (`{ pattern: "0 * * * *" }`).
  - `attempts`: Shorthand for `retryCount` when emitting.
  - `debounce`: Debounce window in milliseconds for this job id.

### `emit` via context

Handlers receive a context object that includes your custom `ctx` plus an
`emit` function. Use it to enqueue follow-up jobs while processing.

```typescript
taskManager.registerHandler({
  event: 'resize-image',
  handler: async (job, ctx) => {
    await ctx.emit({
      event: 'notify-user',
      data: { userId: job.data?.userId },
    });
  },
});
```

## Lifecycle

### `start()`

Starts processing jobs for all registered handlers. This call is idempotent.

```typescript
await taskManager.start();
```

### `stop()`

Stops processing and waits for active tasks to finish.

```typescript
await taskManager.stop();
```

**Lifecycle notes:**

- Call `registerHandler()` before `start()` so queues are wired up.
- To add new handlers at runtime, stop the manager, register handlers, and
  start again.

## Queue controls

## Next Steps

- [Consumer API](/reference/consumer)
- [Processor API](/reference/processor)
- [Sdk API](/reference/sdk)
