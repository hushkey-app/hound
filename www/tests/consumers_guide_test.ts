import { assert } from '@std/assert';

Deno.test('consumers guide covers lifecycle, options, and references', async () => {
  const docUrl = new URL('../docs/guide/consumers.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'EventTarget',
    'start()',
    'stop()',
    'concurrency',
    'consumerId',
    'ack()',
    'nack()',
    '/reference/consumer',
    'full options and types',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected consumers guide to include ${snippet}.`,
    );
  }
});
