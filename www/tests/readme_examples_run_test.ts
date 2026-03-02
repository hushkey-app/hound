import { assert } from '@std/assert';

Deno.test('README documents how to run examples from the repo', async () => {
  const readmeUrl = new URL('../../README.md', import.meta.url);
  const content = await Deno.readTextFile(readmeUrl);

  assert(
    content.includes('## Running the examples'),
    'README should include a Running the examples section.',
  );
  assert(
    content.includes('deno task dev') ||
      content.includes('deno run -A examples'),
    'README should include a command for running examples.',
  );
  assert(
    content.includes('examples/scheduler/') &&
      content.includes('examples/crons/'),
    'README should point to scheduler and cron examples.',
  );
});
