import { assert } from '@std/assert';

Deno.test('admin dashboard guide introduces RemqAdmin workflows', async () => {
  const docUrl = new URL('../docs/guide/admin-dashboard.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    'RemqAdmin',
    'queuesInfo',
    'stats',
    'listJobs',
    'getJob',
    'retryJob',
    'deleteJob',
    'remq.emit',
    '/reference/sdk',
    'full options and types',
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected admin dashboard guide to include ${snippet}.`,
    );
  }

  const forbiddenSnippets = [
    'pauseQueue',
    'resumeQueue',
    'pauseTask',
    'resumeTask',
    'cancelTask',
  ];

  for (const snippet of forbiddenSnippets) {
    assert(
      !content.includes(snippet),
      `Expected admin dashboard guide to avoid ${snippet}.`,
    );
  }
});
