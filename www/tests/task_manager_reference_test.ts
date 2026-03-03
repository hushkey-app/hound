import { assert } from '@std/assert';

Deno.test('Remq reference matches current API', async () => {
  const docUrl = new URL('../docs/reference/task-manager.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'Remq.create',
    'on(',
    'emit(',
    'Minimal example',
    'send-welcome',
    'ctx.emit',
    'start()',
    'delay',
    'retryDelayMs',
    'retryCount',
    'priority',
    'repeat',
    'attempts',
    'debounce',
    'id',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected Remq reference to include ${snippet}.`,
    );
  }

  assert(
    !content.includes('schedule('),
    'Expected Remq reference to remove schedule() placeholder.',
  );

  assert(
    !content.includes('new Remq'),
    'Expected Remq reference to avoid constructor usage.',
  );

  const forbiddenSnippets = ['pauseQueue', 'resumeQueue', 'isQueuePaused'];

  for (const snippet of forbiddenSnippets) {
    assert(
      !content.includes(snippet),
      `Expected Remq reference to avoid ${snippet}.`,
    );
  }
});
