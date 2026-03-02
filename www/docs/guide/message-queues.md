---
title: Message Queues
description: Understand queues, streams, and message flow in REMQ.
---

# Message Queues

REMQ builds its message queues on top of Redis Streams so producers and consumers
can work independently. A job is emitted into a queue (stream), stored with
metadata, and then processed asynchronously by consumers or processors.

## Core building blocks

- **Producer**: emits jobs via `Remq.emit()` or `ctx.emit()`.
- **Queue**: a named channel that groups jobs (default: `default`).
- **Stream**: Redis Streams are the underlying transport for each queue.
- **Consumer**: reads stream entries and invokes a handler.
- **Processor**: wraps a Consumer with policies like retry, delay, debounce, and
  DLQ routing.

## Message flow

1. **Emit**: `Remq.emit()` writes a job to a queue with payload + options.
2. **Store**: job metadata (priority, delay, retry budget) is persisted in Redis.
3. **Consume**: Consumers read from the queue stream and hand off to handlers.
4. **Handle**: Processor applies retries/delay/DLQ rules when handlers fail.
5. **Track**: Admin APIs expose queue stats and job state (`waiting`,
   `processing`, `completed`, `failed`, `delayed`).

## Queue routing and options

Queues are selected by name (`queue: 'emails'`). Job options become metadata that
controls how the Processor handles delivery:

- `priority`: higher numbers are processed first.
- `delayUntil`: schedule processing in the future.
- `retryCount` / `retryDelayMs`: control retry budget and timing.
- `repeat`: schedule recurring jobs.
- `debounce`: deduplicate jobs within a time window.

For full options and types, see the
[Remq API Reference](/reference/task-manager) and
[Processor API Reference](/reference/processor).

## Example: emit and process a queued job

```typescript
import { Remq } from '@leotermine/tasker';

const remq = Remq.create({ db });

await taskManager.registerHandler({
  event: 'send-email',
  queue: 'emails',
  handler: async (job) => {
    console.log('Sending email for', job.data?.id);
  },
});

await taskManager.emit({
  event: 'send-email',
  queue: 'emails',
  data: { id: 'user_123' },
  options: {
    priority: 2,
    delayUntil: new Date(Date.now() + 60_000),
    retryCount: 3,
  },
});
```

## When to use each API

- Use Remq for most app workflows (handlers, retries, and queue
  management).
- Use `Consumer` directly when you need raw stream access without policy logic.
- Use `Processor` when you want retries, DLQ routing, or debouncing with a
  consumer-style handler.

## Next Steps

- Learn about [Consumers](/guide/consumers)
- Explore [Remq](/reference/task-manager)
- Review [Processor](/reference/processor)
