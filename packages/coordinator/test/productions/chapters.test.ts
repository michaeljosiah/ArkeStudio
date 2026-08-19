import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MarkdownFile } from "../../src/world/text-files.js";
import { createChapter, createProduction, reorderChapters, saveChapter } from "../../src/productions/ops.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Chapter order end to end (issue 399): the schema, the writer, the scanner, and the summary
 * must agree on one order authority. These tests go through the scanned bundle rather than raw
 * frontmatter, because the raw files were fine all along — it was the read path that dropped
 * them.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

async function chaptersOf(dir: string, productionId: string) {
  const { bundle } = await scanWorld(dir);
  const production = bundle.productions.find((p) => p.meta.id === productionId);
  assert.ok(production, `production ${productionId} is in the bundle`);
  return production.chapters;
}

describe("chapter order through the scanned bundle (issue 399)", () => {
  it("a created chapter appears in the bundle and survives rescan", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    await createChapter(store, "inkbound", { title: "The neap ledger", order: 1 });
    await createChapter(store, "inkbound", { title: "What the water left", order: 2 });

    for (let pass = 0; pass < 2; pass++) {
      const chapters = await chaptersOf(dir, "inkbound");
      assert.equal(chapters.length, 2, `both chapters present on scan ${pass + 1}`);
      assert.deepEqual(
        chapters.map((c) => ({ id: c.id, file: c.file, order: c.order, status: c.status, version: c.version })),
        [
          { id: "the-neap-ledger", file: "the-neap-ledger", order: 1, status: "planned", version: 1 },
          { id: "what-the-water-left", file: "what-the-water-left", order: 2, status: "planned", version: 1 },
        ],
      );
    }
  });

  it("reordering changes bundle order only: no rename, no version cut, no history move", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    for (const [i, title] of ["First", "Second", "Third"].entries()) {
      await createChapter(store, "inkbound", { title, order: i + 1 });
    }
    const chapterDir = join(dir, "productions", "inkbound", "chapters");
    const namesBefore = (await readdir(chapterDir)).sort();

    await reorderChapters(store, "inkbound", ["third", "first", "second"]);

    assert.deepEqual((await readdir(chapterDir)).sort(), namesBefore, "no file renamed (R-4, D3)");
    const chapters = await chaptersOf(dir, "inkbound");
    assert.deepEqual(
      chapters.map((c) => ({ file: c.file, order: c.order, version: c.version })),
      [
        { file: "third", order: 1, version: 1 },
        { file: "first", order: 2, version: 1 },
        { file: "second", order: 3, version: 1 },
      ],
      "bundle order follows the explicit field, not the filename",
    );
  });

  it("legacy number-shaped chapters read, render, and reorder without vanishing", async () => {
    const { dir, store } = await open();
    const before = await chaptersOf(dir, "the-ledger-of-nights");
    assert.deepEqual(
      before.map((c) => ({ id: c.id, file: c.file, order: c.order })),
      [
        { id: "neap", file: "01-neap", order: 1 },
        { id: "the-same-ink", file: "02-the-same-ink", order: 2 },
        { id: "nothing-wrong-with-it", file: "03-nothing-wrong-with-it", order: 3 },
        { id: "her-own-hand", file: "04-her-own-hand", order: 4 },
      ],
      "the shipped `number` shape reads as order, and the summary carries the stem",
    );
    assert.equal(before[0]?.status, "drafted", "authored status survives");
    assert.equal(before[0]?.words, 3120, "authored word count survives");

    // The regression this issue exists for: writing `order` into a shipped chapter must not
    // make it fail the read schema and disappear from the bundle.
    await reorderChapters(store, "the-ledger-of-nights", [
      "02-the-same-ink",
      "01-neap",
      "04-her-own-hand",
      "03-nothing-wrong-with-it",
    ]);
    const after = await chaptersOf(dir, "the-ledger-of-nights");
    assert.equal(after.length, 4, "all four chapters still present after reorder");
    assert.deepEqual(
      after.map((c) => ({ file: c.file, order: c.order })),
      [
        { file: "02-the-same-ink", order: 1 },
        { file: "01-neap", order: 2 },
        { file: "04-her-own-hand", order: 3 },
        { file: "03-nothing-wrong-with-it", order: 4 },
      ],
      "explicit order wins over both the legacy field and the filename",
    );
    const raw = await readFile(join(dir, "productions", "the-ledger-of-nights", "chapters", "01-neap.md"), "utf8");
    const data = MarkdownFile.parse(raw).data;
    assert.equal(data["number"], 1, "the legacy field is left where it was, not rewritten");
    assert.equal(data["order"], 2, "the authority field is written beside it");
    assert.equal(data["version"], 4, "reorder cuts no version");
  });

  it("ties and invalid orders fall back to filename order, deterministically", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    const chapterDir = join(dir, "productions", "inkbound", "chapters");
    const author = (id: string, fields: string) =>
      writeFile(join(chapterDir, `${id}.md`), `---\nid: ${id}\n${fields}\ntitle: ${id}\nversion: 1\n---\n\nProse.\n`);
    await createChapter(store, "inkbound", { title: "Anchor", order: 1 });
    await author("tied-b", "order: 5");
    await author("tied-a", "order: 5");
    await author("zero", "order: 0");
    await author("bare", "status: planned");

    const chapters = await chaptersOf(dir, "inkbound");
    assert.deepEqual(
      chapters.map((c) => ({ file: c.file, order: c.order })),
      [
        { file: "anchor", order: 1 },
        { file: "tied-a", order: 2 },
        { file: "tied-b", order: 3 },
        { file: "bare", order: 4 },
        { file: "zero", order: 5 },
      ],
      "ties break by filename; unresolvable orders sort last by filename; the summary is dense",
    );
    assert.equal(chapters.find((c) => c.file === "bare")?.status, "planned", "absent status reads as planned");
  });

  it("the summary's stem addresses the file the commands need", async () => {
    const { dir, store } = await open();
    const [first] = await chaptersOf(dir, "the-ledger-of-nights");
    assert.ok(first, "the fixture production has a first chapter");
    await saveChapter(store, "the-ledger-of-nights", first.file, "Six columns since 1747.");
    const [after] = await chaptersOf(dir, "the-ledger-of-nights");
    assert.ok(after, "the chapter is still first after the save");
    assert.equal(after.words, 4, "a save addressed by the summary's stem lands in the same chapter");
    assert.equal(after.version, first.version, "a direct save cuts no version (R-5)");
  });
});
