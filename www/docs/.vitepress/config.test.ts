Deno.test('API Reference includes RemqAdmin entry', async () => {
  const configText = await Deno.readTextFile(
    new URL('./config.ts', import.meta.url),
  );
  const expectedLine = "{ text: 'RemqAdmin', link: '/reference/sdk' },";
  if (!configText.includes(expectedLine)) {
    throw new Error('Expected RemqAdmin sidebar entry.');
  }
});
