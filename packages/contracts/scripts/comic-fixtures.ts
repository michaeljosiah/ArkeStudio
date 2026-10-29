// The shared comic fixtures (SPEC-064 R-50, R-51), made here and read by both readers:
//
//   npx tsx packages/contracts/scripts/comic-fixtures.ts           write them
//   npx tsx packages/contracts/scripts/comic-fixtures.ts --check   fail if one has drifted
//
// As the story fixtures are: the Studio writes the comic document, so the cases are the Studio's,
// and arke_world copies packages/contracts/test/fixtures/world-package/comic/ verbatim to
// packages/arke_world/test/fixtures/comic/. A "comic" case is a comic document read against
// assets.json; an ok one names its reading, aspect, language and pages per chapter. A "manifest"
// case is a world.json; an ok one names the production's comic and picture.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMIC_FORMAT, COMIC_MEDIA_TYPE, COMIC_VERSION, WORLD_PACKAGE_FORMAT, type WorldAsset } from "../src/world-package.js";

export const COMIC_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "world-package", "comic");

const ZERO = "0".repeat(64);
const asset = (path: string, mediaType: string): WorldAsset => ({ path, mediaType, byteLength: 1, sha256: ZERO });
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const ASSETS: Record<string, WorldAsset> = {
  comic: asset("low-water-drawn/comic.json", COMIC_MEDIA_TYPE),
  cover: asset("low-water-drawn/cover.jpg", "image/jpeg"),
  "p-0001": asset("low-water-drawn/pages/0001.jpg", "image/jpeg"),
  "p-0002": asset("low-water-drawn/pages/0002.jpg", "image/jpeg"),
  "p-0003": asset("low-water-drawn/pages/0003.png", "image/png"),
  "p-0004": asset("low-water-drawn/pages/0004.jpg", "image/jpeg"),
  narration: asset("low-water-drawn/narration.m4a", "audio/mp4"),
};

type Json = Record<string, unknown>;
const page = (picture: string, alt: string) => ({ picture, alt });
const BOOK: Json = {
  format: COMIC_FORMAT,
  version: COMIC_VERSION,
  reading: "ltr",
  aspect: "2:3",
  language: "en",
  chapters: [
    { title: "The tide", pages: [page("p-0001", "Maren alone on the flooded pier at dawn. The tide came in grey."), page("p-0002", "Maren calling over the water. Maren: Where are you?")] },
    { title: "Salt", pages: [page("p-0003", "The empty water. Hsssh."), page("p-0004", "A boat, far out.")] },
  ],
};

const WORLD: Json = {
  format: WORLD_PACKAGE_FORMAT,
  schemaVersion: 7,
  id: "the-undersong",
  edition: "2026-10-29",
  name: "The Undersong",
  logline: "A drowned god still sings beneath the harbour of Saltmouth.",
  alone: true,
  productions: [{ id: "low-water-drawn", title: "Low Water, drawn", picture: "cover", comic: "comic" }],
  assets: { comic: ASSETS["comic"], cover: ASSETS["cover"] },
};

export function comicFixtures(): Map<string, string> {
  const files = new Map<string, string>();
  const cases: Json[] = [];
  files.set("assets.json", pretty(ASSETS));
  const comic = (file: string, expect: "ok" | "notAPackage" | "newerArke", change: (value: Json) => void) => {
    const value = structuredClone(BOOK);
    change(value);
    files.set(file, pretty(value));
    const read = expect !== "ok" ? {} : {
      reading: value["reading"], aspect: value["aspect"], language: value["language"],
      pages: (value["chapters"] as Array<{ pages: unknown[] }>).map((chapter) => chapter.pages.length),
    };
    cases.push({ file, reader: "comic", expect, ...read });
  };
  comic("low-water-drawn.json", "ok", () => {});
  comic("right-to-left.json", "ok", (value) => void (value["reading"] = "rtl"));
  comic("webtoon.json", "ok", (value) => { value["reading"] = "scroll"; value["aspect"] = "9:16"; });
  comic("metadata.json", "ok", (value) => { value["metadata"] = { note: "ignored" }; (value["chapters"] as Json[])[0]!["metadata"] = 1; });
  comic("newer-version.json", "newerArke", (value) => void (value["version"] = COMIC_VERSION + 1));
  comic("requires.json", "newerArke", (value) => void (value["requires"] = ["panels"]));
  comic("unknown-key.json", "newerArke", (value) => void (value["panels"] = []));
  comic("page-unknown-key.json", "newerArke", (value) => void ((value["chapters"] as Array<{ pages: Json[] }>)[0]!.pages[0]!["box"] = {}));
  comic("not-a-comic.json", "notAPackage", (value) => void (value["format"] = "arke-story"));
  comic("reading-unknown.json", "notAPackage", (value) => void (value["reading"] = "zigzag"));
  comic("aspect-malformed.json", "notAPackage", (value) => void (value["aspect"] = "tall"));
  comic("no-chapters.json", "notAPackage", (value) => void (value["chapters"] = []));
  comic("chapter-empty.json", "notAPackage", (value) => void ((value["chapters"] as Json[])[1]!["pages"] = []));
  comic("picture-missing.json", "notAPackage", (value) => void ((value["chapters"] as Array<{ pages: Json[] }>)[0]!.pages[0]!["picture"] = "p-9999"));
  comic("picture-not-a-picture.json", "notAPackage", (value) => void ((value["chapters"] as Array<{ pages: Json[] }>)[0]!.pages[0]!["picture"] = "narration"));
  comic("alt-blank.json", "notAPackage", (value) => void ((value["chapters"] as Array<{ pages: Json[] }>)[0]!.pages[0]!["alt"] = "   "));

  const manifest = (file: string, expect: "ok" | "notAPackage" | "newerArke", change: (value: Json & { productions: Json[]; assets: Record<string, unknown> }) => void) => {
    const value = structuredClone(WORLD) as Json & { productions: Json[]; assets: Record<string, unknown> };
    change(value);
    files.set(file, pretty(value));
    cases.push({ file, reader: "manifest", expect, ...(expect === "ok" ? { comic: "comic", picture: "cover" } : {}) });
  };
  manifest("world-comic.json", "ok", () => {});
  manifest("world-comic-not-alone.json", "notAPackage", (value) => void delete value["alone"]);
  manifest("world-comic-two-productions.json", "notAPackage", (value) => void value.productions.push({ id: "salt", title: "Salt", comic: "comic" }));
  manifest("world-comic-beside-story.json", "notAPackage", (value) => {
    value.productions[0]!["story"] = "story";
    value.assets["story"] = asset("low-water-drawn/story.json", "application/vnd.arke.story+json");
  });
  manifest("world-comic-wrong-media.json", "notAPackage", (value) => void (value.productions[0]!["comic"] = "cover"));
  manifest("world-comic-with-key-art.json", "notAPackage", (value) => void (value["keyArt"] = "cover"));
  manifest("world-schema-7-without-comic.json", "notAPackage", (value) => {
    value.productions[0] = { id: "ring-once", title: "Ring Once", picture: "cover", story: "story" };
    value.assets = { story: asset("ring-once/story.json", "application/vnd.arke.story+json"), cover: ASSETS["cover"] };
  });
  // A Player that reads 6 meets `comic` as a key it does not know: newer, never a production.
  manifest("world-comic-in-schema-6.json", "newerArke", (value) => void (value["schemaVersion"] = 6));
  manifest("world-schema-8.json", "newerArke", (value) => void (value["schemaVersion"] = 8));

  files.set("cases.json", pretty({
    note: "SPEC-064 R-50, R-51: the comic cases both readers run, ArkeStudio contracts (TypeScript), which writes this folder with packages/contracts/scripts/comic-fixtures.ts, and Arke Player arke_world (Dart), which copies it. A \"comic\" case is a comic document read against assets.json: \"reading\", \"aspect\", \"language\" and \"pages\" (per chapter) are what an ok one reads. A \"manifest\" case is a world.json: \"comic\" and \"picture\" are what an ok one names. A key a reader does not know is newerArke, wherever it is; metadata is ignored.",
    limits: { chapters: 500, pages: 5000, title: 200, alt: 4000 },
    cases,
  }));
  return files;
}

export function comicFixtureDrift(dir = COMIC_FIXTURES_DIR): string[] {
  const expected = comicFixtures();
  let present: string[] = [];
  try {
    present = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // An absent folder drifts by every file.
  }
  const drift = present.filter((name) => !expected.has(name)).map((name) => `${name} is not the generator's`);
  for (const [name, text] of expected) {
    let written: string | null = null;
    try {
      written = readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
    } catch {
      // Reported below.
    }
    if (written === null) drift.push(`${name} is missing`);
    else if (written !== text) drift.push(`${name} has drifted`);
  }
  return drift;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = comicFixtureDrift();
    for (const line of drift) console.error(line);
    process.exit(drift.length > 0 ? 1 : 0);
  }
  mkdirSync(COMIC_FIXTURES_DIR, { recursive: true });
  for (const [name, text] of comicFixtures()) writeFileSync(join(COMIC_FIXTURES_DIR, name), text);
  console.log(`wrote ${comicFixtures().size} files to ${COMIC_FIXTURES_DIR}`);
}
