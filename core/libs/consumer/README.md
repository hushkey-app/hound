# Consumer Module

A minimal, production-ready runtime engine for processing messages from Redis Streams.

## Architecture

The Consumer module is intentionally minimal and focused on core responsibilities:

### What Consumer Does ✅

1. **Fetches messages from Redis Streams**
   - Reads new messages via `XREADGROUP`
   - **Startup:** if the consumer group already exists, `XGROUP SETID … 0` resets the read position so messages emitted before `start()` (or left from a previous run) are not skipped.
   - Claims stuck pending messages via `XPENDING` + `XCLAIM` (idle > 30s); on startup, `recoverPending()` reclaims all PEL with min idle 0ms.
   - Supports multiple streams (multi-topic) with work-stealing

2. **Runs handlers with concurrency control**
   - Configurable concurrency limit
   - Tracks active tasks

3. **Acknowledges messages correctly**
   - **ACKs after successful processing** (not before!)
   - Handlers can ack early via context if needed
   - Ensures at-least-once delivery semantics

4. **Emits runtime events**
   - `started` - when message processing begins
   - `succeeded` - when message processing succeeds (with duration)
   - `failed` - when message processing fails (with error and duration)
   - `error` - for any errors during processing

### What Consumer Does NOT Do ❌

These are handled in higher layers (Processor, Scheduler, etc.):

- ❌ Cron scheduling
- ❌ Job state DB key management
- ❌ UI aggregation
- ❌ Pause/resume scanning
- ❌ Delay handling
- ❌ Retry logic
- ❌ DLQ routing

## Key Improvements Over Original Worker

### 1. Stable Consumer ID ✅

**Before:** Generated new consumer ID on every read

```typescript
const consumerId = `worker-${crypto.randomUUID()}`; // ❌ Changes every read
```

**After:** Stable consumer ID per instance

```typescript
this.consumerId = options.consumerId || this.generateStableConsumerId();
// Uses: consumer-{hostname}-{pid} or provided ID
```

### 2. Correct ACK Timing ✅

**Before:** ACKed messages before processing

```typescript
await this.streamdb.xack(...); // ❌ Before processing
// Then process...
```

**After:** ACKs after successful processing

```typescript
await this.handler(message, ctx); // Process first
await this.streamReader.ack(streamKey, message.id); // ✅ Then ack
```

### 3. Proper Pending Message Claiming ✅

**Before:** Manual `XPENDING` + `XCLAIM` with custom logic

**After:** Uses `XAUTOCLAIM` when available (Redis 6.2+), falls back gracefully

### 4. Clean Separation of Concerns ✅

- Consumer = runtime engine (fetch, process, ack, emit)
- Processor = policy layer (retries, delays, DLQ)
- Scheduler = cron/timing layer

## Usage

```typescript
import { Consumer } from './mod.ts';
import type { ConsumerOptions } from '../../types/consumer.ts';

const consumer = new Consumer({
  streams: ['my-queue-stream'],
  streamdb: redisClient,
  handler: async (message, ctx) => {
    // Process message
    console.log('Processing:', message.data);

    // Optionally ack early
    await ctx.ack();

    // Or let Consumer ack automatically on success
  },
  concurrency: 5,
  group: 'processor',
  consumerId: 'worker-1', // Optional: auto-generated if not provided
});

// Start processing
consumer.addEventListener('succeeded', (e) => {
  console.log('Message succeeded:', e.detail.message.id);
});

consumer.addEventListener('failed', (e) => {
  console.error('Message failed:', e.detail.error);
});

await consumer.start({ signal: abortSignal });

// Stop processing
consumer.stop();
await consumer.waitForActiveJobs(); // Wait for in-flight messages
```

## Files

- `consumer.ts` - Main Consumer class
- `stream-reader.ts` - Handles Redis Stream reading, consumer groups, claiming
- `concurrency-pool.ts` - Simple concurrency limiting
- `mod.ts` - Exports

### Stream trimming and memory

- **Trim after ACK (MINID)**: After each read+ACK the consumer trims the stream with `XTRIM MINID ~`: it keeps entries at or after the oldest pending (un-ACKed) message, or—if nothing is pending—trims up to the last ACKed message. No unprocessed jobs are ever dropped; the stream is bounded by natural backlog. One `xpending` per cycle is reused for both claim check and trim boundary.
- **`read.count`**: Max messages per XREADGROUP batch (default 200). Lower this if message payloads are large to avoid process memory spikes.

## Integration with Higher Layers

The Consumer is designed to be used by a Processor layer that handles:

```typescript
// Processor layer (future)
class Processor {
  constructor(private consumer: Consumer) {}

  async handle(message: Message, ctx: MessageContext) {
    // 1. Check if message is delayed
    if (message.data.delayUntil > Date.now()) {
      // Requeue for later
      return;
    }

    // 2. Execute handler
    try {
      await this.handlers[message.data.event](message.data, ctx);
      await ctx.ack();
    } catch (error) {
      // 3. Handle retries
      if (message.data.retryCount > 0) {
        await this.enqueueRetry(message);
        await ctx.ack(); // Ack original, retry is separate message
      } else {
        // 4. Route to DLQ
        await this.sendToDLQ(message, error);
        await ctx.ack();
      }
    }
  }
}
```

This separation allows:

- Consumer to focus on correctness (stable IDs, proper ACK timing)
- Processor to focus on business logic (retries, delays, routing)
- Easy testing of each layer independently
