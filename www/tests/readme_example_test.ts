import { assert } from '@std/assert';

Deno.test('README includes minimal up-and-running example flow', async () => {
  const readmeUrl = new URL('../../README.md', import.meta.url);
  const content = await Deno.readTextFile(readmeUrl);

  assert(
    content.includes('## Up-and-running example'),
    'README should include an up-and-running example section.',
  );
  assert(
    content.includes('Remq.create'),
    'README example should include Remq.create.',
  );
  assert(
    content.includes('.on(') || content.includes('remq.on'),
    'README example should include on() for handlers.',
  );
  assert(
    content.includes('emit(') &&
      (content.includes('remq.emit') || content.includes('Remq')),
    'README example should include emit call.',
  );
  assert(
    content.includes('start()'),
    'README example should include start call.',
  );
});
