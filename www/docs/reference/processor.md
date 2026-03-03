---
title: Processor
description: Processor policies, options, and methods.
---

# Processor

The `Processor` class wraps a `Consumer` with policy logic for retries, DLQ routing,
and debouncing. Use it when you want the Consumer runtime plus message handling
policies in one place.

## Constructor

```typescript
new Processor(options: ProcessorOptions)
```

### ProcessorOptions

`ProcessorOptions` combines Consumer configuration with policy controls.

Required:

- `consumer: ConsumerOptions` - Consumer config including `streams`, `streamdb`, and `handler`.
- `streamdb: RedisConnection` - Redis connection used to re-queue retries and write to the DLQ.

Optional:

- `retry?: RetryConfig` - Retry policy (`maxRetries`, `retryDelayMs`, `shouldRetry`).
- `dlq?: DLQConfig` - Dead Letter Queue policy (`streamKey`, `shouldSendToDLQ`).
- `debounce?: number | DebounceConfig` - Debounce window in milliseconds; number is shorthand for `{ debounce }`.
- `ignoreConfigErrors?: boolean` - Stored on the Processor instance. Default `true`.
- `streamMaxLen?: number` - Cap stream at add time (XADD MAXLEN ~) and after each read+ACK (XTRIM MAXLEN ~). Prevents unbounded stream growth and process memory blowup. Recommended in production (e.g. `10000`).
- `readCount?: number` - Max messages per XREADGROUP batch (default `200`). Lower for large payloads to avoid process memory spikes.
- `jobStateTtlSeconds?: number` - TTL in seconds for all job state keys (waiting, delayed, processing, completed, failed). Keys expire after this many seconds to prevent unbounded Redis key growth (e.g. `604800` for 7 days).

#### RetryConfig

Retry configuration applied after handler failures.

- `maxRetries`: Maximum number of retries. Default `0` (no retries).
- `retryDelayMs`: Base delay between retries in milliseconds. Default `1000`.
- `backoffMultiplier`: Multiplier for exponential backoff. Default `1` (no backoff). Note: the Processor currently uses a constant delay and does not apply this multiplier.
- `shouldRetry`: Optional predicate to decide whether to retry a given error. `attempt` is 1-based. Default behavior retries any error while retry budget remains.

#### DebounceConfig

Debounce configuration for deduplicating messages within a window. The numeric shorthand
`debounce: 30000` is equivalent to `debounce: { debounce: 30000 }`.

- `debounce`: Debounce window in milliseconds. Omit or set to `undefined` to disable debouncing.
- `keyFn`: Function to generate a debounce key from the message. If omitted, the Processor uses `message.id`.

#### How options are applied

- `consumer` is used to construct the wrapped `Consumer`. The `handler` is wrapped to apply debounce, delay, retry, and DLQ policies. All other consumer options pass through unchanged.
- `streamdb` is stored on the Processor and used by `requeueMessage()` and `sendToDLQ()` to write back to Redis streams. It can be the same connection as `consumer.streamdb`.
- `retry` controls retry behavior after handler failures. A retry happens only when `retry.maxRetries > 0` and the message data includes `retryCount > 0`. The delay uses `message.data.retryDelayMs` when present, otherwise `retry.retryDelayMs` (default `1000`). If provided, `retry.shouldRetry` gates retries.
- `dlq` controls dead-letter routing. If `dlq.streamKey` is set, failed messages (after retries are exhausted or skipped) are written to that stream. `DLQConfig.shouldSendToDLQ` is currently not invoked by Processor.
- `debounce` enables a `DebounceManager`. The provided window value is converted to seconds (`Math.ceil(value / 1000)`), and `keyFn` is passed through (defaulting to `message.id`). Debounced messages are ACKed and skipped.
- `ignoreConfigErrors` is stored but not currently used by the Processor's retry/DLQ logic. If you want to skip retries for specific errors, implement that in `retry.shouldRetry`.

## ProcessableMessage

Processor handlers receive a `ProcessableMessage`. It always includes an `id`, a `streamKey`, and a `data` object that may contain delay/retry metadata used by the Processor.

```typescript
interface ProcessableMessage {
  id: string;
  streamKey: string;
  data: {
    delayUntil?: number;
    retryCount?: number;
    retryDelayMs?: number;
    retriedAttempts?: number;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
}
```

## Methods

### start

Starts consuming messages through the wrapped Consumer.

```typescript
start(options?: { signal?: AbortSignal }): Promise<void>
```

### stop

Stops the wrapped Consumer from reading new messages.

```typescript
stop(): void
```

### waitForActiveTasks

Waits for all in-flight handler tasks to finish.

```typescript
waitForActiveTasks(): Promise<void>
```

### cleanup

Cleans up internal debounce state, if configured.

```typescript
cleanup(): void
```

## Minimal example

```typescript
const processor = new Processor({
  streamdb,
  consumer: {
    streamdb,
    streams: ['default-stream'],
    handler: async (message) => {
      await processMessage(message);
    },
  },
  retry: {
    maxRetries: 3,
    retryDelayMs: 2000,
  },
  dlq: {
    streamKey: 'dlq-stream',
  },
  debounce: 30,
});

const run = processor.start();

// Later...
processor.stop();
await run;
```

## Next Steps

- [Consumer API](/reference/consumer)
- [Remq API](/reference/task-manager)
- [RemqAdmin API](/reference/sdk)
