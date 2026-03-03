import { assert } from '@std/assert';

const skippedDirs = new Set([
  'node_modules',
  '.git',
  '.ralphy',
  '.ralphy-worktrees',
  '.ralphy-sandboxes',
  'dist',
  'build',
  '.vitepress',
]);

async function* walkMarkdownFiles(root: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(root)) {
    if (skippedDirs.has(entry.name)) {
      continue;
    }

    const entryUrl = new URL(entry.name + (entry.isDirectory ? '/' : ''), root);

    if (entry.isDirectory) {
      yield* walkMarkdownFiles(entryUrl);
      continue;
    }

    if (entry.isFile && entry.name.endsWith('.md')) {
      yield entryUrl;
    }
  }
}

Deno.test('markdown code snippets use consistent TS fence tags and valid imports', async () => {
  const repoRoot = new URL('../../', import.meta.url);
  const tsFenceTags = new Set<string>();
  const invalidImportPaths: string[] = [];
  const invalidAliasMatches: string[] = [];

  for await (const fileUrl of walkMarkdownFiles(repoRoot)) {
    const content = await Deno.readTextFile(fileUrl);

    if (content.includes('@core_v2')) {
      invalidAliasMatches.push(fileUrl.pathname);
    }

    const lines = content.split(/\r?\n/);
    let inFence = false;
    let fenceTag = '';

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (!inFence) {
          fenceTag = line.slice(3).trim();
          if (fenceTag === 'ts' || fenceTag === 'typescript') {
            tsFenceTags.add(fenceTag);
          }
          inFence = true;
        } else {
          inFence = false;
          fenceTag = '';
        }
        continue;
      }

      if (inFence && (fenceTag === 'ts' || fenceTag === 'typescript')) {
        const match = line.match(/from\s+['"]([^'"]+)['"]/);
        if (match && match[1].startsWith('@core_v2')) {
          invalidImportPaths.push(`${fileUrl.pathname}: ${match[1]}`);
        }
      }
    }
  }

  assert(
    tsFenceTags.size <= 1,
    `Expected a single TS code fence tag, found: ${
      [...tsFenceTags].join(', ')
    }`,
  );

  assert(
    invalidAliasMatches.length === 0,
    `Expected no @core_v2 aliases in markdown. Found in: ${
      invalidAliasMatches.join(', ')
    }`,
  );

  assert(
    invalidImportPaths.length === 0,
    `Expected no @core_v2 imports in TS fences. Found: ${
      invalidImportPaths.join(', ')
    }`,
  );
});
