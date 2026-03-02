---
title: Consumer
description: Configure Consumer options and lifecycle APIs.
---

# Consumer

The `Consumer` class reads Redis streams and runs a handler for each message. It is an
`EventTarget`, so you subscribe to lifecycle events with `addEventListener`.

## Constructor

```typescript
new Consumer(options: ConsumerOptions)
```

### ConsumerOptions

`ConsumerOptions` controls how the consumer reads streams and invokes the handler.

Required:

- `streams: string[]` - Stream keys to consume (for example `"default-stream"`).
- `streamdb: RedisConnection` - Redis connection used to read stream entries.
- `handler: MessageHandler` - Async function invoked for each message.

Optional:

- `concurrency?: number` - Max number of messages processed in parallel. Default `1`.
- `group?: string` - Consumer group name. Default `"processor"`.
- `consumerId?: string` - Stable consumer ID. Auto-generated from hostname/pid if omitted.
- `pollIntervalMs?: number` - Delay between polls when no messages are available. Default `3000`.
- `claim?: { minIdleMs?: number; count?: number }` - Pending-claim options.
  - `minIdleMs?: number` - Minimum idle time before claiming. Default `1000`.
  - `count?: number` - Max number of messages to claim at once. Default `100`.
- `read?: { blockMs?: number; count?: number }` - Read options.
  - `blockMs?: number` - Block time when no messages are available. Default `5000`.
  - `count?: number` - Max number of messages to read at once. Default `100`.

## MessageHandler signature

`MessageHandler` is the function type that `Consumer` calls for each message:

```typescript
type MessageHandler = (
  message: Message,
  ctx: MessageContext,
) => Promise<void>;
```

`Message` includes the Redis stream entry details (`id`, `streamKey`, `data`, `metadata`). The
`MessageContext` provides `ack()` and `nack(error)` helpers plus the original `message`. In the
current Consumer implementation, messages are ACKed after read, so `ack()`/`nack()` are no-ops.

## Handler flow

`handler` receives a `Message` and a `MessageContext` and is invoked as part of the Consumer
lifecycle:

- `started` event fires before the handler runs.
- `succeeded` fires after the handler resolves.
- `failed` (and `error`) fire if the handler throws.
- `stop()` prevents new messages from being read, but in-flight handlers continue to completion.

```typescript
const consumer = new Consumer({
  streamdb,
  streams: ["default-stream"],
  handler: async (message, ctx) => {
    // Process message payload
    console.log(message.data);

    // ack / nack are currently no-ops because messages are ACKed after read
    await ctx.ack();
  },
});
```

## Minimal example

Build `ConsumerOptions`, create a Consumer, then start/stop it:

```typescript
const options: ConsumerOptions = {
  streamdb,
  streams: ["default-stream"],
  handler: async (message) => {
    await processMessage(message);
  },
};

const consumer = new Consumer(options);
const run = consumer.start();

// Later...
consumer.stop();
await run;
```

## Events

The consumer emits lifecycle events via `CustomEvent`:

- `started`: before the handler runs for a message
- `succeeded`: after the handler completes
- `failed`: when the handler throws
- `error`: when an error is recorded

```typescript
consumer.addEventListener("started", (event) => {
  const { message } = event.detail;
  console.log("started", message.id);
});

consumer.addEventListener("succeeded", (event) => {
  const { message, duration } = event.detail;
  console.log("succeeded", message.id, duration);
});

consumer.addEventListener("failed", (event) => {
  const { message, error, duration } = event.detail;
  console.error("failed", message.id, error, duration);
});

consumer.addEventListener("error", (event) => {
  console.error("consumer error", event.detail.error);
});
```

## Methods

### start

Starts consuming messages. The returned promise resolves when the processing loop
exits (after `stop()` is called or the supplied `AbortSignal` is aborted).

```typescript
start(options?: { signal?: AbortSignal }): Promise<void>
```

### stop

Stops consuming messages.

```typescript
stop(): void
```

## Example

```typescript
const consumer = new Consumer({
  streamdb,
  streams: ["default-stream"],
  handler: async (message) => {
    await processMessage(message);
  },
});

consumer.addEventListener("succeeded", (event) => {
  console.log("processed", event.detail.message.id);
});

const controller = new AbortController();
const run = consumer.start({ signal: controller.signal });

// Later...
consumer.stop();
await run;
```

## Next Steps

- [Processor API](/reference/processor)
- [Remq API](/reference/task-manager)
- [Sdk API](/reference/sdk)
