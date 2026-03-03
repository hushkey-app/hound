import { assert } from '@std/assert';

Deno.test('message queues guide covers queue flow and options', async () => {
  const docUrl = new URL('../docs/guide/message-queues.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'Redis Streams',
    'Remq.emit',
    'registerHandler',
    "queue: 'emails'",
    'priority',
    'delayUntil',
    'retryCount',
    'Processor',
    'Consumer',
    'waiting',
    'processing',
    'completed',
    'failed',
    'delayed',
    '/reference/task-manager',
    '/reference/processor',
    'full options and types',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected message queues guide to include ${snippet}.`,
    );
  }
});
