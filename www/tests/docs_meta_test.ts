import { assert, assertEquals } from '@std/assert';

type DocExpectation = {
  path: string;
  h1Count: number;
};

const docs: DocExpectation[] = [
  { path: '../docs/index.md', h1Count: 0 },
  { path: '../docs/getting-started/installation.md', h1Count: 1 },
  { path: '../docs/guide/index.md', h1Count: 1 },
  { path: '../docs/guide/quick-start.md', h1Count: 1 },
  { path: '../docs/guide/task-management.md', h1Count: 1 },
  { path: '../docs/guide/message-queues.md', h1Count: 1 },
  { path: '../docs/guide/consumers.md', h1Count: 1 },
  { path: '../docs/guide/admin-dashboard.md', h1Count: 1 },
  { path: '../docs/reference/index.md', h1Count: 1 },
  { path: '../docs/reference/task-manager.md', h1Count: 1 },
  { path: '../docs/reference/consumer.md', h1Count: 1 },
  { path: '../docs/reference/processor.md', h1Count: 1 },
  { path: '../docs/reference/sdk.md', h1Count: 1 },
];

Deno.test('docs include consistent frontmatter and headings', async () => {
  for (const doc of docs) {
    const docUrl = new URL(doc.path, import.meta.url);
    const content = await Deno.readTextFile(docUrl);
    const lines = content.split(/\r?\n/);

    assert(lines[0] === '---', `${doc.path} should start with frontmatter.`);

    const frontmatterEnd = lines.indexOf('---', 1);
    assert(frontmatterEnd > 0, `${doc.path} should close frontmatter.`);

    const frontmatter = lines.slice(1, frontmatterEnd).join('\n');
    assert(
      /^title:\s*.+/m.test(frontmatter),
      `${doc.path} should define a title in frontmatter.`,
    );
    assert(
      /^description:\s*.+/m.test(frontmatter),
      `${doc.path} should define a description in frontmatter.`,
    );

    let inCodeFence = false;
    const headingLines = lines.filter((line) => {
      if (line.startsWith('```')) {
        inCodeFence = !inCodeFence;
        return false;
      }

      return !inCodeFence && /^#\s+/.test(line);
    });
    assertEquals(
      headingLines.length,
      doc.h1Count,
      `${doc.path} should have ${doc.h1Count} H1 heading(s).`,
    );
  }
});

Deno.test('guide index keeps What is REMQ section', async () => {
  const docUrl = new URL('../docs/guide/index.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  assert(
    content.includes('## What is REMQ?'),
    'guide index should keep the What is REMQ section.',
  );
});

Deno.test('home page Get Started action points to installation', async () => {
  const docUrl = new URL('../docs/index.md', import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  assert(
    /text:\s*Get Started[\s\S]*?link:\s*\/getting-started\/installation/m.test(
      content,
    ),
    'home page Get Started action should link to /getting-started/installation.',
  );
});
