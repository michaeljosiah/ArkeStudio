import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openPromise } from "yauzl";
import { guideChapterNumber, readGuide, readWorldManifest } from "@arke-studio/contracts";
import { exportGuideAlone } from "../../src/productions/arke-player-guide-export.js";
import { setGuideEntry } from "../../src/productions/world-guide.js";
import { checkWorldPackageZip } from "../../src/productions/world-package.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

// SPEC-059 R-10: a world's guide alone, the package Arke Player pins beside the full one so a
// world can be explored before it is installed.
const LEDGER = "the-ledger-of-nights";
const CLOCK = () => "2026-10-22T12:00:00.000Z";
const exportId = (n: number) => `ap_01J8G00000000000000000000${n}`;

/** An encoder that makes every output, a few bytes each; `then` runs after each one. */
function makingFfmpeg(then: () => Promise<void> = async () => {}): FfmpegRunner {
  return {
    slateFont: "",
    run: async (args) => {
      await writeFile(args[args.length - 1]!, `made by ${args[args.length - 1]!.split(/[\\/]/).pop()}`);
      await then();
    },
  } as FfmpegRunner;
}

async function entry(file: string, name: string): Promise<string> {
  const zip = await openPromise(file, { autoClose: false });
  try {
    for await (const item of zip.eachEntry()) {
      if (item.fileName !== name) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(item)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    }
    throw new Error(`${name} is not in the package`);
  } finally {
    await new Promise<void>((resolve) => { zip.once("close", resolve); zip.close(); });
  }
}

async function withStore(run: (store: WorldStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  try {
    await run(store, dir);
  } finally {
    await store.close();
  }
}

const makePublic = async (store: WorldStore) => {
  const after = { production: LEDGER, chapter: "neap" };
  await setGuideEntry(store, { entryKind: "characters", id: "maren-kest", entry: { public: true, sections: { Essence: { public: true }, Relationships: { public: true, after } } } }, "editor");
  await setGuideEntry(store, { entryKind: "locations", id: "the-vigil", entry: { public: true, sections: { Look: { public: true } } } }, "editor");
  await setGuideEntry(store, { entryKind: "lore", id: "CANON-001", entry: { public: true, after } }, "editor");
};

describe("a world's guide alone (SPEC-059 R-10)", () => {
  it("is a schema 3 package with the world, its guide and no production", () =>
    withStore(async (store, dir) => {
      await makePublic(store);
      const result = await exportGuideAlone(store, { clock: CLOCK, ffmpeg: makingFfmpeg(), exportId: exportId(1), studioVersion: "test" });
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      assert.equal(result.file, "exports/the-undersong-guide-2026-10-22.zip");
      assert.deepEqual([result.characters, result.places, result.lore], [1, 1, 1]);

      const file = join(dir, ...result.file.split("/"));
      const checked = await checkWorldPackageZip(file);
      assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
      assert.equal(checked.sha256, result.sha256);
      const opened = readWorldManifest(await entry(file, "world.json"));
      assert.ok(opened.ok, opened.ok ? "" : opened.reason);
      assert.equal(opened.manifest.schemaVersion, 3);
      assert.equal(opened.manifest.id, "the-undersong");
      assert.equal(opened.manifest.edition, "2026-10-22");
      assert.deepEqual(opened.manifest.productions, []);
      assert.equal(opened.manifest.keyArt, "key-art");
      assert.equal(opened.manifest.guide, "guide");

      const readBack = readGuide(await entry(file, "guide/guide.json"), opened.manifest.assets);
      assert.ok(readBack.ok, readBack.ok ? "" : readBack.reason);
      const guide = readBack.guide;
      assert.deepEqual(guide.characters.map((character) => character.id), ["maren-kest"]);
      assert.deepEqual(guide.places.map((place) => place.id), ["the-vigil"]);
      // With no production in world.json, the guide's own list is what says After Chapter 1.
      assert.deepEqual(guide.characters[0]!.sections.map((section) => [section.heading, guideChapterNumber(guide, section.after)]), [["Essence", null], ["Relationships", 1]]);
      assert.equal(guideChapterNumber(guide, guide.lore[0]!.after), 1);
      // No book ships with it, so no chapter names a document of one.
      assert.ok(guide.productions.every((production) => production.chapters.every((chapter) => chapter.book === undefined)));

      // Nothing is listed in Publications and nothing is left in staging.
      assert.deepEqual(await readdir(join(dir, "exports")), ["the-undersong-guide-2026-10-22.zip"]);
      assert.deepEqual(await readdir(join(dir, ".staging", "arke-player-guide")).catch(() => []), []);
    }));

  it("is refused when nothing in the Guide is public", () =>
    withStore(async (store) => {
      const result = await exportGuideAlone(store, { clock: CLOCK, ffmpeg: makingFfmpeg(), exportId: exportId(2), studioVersion: "test" });
      assert.deepEqual(result, { ok: false, blockers: ["nothing in the Guide is public"] });
    }));

  it("takes the next edition the same day, never over an earlier one", () =>
    withStore(async (store) => {
      await makePublic(store);
      const first = await exportGuideAlone(store, { clock: CLOCK, ffmpeg: makingFfmpeg(), exportId: exportId(3), studioVersion: "test" });
      const second = await exportGuideAlone(store, { clock: CLOCK, ffmpeg: makingFfmpeg(), exportId: exportId(4), studioVersion: "test" });
      assert.ok(first.ok && second.ok);
      assert.equal(second.file, "exports/the-undersong-guide-2026-10-22-2.zip");
      assert.equal(second.edition, "2026-10-22-2");
    }));

  it("is refused when the Guide changes while it is made (SPEC-058 R-4)", () =>
    withStore(async (store, dir) => {
      await makePublic(store);
      let changed = false;
      const ffmpeg = makingFfmpeg(async () => {
        if (changed) return;
        changed = true;
        await setGuideEntry(store, { entryKind: "lore", id: "CANON-001", entry: { public: true } }, "editor");
      });
      const result = await exportGuideAlone(store, { clock: CLOCK, ffmpeg, exportId: exportId(5), studioVersion: "test" });
      assert.deepEqual(result, { ok: false, blockers: ["the Guide changed while the package was made · make it again"] });
      assert.deepEqual(await readdir(join(dir, "exports")).catch(() => []), []);
    }));
});
