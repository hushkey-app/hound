import { assert } from '@std/assert';

Deno.test('task management guide uses TaskManager APIs', async () => {
  const docUrl = new URL('../docs/guide/task-management.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'Remq.create',
    'registerHandler',
    'emit',
    'delayUntil',
    'retryCount',
    'repeat',
    'attempts',
    'debounce',
    'priority',
    'queue',
    '/reference/task-manager',
    'full options and types',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected task management guide to include ${snippet}.`,
    );
  }

  assert(
    !content.includes('schedule('),
    'Expected task management guide to remove schedule() placeholder.',
  );

  assert(
    !content.includes('new Remq'),
    'Expected task management guide to avoid constructor usage.',
  );
});
