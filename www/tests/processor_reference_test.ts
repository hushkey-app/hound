import { assert } from '@std/assert';

Deno.test('Processor reference matches current API', async () => {
  const docUrl = new URL('../docs/reference/processor.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'wraps a `Consumer`',
    'retries',
    'DLQ',
    'debounce',
    'new Processor(options: ProcessorOptions)',
    'ProcessorOptions',
    'consumer: ConsumerOptions',
    'streamdb: RedisConnection',
    'retry?: RetryConfig',
    'RetryConfig',
    'maxRetries',
    'retryDelayMs',
    'backoffMultiplier',
    'shouldRetry',
    'Default `0`',
    'Default `1000`',
    'Default `1`',
    'dlq?: DLQConfig',
    'debounce?: number | DebounceConfig',
    'number is shorthand for `{ debounce }`',
    'DebounceConfig',
    'keyFn',
    'ignoreConfigErrors?: boolean',
    'How options are applied',
    'wrapped `Consumer`',
    'requeueMessage()',
    'sendToDLQ()',
    'retry.maxRetries > 0',
    'DLQConfig.shouldSendToDLQ',
    'Math.ceil(value / 1000)',
    'ProcessableMessage',
    'delayUntil',
    'retryDelayMs',
    'retriedAttempts',
    'start(options?: { signal?: AbortSignal })',
    'stop(): void',
    'waitForActiveTasks(): Promise<void>',
    'cleanup(): void',
    'const processor = new Processor',
    'processor.start()',
    'processor.stop()',
    'RemqAdmin API',
    '/reference/sdk',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected Processor reference to include ${snippet}.`,
    );
  }

  assert(
    !content.includes('process(message') &&
      !content.includes('process(message:'),
    'Expected Processor reference to avoid process(message) placeholder.',
  );
});
