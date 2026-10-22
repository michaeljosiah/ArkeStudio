import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guideCounts, guideDocument, type GuideRecord } from "@arke-studio/contracts";
import { guideProductions, setGuideEntry } from "../../src/productions/world-guide.js";
import { WorldStore } from "../../src/world/store.js";
import { sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";

// SPEC-059 R-2, R-5, R-8: a world's Guide is its own record, written through the world's writes,
// versioned as a sheet is, and read from the sheets as they are at the time.
const CLOCK = () => "2026-10-22T12:00:00.000Z";

describe("a world's Guide record (SPEC-059 R-8)", () => {
  it("starts empty, and writes one entry at a time as a versioned record", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      const bundle = store.getBundle();
      assert.deepEqual(bundle.guide.characters, {});
      await setGuideEntry(store, { entryKind: "characters", id: "maren-kest", entry: { public: true, sections: { Essence: { public: true } } } }, "editor");
      await setGuideEntry(store, { entryKind: "lore", id: "CANON-001", entry: { public: true } }, "editor");
      const record = store.getBundle().guide;
      assert.equal(record.characters["maren-kest"]?.public, true);
      assert.equal(record.lore["CANON-001"]?.public, true);
      assert.equal(record.version, 2);
      const history = JSON.parse(await readFile(join(dir, ".history", "guide", "v1.json"), "utf8")) as GuideRecord;
      assert.deepEqual(Object.keys(history.lore), []);

      // Cleared choices leave the record.
      await setGuideEntry(store, { entryKind: "lore", id: "CANON-001", entry: null }, "editor");
      assert.deepEqual(store.getBundle().guide.lore, {});
    } finally {
      await store.close();
    }
  });

  it("refuses to write over a record that will not read", async () => {
    const dir = await makeTempWorld();
    await writeFile(join(dir, "guide.json"), "{ not json", "utf8");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      assert.ok(store.getBundle().problems.some((problem) => problem.path === "guide.json"));
      await assert.rejects(setGuideEntry(store, { entryKind: "characters", id: "maren-kest", entry: { public: true } }, "editor"), /guide\.json can't be read/);
      assert.equal(await readFile(join(dir, "guide.json"), "utf8"), "{ not json");
    } finally {
      await store.close();
    }
  });

  it("ships a sheet's text as it is now, less its Room note (R-5)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      await setGuideEntry(store, { entryKind: "characters", id: "maren-kest", entry: { public: true, sections: { Essence: { public: true } } } }, "editor");
      const sheets = store.getBundle().sheets;
      const world = { characters: sheets.filter((sheet) => sheet.type === "character"), locations: sheets.filter((sheet) => sheet.type === "location"), factions: sheets.filter((sheet) => sheet.type === "faction"), canon: store.getBundle().canon };
      const material = { ...world, productions: guideProductions(store), picture: () => undefined, voice: () => undefined };
      const guide = guideDocument(store.getBundle().guide, material)!;
      const essence = guide.characters[0]!.sections[0]!.text;
      assert.match(essence, /^Tide-caller\./);
      assert.doesNotMatch(essence, /Room note/);
      assert.deepEqual(guideCounts(store.getBundle().guide, world).characters, { public: 1, of: world.characters.filter((sheet) => sheet.retired !== true).length });

      // An edit to the sheet is what the next package carries.
      const path = join(dir, "characters", "maren-kest.md");
      const sheet = await readFile(path, "utf8");
      await store.commit({ kind: "sheet-edit", source: "editor", files: [{ path: "characters/maren-kest.md", action: "replace", content: sheet.replace("Tide-caller. She hears", "Tide-caller, still. She hears"), baseHash: sha256(sheet) }] });
      const again = guideDocument(store.getBundle().guide, { ...material, characters: store.getBundle().sheets.filter((entry) => entry.type === "character") })!;
      assert.match(again.characters[0]!.sections[0]!.text, /^Tide-caller, still\./);
    } finally {
      await store.close();
    }
  });

  it("numbers each production's chapters as the Studio calls them", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      const ledger = guideProductions(store).find((production) => production.id === "the-ledger-of-nights")!;
      const numbers = ledger.chapters.map((chapter) => chapter.number);
      assert.ok(numbers.length > 0);
      assert.ok(numbers.every((number, index) => index === 0 || number > numbers[index - 1]!));
    } finally {
      await store.close();
    }
  });
});
