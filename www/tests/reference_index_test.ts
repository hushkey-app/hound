import { assert } from "@std/assert";

Deno.test("reference index lists all core APIs", async () => {
  const indexUrl = new URL("../docs/reference/index.md", import.meta.url);
  const content = await Deno.readTextFile(indexUrl);

  const requiredEntries = [
    "Remq",
    "Consumer",
    "Processor",
    "Sdk",
  ];

  for (const entry of requiredEntries) {
    assert(
      content.includes(entry),
      `Expected reference index to include ${entry}.`,
    );
  }
});
