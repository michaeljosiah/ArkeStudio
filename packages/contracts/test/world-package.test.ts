import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guideChapterNumber, listeningPhraseAt, listeningPictureAt, readGuide, readListening, readWorldManifest, WorldAssetSchema, type GuideDocument, type ListeningDocumentChapter, type WorldAsset } from "../src/index.js";

// SPEC-058 R-16: one reader in two languages. These fixtures are Arke Player's own
// (`packages/arke_world/test/fixtures/listening`, made by its tool/make_listening_fixtures.py) and
// arke_world runs the same cases, so both readers reach the same verdicts and show the same picture
// and phrase at the same time.
const fixtures = join(import.meta.dirname, "fixtures", "world-package", "listening");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const assets: Record<string, WorldAsset> = Object.fromEntries(Object.entries(JSON.parse(read("assets.json")) as Record<string, unknown>).map(([id, raw]) => [id, WorldAssetSchema.parse(raw)]));

interface Case {
  file: string;
  expect: "ok" | "newerArke" | "notAPackage";
  /** `tall`, where a probe has it, is the Tall picture showing then (R-37). */
  at?: Array<{ chapter: string; ms: number; picture: string | null; tall?: string | null; phrase: number | null }>;
}

describe("the shared listening cases (SPEC-058 R-13, R-15, R-16)", () => {
  for (const entry of (JSON.parse(read("cases.json")) as { cases: Case[] }).cases) {
    it(entry.file, () => {
      const result = readListening(read(entry.file), assets);
      if (entry.expect === "ok") {
        if (!result.ok) assert.fail(result.reason);
        const chapters: ListeningDocumentChapter[] = result.document.chapters;
        for (const probe of entry.at ?? []) {
          const chapter = chapters.find((candidate) => candidate.id === probe.chapter)!;
          // The fixtures keep a timescale of 1000, so a millisecond is a tick.
          assert.equal(listeningPictureAt(chapter, probe.ms)?.picture ?? null, probe.picture, `${probe.chapter} @ ${probe.ms}: picture`);
          if (probe.tall !== undefined) assert.equal(listeningPictureAt(chapter, probe.ms)?.tall ?? null, probe.tall, `${probe.chapter} @ ${probe.ms}: tall`);
          const phrase = listeningPhraseAt(chapter, probe.ms);
          assert.equal(phrase === null ? null : chapter.phrases!.indexOf(phrase), probe.phrase, `${probe.chapter} @ ${probe.ms}: phrase`);
        }
      } else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.refusal, entry.expect === "newerArke" ? "newer-arke" : "not-a-package", result.reason);
      }
    });
  }

  it("puts the chapters in order", () => {
    const result = readListening(read("valid.json"), assets);
    assert.ok(result.ok);
    assert.deepEqual(result.document.chapters.map((chapter) => chapter.order), [1, 2]);
  });
});

describe("world.json (Player ADR 0005; SPEC-058 R-9, R-15)", () => {
  const digest = "a".repeat(64);
  const base = {
    format: "arke-world-package",
    schemaVersion: 2,
    id: "undersong",
    edition: "2026-10-21",
    name: "The Undersong",
    logline: "A drowned god still sings beneath the harbour.",
    keyArt: "key-art",
    productions: [{ id: "ledger-of-nights", title: "The Ledger of Nights", book: "book", listening: "listening" }],
    assets: {
      "key-art": { path: "key-art.jpg", mediaType: "image/jpeg", byteLength: 1, sha256: digest },
      book: { path: "ledger-of-nights/book.epub", mediaType: "application/epub+zip", byteLength: 1, sha256: digest },
      listening: { path: "ledger-of-nights/listening.json", mediaType: "application/vnd.arke.listening+json", byteLength: 1, sha256: digest },
      // Named only by the listening document, which the package check reads.
      a01: { path: "ledger-of-nights/audio/ch01.m4a", mediaType: "audio/mp4", byteLength: 1, sha256: digest },
    },
    provenance: { compiler: "arke-studio", version: "0.5.90" },
  };
  const verdict = (value: unknown) => {
    const result = readWorldManifest(JSON.stringify(value));
    return result.ok ? "ok" : result.refusal;
  };

  it("reads a schema 2 world with a listening production, ignoring its provenance", () => {
    const result = readWorldManifest(JSON.stringify(base));
    assert.ok(result.ok, result.ok ? "" : result.reason);
    assert.equal(result.manifest.productions[0]!.listening, "listening");
    assert.equal("provenance" in result.manifest, false);
  });

  it("still reads schema 1, where every file must be one world.json names", () => {
    const one = {
      ...base,
      schemaVersion: 1,
      productions: [{ id: "ledger-of-nights", title: "The Ledger of Nights", book: "book", narration: "a01" }],
      assets: { "key-art": base.assets["key-art"], book: base.assets.book, a01: base.assets.a01 },
    };
    assert.equal(verdict(one), "ok");
    assert.equal(verdict({ ...one, assets: { ...one.assets, extra: base.assets.listening } }), "not-a-package");
    // A schema 1 reader does not know a listening document.
    assert.equal(verdict({ ...one, productions: [{ ...one.productions[0], narration: undefined, listening: "a01" }] }), "newer-arke");
  });

  it("refuses what it does not know as made with a newer Arke", () => {
    assert.equal(verdict({ ...base, schemaVersion: 4 }), "newer-arke");
    // A schema 2 reader does not know a guide (SPEC-059 R-9).
    assert.equal(verdict({ ...base, guide: "listening" }), "newer-arke");
    assert.equal(verdict({ ...base, requires: ["video-v1"] }), "newer-arke");
    assert.equal(verdict({ ...base, shelf: "front" }), "newer-arke");
    assert.equal(verdict({ ...base, productions: [{ ...base.productions[0], rating: "PG" }] }), "newer-arke");
  });

  it("refuses what is wrong as not an Arke package", () => {
    assert.equal(verdict({ ...base, format: "arke-publication" }), "not-a-package");
    assert.equal(verdict({ ...base, productions: [{ ...base.productions[0], narration: "a01" }] }), "not-a-package");
    assert.equal(verdict({ ...base, productions: [{ id: "ledger-of-nights", title: "The Ledger of Nights" }] }), "not-a-package");
    assert.equal(verdict({ ...base, productions: [{ ...base.productions[0], book: "listening" }] }), "not-a-package");
    assert.equal(verdict({ ...base, assets: { ...base.assets, "key-art": { ...base.assets["key-art"], path: "../key-art.jpg" } } }), "not-a-package");
    assert.equal(verdict({ ...base, assets: { ...base.assets, "key-art": { ...base.assets["key-art"], path: "world.json" } } }), "not-a-package");
    assert.equal(verdict({ ...base, assets: { ...base.assets, a01: { ...base.assets.a01, path: "Key-Art.jpg" } } }), "not-a-package");
    assert.equal(verdict({ ...base, assets: { ...base.assets, a01: { ...base.assets.a01, sha256: "A".repeat(64) } } }), "not-a-package");
    assert.equal(verdict("[]"), "not-a-package");
  });
});

// SPEC-059 R-16: the guide's cases, Arke Player's own (`packages/arke_world/test/fixtures/guide`, made
// by its tool/make_guide_fixtures.py), which arke_world runs too.
describe("the shared guide cases (SPEC-059 R-9 – R-14, R-16)", () => {
  const guides = join(import.meta.dirname, "fixtures", "world-package", "guide");
  const readGuideFixture = (name: string) => readFileSync(join(guides, name), "utf8");
  const guideAssets: Record<string, WorldAsset> = Object.fromEntries(Object.entries(JSON.parse(readGuideFixture("assets.json")) as Record<string, unknown>).map(([id, raw]) => [id, WorldAssetSchema.parse(raw)]));
  interface GuideCase {
    file: string;
    reader?: "manifest";
    expect: "ok" | "newerArke" | "notAPackage";
    counts?: { characters: number; places: number; lore: number };
    after?: Array<{ entry: string; section?: number; number: number | null }>;
  }
  const afterOf = (guide: GuideDocument, entryId: string, section: number | undefined) => {
    const entry = [...guide.characters, ...guide.places, ...guide.lore].find((candidate) => candidate.id === entryId)!;
    return section === undefined ? entry.after : (entry as { sections: Array<{ after?: GuideDocument["characters"][number]["after"] }> }).sections[section]!.after;
  };

  for (const entry of (JSON.parse(readGuideFixture("cases.json")) as { cases: GuideCase[] }).cases) {
    it(entry.file, () => {
      const result = entry.reader === "manifest" ? readWorldManifest(readGuideFixture(entry.file)) : readGuide(readGuideFixture(entry.file), guideAssets);
      if (entry.expect === "ok") {
        if (!result.ok) assert.fail(result.reason);
        if (!("guide" in result) || typeof result.guide !== "object") return;
        const guide = result.guide;
        if (entry.counts !== undefined) assert.deepEqual({ characters: guide.characters.length, places: guide.places.length, lore: guide.lore.length }, entry.counts);
        for (const probe of entry.after ?? []) assert.equal(guideChapterNumber(guide, afterOf(guide, probe.entry, probe.section)), probe.number, `${probe.entry} ${probe.section ?? ""}`);
      } else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.refusal, entry.expect === "newerArke" ? "newer-arke" : "not-a-package", result.reason);
      }
    });
  }

  it("keeps a guide alone's guide and its want of productions", () => {
    const result = readWorldManifest(readGuideFixture("world-guide-alone.json"));
    assert.ok(result.ok);
    assert.equal(result.manifest.guide, "guide");
    assert.deepEqual(result.manifest.productions, []);
  });
});
