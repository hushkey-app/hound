---
title: Consumers
description: Process Redis stream messages with Consumer handlers and lifecycle events.
---

# Consumers

Use `Consumer` when you want direct control over how Redis stream messages are
read and processed. A consumer reads entries from one or more streams and runs
an async handler for each message.

## When to use a Consumer

Choose `Consumer` for low-level, stream-first workflows (custom backoffs,
alternative storage, or integrating with existing stream producers). If you
want managed jobs, retries, and scheduling, start with Remq and its
`Processor` instead.

## Create a Consumer

Build `ConsumerOptions` with a Redis connection, stream names, and a handler.

```typescript
import Redis from 'npm:ioredis';
import { Consumer } from 'npm:@leotermine/tasker';

const streamdb = new Redis({ host: '127.0.0.1', port: 6379 });

const consumer = new Consumer({
  streamdb,
  streams: ['default-stream'],
  concurrency: 4,
  group: 'payments',
  handler: async (message) => {
    console.log('message', message.id, message.data);
    await processMessage(message.data);
  },
});
```

## Start and Stop

`start()` begins the processing loop. `stop()` prevents new reads while letting
in-flight handlers finish.

```typescript
const controller = new AbortController();
const run = consumer.start({ signal: controller.signal });

// Later...
consumer.stop();
await run;
```

## Message Handling

The handler receives a `Message` and `MessageContext`. `Message` includes the
Redis stream entry (`id`, `streamKey`, `data`, `metadata`). The context provides
`ack()` and `nack()` helpers, but in the current consumer implementation messages
are ACKed immediately after read, so `ack()`/`nack()` are no-ops.

```typescript
const consumer = new Consumer({
  streamdb,
  streams: ['default-stream'],
  handler: async (message, ctx) => {
    console.log('payload', message.data);
    await ctx.ack();
  },
});
```

## Lifecycle Events and Errors

Consumers are `EventTarget`s. Subscribe to lifecycle events to track progress
and capture failures.

```typescript
consumer.addEventListener('started', (event) => {
  console.log('started', event.detail.message.id);
});

consumer.addEventListener('succeeded', (event) => {
  console.log('succeeded', event.detail.message.id, event.detail.duration);
});

consumer.addEventListener('failed', (event) => {
  console.error('failed', event.detail.message.id, event.detail.error);
});

consumer.addEventListener('error', (event) => {
  console.error('consumer error', event.detail.error);
});
```

## Tuning Throughput

A few options help tailor throughput and ownership:

- `concurrency`: how many messages process in parallel.
- `group`: the Redis consumer group name (defaults to `processor`).
- `consumerId`: stable consumer identity when scaling across hosts.
- `read`: `blockMs`/`count` settings for stream reads.
- `claim`: `minIdleMs`/`count` for pending message claims.
- `pollIntervalMs`: idle delay between polling cycles.

For full options and types, see the
[Consumer API Reference](/reference/consumer).

## Next Steps

- Check the [Consumer API Reference](/reference/consumer)
- Learn about [Processors](/reference/processor)
- Compare with [Task Management](/guide/task-management)
