import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMIC_FIXTURES_DIR, comicFixtureDrift } from "../scripts/comic-fixtures.js";
import { readComic, readWorldManifest, type WorldAsset } from "../src/world-package.js";

// SPEC-064 R-50, R-51: the comic cases, which contracts writes (scripts/comic-fixtures.ts) and Arke
// Player's arke_world copies and runs in Dart. One reader in two languages, held to the same files.
interface ComicCase { file: string; reader: "comic" | "manifest"; expect: "ok" | "notAPackage" | "newerArke"; reading?: string; aspect?: string; language?: string; pages?: number[]; comic?: string; picture?: string }
const read = (name: string) => readFileSync(join(COMIC_FIXTURES_DIR, name), "utf8");
const assets = JSON.parse(read("assets.json")) as Record<string, WorldAsset>;

describe("the shared comic cases (SPEC-064 R-50, R-51)", () => {
  it("are the generator's", () => {
    assert.deepEqual(comicFixtureDrift(), [], "run npx tsx packages/contracts/scripts/comic-fixtures.ts");
  });
  for (const entry of (JSON.parse(read("cases.json")) as { cases: ComicCase[] }).cases) {
    it(entry.file, () => {
      if (entry.reader === "comic") {
        const result = readComic(read(entry.file), assets);
        if (entry.expect === "ok") {
          if (!result.ok) assert.fail(result.reason);
          assert.deepEqual([result.document.reading, result.document.aspect, result.document.language], [entry.reading, entry.aspect, entry.language]);
          assert.deepEqual(result.document.chapters.map((chapter) => chapter.pages.length), entry.pages);
        } else {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.refusal, entry.expect === "newerArke" ? "newer-arke" : "not-a-package", result.reason);
        }
      } else {
        const result = readWorldManifest(read(entry.file));
        if (entry.expect === "ok") {
          if (!result.ok) assert.fail(result.reason);
          assert.equal(result.manifest.productions[0]!.comic, entry.comic);
          assert.equal(result.manifest.productions[0]!.picture, entry.picture);
        } else {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.refusal, entry.expect === "newerArke" ? "newer-arke" : "not-a-package", result.reason);
        }
      }
    });
  }
});
