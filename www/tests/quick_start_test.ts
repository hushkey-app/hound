import { assert } from '@std/assert';

Deno.test('Quick Start guide uses TaskManager.init and npm imports', async () => {
  const docUrl = new URL('../docs/guide/quick-start.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'deno add npm:@leotermine/tasker npm:ioredis',
    "import Redis from 'npm:ioredis';",
    "import { Remq } from 'npm:@leotermine/tasker';",
    'Remq.create',
    'registerHandler',
    'emit',
    'Job queued!',
    'full options and types',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected quick start to include ${snippet}.`,
    );
  }

  assert(
    !content.includes('schedule('),
    'Expected quick start to avoid schedule() placeholder.',
  );

  assert(
    !content.includes('new Remq'),
    'Expected quick start to avoid constructor usage.',
  );
});
