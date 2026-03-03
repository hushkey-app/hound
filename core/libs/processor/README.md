# Processor Module

Policy layer that wraps Consumer to add retries, delays, DLQ routing, and debouncing.

## Features

### 1. Retries

- Configurable max retries
- Exponential backoff support
- Custom retry logic (shouldRetry function)
- Configurable retry delays

### 2. Delays

- Automatically re-queues messages with `delayUntil` in the future
- Respects `delayUntil` timestamp from message data

### 3. DLQ (Dead Letter Queue)

- Routes failed messages to DLQ after retries exhausted
- Configurable DLQ stream key
- Custom DLQ routing logic
  - `streamKey` is required to enable DLQ
  - `shouldSendToDLQ` defaults to sending on the final failure (when retries are exhausted)

### 4. Debouncing (Optional) ⭐

- **Optional feature** - prevents duplicate message processing within a time window
- Configurable debounce window (in seconds) - set any value you need
- Custom key function for debounce tracking
- Automatic cleanup of old entries
- If not configured, debouncing is disabled

## Usage

### Basic Usage

```typescript
import { Processor } from './mod.ts';
import type { ProcessorOptions } from '../../types/processor.ts';

const processor = new Processor({
  consumer: {
    streams: ['my-queue-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      // Your handler logic
      console.log('Processing:', message.data);
      await ctx.ack();
    },
    concurrency: 5,
  },
  streamdb: redisClient,
});

await processor.start();
```

### Minimal Full Example (Consumer + Retry + DLQ + Debounce)

```typescript
const processor = new Processor({
  consumer: {
    streams: ['orders-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      await handleOrder(message.data);
      await ctx.ack();
    },
    concurrency: 10,
  },
  streamdb: redisClient,
  retry: {
    maxRetries: 5,
    retryDelayMs: 2000,
  },
  dlq: {
    streamKey: 'orders-dlq',
  },
  debounce: {
    debounce: 300,
    keyFn: (message) => {
      const data = message.data as { orderId?: string };
      return data.orderId ?? message.id;
    },
  },
});

await processor.start();
```

### With Optional Debouncing (Simple API)

```typescript
const processor = new Processor({
  consumer: {
    streams: ['my-queue-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      // This will only execute once per unique message within the debounce window
      console.log('Processing:', message.data);
      await ctx.ack();
    },
    concurrency: 5,
  },
  streamdb: redisClient,
  debounce: 300, // Optional: debounce window in seconds (e.g., 300 = 5 minutes)
  // If debounce is not provided, debouncing is disabled
});
```

**Note:** Debouncing is completely optional. If you don't provide `debounce`, messages will be processed normally without any debouncing.

### With Custom Debounce Key (Advanced API)

```typescript
const processor = new Processor({
  consumer: {
    streams: ['my-queue-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      // Process message
      await ctx.ack();
    },
  },
  streamdb: redisClient,
  debounce: {
    debounce: 300, // Debounce window in seconds (configure any value you need)
    // Custom key function - debounce by user ID instead of message ID
    keyFn: (message) => {
      const data = message.data as { userId?: string };
      return data.userId || message.id;
    },
  },
});
```

**Note:** You can use the simple API (`debounce: 300`) or the advanced API (`debounce: { debounce: 300, keyFn: ... }`) if you need custom key functions.

### With Retries

```typescript
const processor = new Processor({
  consumer: {
    streams: ['my-queue-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      // If this throws, it will be retried up to 3 times
      await processMessage(message.data);
      await ctx.ack();
    },
  },
  streamdb: redisClient,
  retry: {
    maxRetries: 3,
    retryDelayMs: 1000, // 1 second base delay
    backoffMultiplier: 2, // Exponential backoff: 1s, 2s, 4s
    shouldRetry: (error, attempt) => {
      // Don't retry on 404 errors
      if (error.message.includes('404')) {
        return false;
      }
      return true;
    },
  },
});
```

### With DLQ

```typescript
const processor = new Processor({
  consumer: {
    streams: ['my-queue-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      await processMessage(message.data);
      await ctx.ack();
    },
  },
  streamdb: redisClient,
  retry: {
    maxRetries: 3,
    retryDelayMs: 1000,
  },
  dlq: {
    streamKey: 'my-queue-dlq', // Required to enable DLQ
    shouldSendToDLQ: (message, error, attempts) => {
      // Only send to DLQ if we've tried at least 3 times
      return attempts >= 3;
    },
  },
});
```

**Defaults:**

- If `dlq.streamKey` is not set, DLQ routing is disabled.
- If `dlq.shouldSendToDLQ` is not set, the processor sends to DLQ when retries are exhausted.

### Complete Example (All Features)

```typescript
const processor = new Processor({
  consumer: {
    streams: ['my-queue-stream'],
    streamdb: redisClient,
    handler: async (message, ctx) => {
      const data = message.data as { userId: string; action: string };

      // Process the message
      await performAction(data.userId, data.action);

      await ctx.ack();
    },
    concurrency: 10,
    group: 'processor',
  },
  streamdb: redisClient,

  // Retry configuration
  retry: {
    maxRetries: 3,
    retryDelayMs: 1000,
    backoffMultiplier: 2, // 1s, 2s, 4s
  },

  // DLQ configuration
  dlq: {
    streamKey: 'my-queue-dlq',
  },

  // Optional debounce configuration (simple API)
  debounce: 300, // Debounce window in seconds (configure any value you need)

  // Or use advanced API for custom key function:
  // debounce: {
  //   debounce: 300,
  //   keyFn: (message) => {
  //     const data = message.data as { userId?: string };
  //     return `user:${data.userId || message.id}`;
  //   },
  // },

  // Don't retry configuration errors
  ignoreConfigErrors: true,
});

// Start processing
await processor.start({ signal: abortSignal });

// Stop processing
processor.stop();
await processor.waitForActiveJobs();
```

## Message Data Structure

Processor expects messages with this structure:

```typescript
interface ProcessableMessage {
  id: string;
  streamKey: string;
  data: {
    id?: string;
    state?: {
      name?: string;
      queue?: string;
      data?: unknown;
    };
    delayUntil?: number; // Timestamp in milliseconds
    retryCount?: number;
    retryDelayMs?: number;
    retriedAttempts?: number;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
}
```

## Processing Flow

1. **Debounce Check**: If debounce is enabled, check if message was recently processed
   - If debounced: ACK and skip
   - If not debounced: Continue

2. **Delay Check**: Check if `delayUntil` is in the future
   - If delayed: Re-queue message with same `delayUntil`, ACK original
   - If ready: Continue

3. **Handler Execution**: Execute user's handler
   - On success: Mark as processed (debounce), ACK
   - On failure: Go to retry/DLQ logic

4. **Retry/DLQ Logic**: On handler failure
   - Check if should retry (maxRetries, shouldRetry function)
   - If should retry: Re-queue with decremented retryCount and delay
   - If no more retries: Send to DLQ (if configured), ACK

## Configuration Errors

By default, configuration errors (e.g., "No handler found") are not retried and not sent to DLQ. They are immediately ACKed. This prevents infinite retry loops for misconfigured handlers.

To disable this behavior, set `ignoreConfigErrors: false`.

## Debouncing Details (Optional)

- **Debouncing is optional** - only enabled if `debounce` is provided in options
- **Simple API**: `debounce: 300` (number in seconds)
- **Advanced API**: `debounce: { debounce: 300, keyFn: ... }` (for custom key functions)
- Debounce window is specified in **seconds** - configure any value you need (e.g., `60` = 1 minute, `300` = 5 minutes, `3600` = 1 hour)
- Default key function uses `message.id`
- Custom key functions allow debouncing by any field (e.g., user ID, email)
- Old entries are automatically cleaned up every 5 minutes
- Debounce state is in-memory (per-processor instance)
- If debounce is not provided, all messages are processed normally without debouncing

## Integration with Consumer

Processor wraps Consumer and delegates all runtime concerns to it:

- Consumer handles: fetching, concurrency, ACK timing, events
- Processor handles: retries, delays, DLQ, debouncing

You can access the underlying Consumer via `processor.getConsumer()` for advanced use cases.
