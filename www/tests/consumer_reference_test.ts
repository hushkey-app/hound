import { assert } from '@std/assert';

Deno.test('Consumer reference matches current API', async () => {
  const docUrl = new URL('../docs/reference/consumer.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'ConsumerOptions',
    'streams: string[]',
    'streamdb: RedisConnection',
    'handler: MessageHandler',
    'type MessageHandler = (',
    'message: Message',
    'ctx: MessageContext',
    ') => Promise<void>',
    'streams',
    'streamdb',
    'handler',
    'concurrency?: number',
    'Default `1`',
    'group?: string',
    'Default `"processor"`',
    'consumerId?: string',
    'pollIntervalMs?: number',
    'Default `3000`',
    'claim?: { minIdleMs?: number; count?: number }',
    'minIdleMs?: number',
    'Default `1000`',
    'blockMs?: number',
    'Default `5000`',
    'addEventListener',
    'started',
    'succeeded',
    'failed',
    'error',
    'started` event fires before the handler runs',
    'succeeded` fires after the handler resolves',
    'failed` (and `error`) fire if the handler throws',
    'stop()` prevents new messages from being read, but in-flight handlers continue to completion',
    'start(options?: { signal?: AbortSignal })',
    'stop(): void',
    'const options: ConsumerOptions = {',
    'const consumer = new Consumer(options)',
    'const run = consumer.start()',
    'consumer.stop()',
    'await run',
    'RemqAdmin API',
    '/reference/sdk',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected Consumer reference to include ${snippet}.`,
    );
  }

  assert(
    !content.includes("on('message')") && !content.includes('on("message")'),
    "Expected Consumer reference to avoid on('message') placeholder.",
  );

  assert(
    !content.includes('consumer.on'),
    'Expected Consumer reference to avoid EventEmitter usage.',
  );
});
