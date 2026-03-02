import { Processor } from '../libs/processor/mod.ts';
import type { ProcessableMessage } from '../libs/processor/mod.ts';
import type { MessageContext } from '../types/message.ts';
import type { RedisConnection } from '../types/redis-client.ts';

Deno.test('Processor sends to DLQ by default when streamKey is set', async () => {
  const xaddCalls: unknown[][] = [];
  const streamdb = {
    xadd: (...args: unknown[]) => {
      xaddCalls.push(args);
      return '1-0';
    },
  } as unknown as RedisConnection;

  const processor = new Processor({
    consumer: {
      streams: ['test-stream'],
      streamdb,
      handler: async () => {},
    },
    streamdb,
    retry: { maxRetries: 0 },
    dlq: { streamKey: 'test-dlq' },
  });

  const message: ProcessableMessage = {
    id: '1',
    streamKey: 'test-stream',
    data: { retryCount: 0 },
  };

  const ctx = {
    message,
    ack: async () => {},
    nack: async () => {},
  } as unknown as MessageContext;

  const processorAny = processor as unknown as {
    handleFailure: (
      message: ProcessableMessage,
      error: Error,
      ctx: MessageContext,
    ) => Promise<void>;
  };

  await processorAny.handleFailure(message, new Error('fail'), ctx);

  if (xaddCalls.length !== 1) {
    throw new Error(`Expected DLQ write, got ${xaddCalls.length}`);
  }

  const [streamKey] = xaddCalls[0];
  if (streamKey !== 'test-dlq') {
    throw new Error(`Expected DLQ stream 'test-dlq', got ${String(streamKey)}`);
  }
});

Deno.test('Processor respects shouldSendToDLQ and passes attempts', async () => {
  const xaddCalls: unknown[][] = [];
  const streamdb = {
    xadd: (...args: unknown[]) => {
      xaddCalls.push(args);
      return '1-0';
    },
  } as unknown as RedisConnection;

  let receivedAttempts: number | undefined;

  const processor = new Processor({
    consumer: {
      streams: ['test-stream'],
      streamdb,
      handler: async () => {},
    },
    streamdb,
    retry: { maxRetries: 0 },
    dlq: {
      streamKey: 'test-dlq',
      shouldSendToDLQ: (_message, _error, attempts) => {
        receivedAttempts = attempts;
        return false;
      },
    },
  });

  const message: ProcessableMessage = {
    id: '1',
    streamKey: 'test-stream',
    data: { retryCount: 0, retriedAttempts: 2 },
  };

  const ctx = {
    message,
    ack: async () => {},
    nack: async () => {},
  } as unknown as MessageContext;

  const processorAny = processor as unknown as {
    handleFailure: (
      message: ProcessableMessage,
      error: Error,
      ctx: MessageContext,
    ) => Promise<void>;
  };

  await processorAny.handleFailure(message, new Error('fail'), ctx);

  if (receivedAttempts !== 2) {
    throw new Error(`Expected attempts 2, got ${String(receivedAttempts)}`);
  }

  if (xaddCalls.length !== 0) {
    throw new Error(`Expected no DLQ write, got ${xaddCalls.length}`);
  }
});
