import { assert } from '@std/assert';

Deno.test('README links to the VitePress docs in the repo', async () => {
  const readmeUrl = new URL('../../README.md', import.meta.url);
  const content = await Deno.readTextFile(readmeUrl);

  assert(
    content.includes('## Documentation'),
    'README should include a Documentation section.',
  );
  assert(
    content.includes('www/docs'),
    'README should link to the docs directory in the repo.',
  );
});
