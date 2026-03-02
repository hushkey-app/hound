import { assert } from '@std/assert';

Deno.test('README documents REMQ installation and prerequisites', async () => {
  const readmeUrl = new URL('../../README.md', import.meta.url);
  const content = await Deno.readTextFile(readmeUrl);

  assert(
    content.includes('## Installation'),
    'README should include an Installation section.',
  );
  assert(
    content.includes('Deno 2.5'),
    'README should mention the Deno version prerequisite.',
  );
  assert(
    content.includes('Redis'),
    'README should mention Redis as a prerequisite.',
  );
  assert(
    content.includes('@core/'),
    'README should mention the @core/ workspace import alias.',
  );
});
