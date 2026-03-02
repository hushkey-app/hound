import { Processor } from '../libs/processor/mod.ts';
import type { ProcessorOptions } from '../libs/processor/mod.ts';
import type { RedisConnection } from '../types/redis-client.ts';

Deno.test('Processor initializes retry, DLQ, and debounce configs', () => {
  const streamdb = {
    xadd: () => '1-0',
  } as unknown as RedisConnection;

  const processor = new Processor({
    consumer: {
      streams: ['orders-stream'],
      streamdb,
      handler: async () => {},
      concurrency: 10,
    },
    streamdb,
    retry: { maxRetries: 5, retryDelayMs: 2000 },
    dlq: { streamKey: 'orders-dlq' },
    debounce: {
      debounce: 300,
      keyFn: (message) => {
        const data = message.data as { orderId?: string };
        return data.orderId ?? message.id;
      },
    },
  });

  const processorAny = processor as unknown as {
    retryConfig?: ProcessorOptions['retry'];
    dlqConfig?: ProcessorOptions['dlq'];
    debounceManager?: unknown;
  };

  if (!processorAny.retryConfig || processorAny.retryConfig.maxRetries !== 5) {
    throw new Error('Expected retryConfig to be initialized with maxRetries');
  }

  if (
    !processorAny.dlqConfig || processorAny.dlqConfig.streamKey !== 'orders-dlq'
  ) {
    throw new Error('Expected dlqConfig to be initialized with streamKey');
  }

  if (!processorAny.debounceManager) {
    throw new Error('Expected debounceManager to be initialized');
  }
});
