import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanWorld } from "../../src/world/scan.js";
import { makeTempWorld } from "./helpers.js";

it("measures saved chapter bodies instead of declared counts, without changing files", async () => {
  const dir = await makeTempWorld();
  const chapterDir = join(dir, "productions/the-ledger-of-nights/chapters");
  const examples = [
    { id: "neap", file: "01-neap.md", declared: "words: 3120\n", body: "The tide held.\n\nNobody moved.", words: 5 },
    { id: "the-same-ink", file: "02-the-same-ink.md", declared: "", body: "Ink on paper.", words: 3 },
    { id: "nothing-wrong-with-it", file: "03-nothing-wrong-with-it.md", declared: "words: 3520\n", body: " \n\t", words: 0 },
  ];
  const originals = new Map<string, string>();
  for (const [index, example] of examples.entries()) {
    const text = `---\nid: ${example.id}\ntitle: Count ${index + 1}\nnumber: ${index + 1}\nversion: 1\nstatus: draft\n${example.declared}---\n\n${example.body}\n`;
    originals.set(example.file, text);
    await writeFile(join(chapterDir, example.file), text);
  }
  for (let reopen = 0; reopen < 2; reopen++) {
    const scan = await scanWorld(dir);
    const chapters = scan.bundle.productions.find(p => p.meta.id === "the-ledger-of-nights")!.chapters;
    for (const example of examples) {
      assert.equal(chapters.find(chapter => chapter.id === example.id)?.words, example.words);
      assert.equal(await readFile(join(chapterDir, example.file), "utf8"), originals.get(example.file));
    }
  }
});
