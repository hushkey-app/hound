/**
 * Hound codegen — generates examples/gen/hound-types.ts and examples/gen/hound-client.ts.
 * Run: deno task codegen
 */
import { generateClient, generateTypes } from '@hushkey/hound/mod.ts';

const here = new URL('.', import.meta.url).pathname;

await generateTypes(
  {
    jobDirs: ['../_scheduled', '../_tasks'],
    outputDir: '../gen',
    coreImport: '@hushkey/hound/mod.ts',
  },
  here,
);

await generateClient(
  {
    outputDir: '../gen',
    coreImport: '@hushkey/hound/mod.ts',
  },
  here,
);
