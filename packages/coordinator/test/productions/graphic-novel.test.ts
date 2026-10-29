import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ComicSettingsSchema, productionShape, ulid, type ComicPage } from "@arke-studio/contracts";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { saveComicScript, setComicSettings } from "../../src/productions/graphic-novel.js";
import { GRAPHIC_NOVEL_SCHEMA_VERSION } from "../../src/world/commit.js";
import { productionRecord } from "../../src/world-chat/production-record.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/** A graphic novel on disk (SPEC-064 slice 1): the kind, comic.json and fenced chapter scripts. */
const CLOCK = "2026-10-28T12:00:00.000Z";
async function comic() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "graphic-novel" });
  const chapter = await createChapter(store, id, { title: "The tide", order: 1 });
  return { store, id, chapter };
}
const exists = (path: string) => access(path).then(() => true, () => false);
const page = (text: string): ComicPage => ({
  id: ulid(), layout: "grid-2x2", status: "draft",
  panels: [{ id: ulid(), description: "Ife at the harbour wall.", characters: [], lettering: [{ id: ulid(), kind: "speech", text }] }],
});

describe("a graphic novel on disk (SPEC-064 R-1, R-10, R-12)", () => {
  it("is created with its settings and raises the world past older readers", async () => {
    const { store, id } = await comic();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === id)!;
    assert.equal(productionShape(production.meta).hasPages, true);
    assert.deepEqual(production.comic, ComicSettingsSchema.parse({ version: 1 }));
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= GRAPHIC_NOVEL_SCHEMA_VERSION);
  });

  it("saves a chapter's script whole, fenced and snapshotted", async () => {
    const { store, id, chapter } = await comic();
    const pages = [page("Where are you?")];
    const first = await saveComicScript(store, id, { chapter, pages, baseHash: null });
    assert.equal(first.version, 1);
    const path = join(store.dir, "productions", id, "comic", `${chapter}.json`);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).pages, pages, "ids round-trip");
    const second = await saveComicScript(store, id, { chapter, pages: [...pages, page("Here.")], baseHash: first.hash });
    assert.equal(second.version, 1, "a direct save keeps the version");
    assert.ok(await exists(join(store.dir, ".history", "productions", id, "comic", chapter, "v1.json")));
    const bundled = store.getBundle().productions.find((candidate) => candidate.meta.id === id)!;
    assert.equal(bundled.comicScripts?.[0]?.chapter, chapter);
    assert.equal(bundled.comicScripts?.[0]?.hash, second.hash, "the scan carries the next save's base");
    await assert.rejects(saveComicScript(store, id, { chapter, pages, baseHash: first.hash }), /base|stale|changed/i);
    // Arke reads what Pages shows (R-56): the script with its ids and the base an edit is fenced on.
    const read = productionRecord(store.getBundle(), id) as { comicScripts?: Array<{ chapter: string; baseHash: string; pages: unknown[] }> };
    assert.deepEqual(read.comicScripts?.map((entry) => [entry.chapter, entry.baseHash, entry.pages.length]), [[chapter, second.hash, 2]]);
  });

  it("refuses a chapter the book does not have, and a production that is not a graphic novel", async () => {
    const { store, id } = await comic();
    await assert.rejects(saveComicScript(store, id, { chapter: "nowhere", pages: [], baseHash: null }), /no chapter/);
    const book = await createProduction(store, { title: "A book", medium: "story" });
    await assert.rejects(saveComicScript(store, book, { chapter: "x", pages: [], baseHash: null }), /not a graphic novel/);
  });

  it("changes how the book reads", async () => {
    const { store, id } = await comic();
    const next = await setComicSettings(store, id, { reading: "rtl" });
    assert.equal(next.reading, "rtl");
    assert.equal(store.getBundle().productions.find((candidate) => candidate.meta.id === id)!.comic?.reading, "rtl");
    await assert.rejects(setComicSettings(store, id, { aspect: "wide" }));
  });

  it("keeps a style's words, and World look writes no style at all (R-21a)", async () => {
    const { store, id } = await comic();
    const noir = { words: "Crime noir comic: solid black shapes and stark white.", preset: "noir" };
    assert.deepEqual((await setComicSettings(store, id, { style: noir })).style, noir);
    // Another setting leaves the style as it was.
    assert.deepEqual((await setComicSettings(store, id, { reading: "rtl" })).style, noir);
    const cleared = await setComicSettings(store, id, { style: null });
    assert.equal("style" in cleared, false);
    const file = JSON.parse(await readFile(join(store.dir, "productions", id, "comic.json"), "utf8"));
    assert.equal("style" in file, false, "World look reads as a book from before there was a style");
    await assert.rejects(setComicSettings(store, id, { style: { words: "   " } }));
  });
});
