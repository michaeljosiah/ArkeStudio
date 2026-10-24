import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_NARRATOR, guideCounts, guideDocument, pictureMarkKey, sentenceHashes, type GuideDocument, type GuideRecord, type ListeningChapter } from "@arke-studio/contracts";
import { planAudiobook } from "../../src/productions/audiobook.js";
import { setAudiobookPicture } from "../../src/productions/audiobook-listening.js";
import { chapterVoiceLines, guideMoments, guideProductions, packGuide, setGuideEntry } from "../../src/productions/world-guide.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { WorldStore } from "../../src/world/store.js";
import { sha256 } from "../../src/world/text-files.js";
import { tempDir } from "../tmp.js";
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

  it("keeps every change when several arrive at once (codex on PR 2156)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      await Promise.all([
        setGuideEntry(store, { entryKind: "characters", id: "maren-kest", entry: { public: true } }, "editor"),
        setGuideEntry(store, { entryKind: "characters", id: "bray-half-hitch", entry: { public: true } }, "editor"),
        setGuideEntry(store, { entryKind: "lore", id: "CANON-001", entry: { public: true } }, "editor"),
      ]);
      const record = store.getBundle().guide;
      assert.deepEqual(Object.keys(record.characters).sort(), ["bray-half-hitch", "maren-kest"]);
      assert.equal(record.lore["CANON-001"]?.public, true);
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

  it("cuts a voice line from its take, at most fifteen seconds, and fits each picture once (R-6, R-13)", async () => {
    const dir = await makeTempWorld();
    await mkdir(join(dir, "artifacts", "tk_voice"), { recursive: true });
    await writeFile(join(dir, "artifacts", "tk_voice", "take.wav"), "a take");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      const calls: string[][] = [];
      const ffmpeg = { slateFont: "", run: async (args: string[]) => { calls.push(args); await writeFile(args[args.length - 1]!, "made"); } } as unknown as FfmpegRunner;
      const made = await tempDir("arke-guide-pack-");
      const added: Array<[string, string, string]> = [];
      const line = { production: "the-ledger-of-nights", productionTitle: "The Ledger of Nights", chapter: "neap", chapterNumber: 1, block: "b1", sentence: 2, text: "I hear it.", file: "artifacts/tk_voice/take.wav", start: 4.25, seconds: 21 };
      const portrait = "references/maren-kest/head-front.png";
      const draft: GuideDocument = {
        format: "arke-guide",
        version: 1,
        productions: [{ id: "the-ledger-of-nights", title: "The Ledger of Nights", chapters: [{ id: "neap", number: 1 }] }],
        characters: [{ id: "maren-kest", name: "Maren Kest", portrait, sections: [], voice: { audio: line.file, text: line.text, duration: 15_000, production: line.production, chapter: line.chapter } }],
        places: [{ id: "the-vigil", name: "The Vigil", picture: portrait, sections: [] }],
        lore: [],
      };
      const packed = await packGuide({ document: draft, lines: new Map([["maren-kest", line]]), clips: new Map() }, store, {
        ffmpeg,
        signal: new AbortController().signal,
        at: (path) => join(made, ...path.split("/")),
        add: async (assetId, path, mediaType) => { added.push([assetId, path, mediaType]); },
        original: async () => {},
      });
      assert.deepEqual(packed, { ok: true });
      // One picture, though two entries show it; the voice as M4A; the guide document last.
      assert.deepEqual(added.map(([, path, mediaType]) => [path.replace(/\.(jpg|png)$/, ".pic"), mediaType.split("/")[0]]), [["guide/g001.pic", "image"], ["guide/g002.m4a", "audio"], ["guide/guide.json", "application"]]);
      const cut = calls.find((args) => args.at(-1)!.endsWith("g002.m4a"))!;
      assert.deepEqual([cut[cut.indexOf("-ss") + 1], cut[cut.indexOf("-t") + 1]], ["4.250", "15.000"]);
      const written = JSON.parse(await readFile(join(made, "guide", "guide.json"), "utf8")) as GuideDocument;
      assert.deepEqual([written.characters[0]!.portrait, written.characters[0]!.voice?.audio, written.places[0]!.picture], ["g001", "g002", "g001"]);
    } finally {
      await store.close();
    }
  });

  it("offers a line only from a take the character read, never the narrator's stand-in or an arranged passage (R-6)", () => {
    const block = (key: string, at: number) => ({ key, number: 1, file: `artifacts/${key}.wav`, artifactId: `art_${key}`, at, seconds: 6, sentences: [{ at, text: "I hear it." }, { at: at + 2, text: "I always hear it." }] });
    const chapter: ListeningChapter = { chapterId: "neap", order: 1, title: "Neap", state: "read", seconds: 30, blocks: [block("b1", 0), block("b2", 10), block("b3", 20)], gaps: [], pictures: [], opening: null };
    const takes = {
      b1: { artifactId: "art_b1", sheet: "maren-kest" },
      // Meant for Maren, read by the narrator when her voice was not there.
      b2: { artifactId: "art_b2", sheet: "maren-kest", substituted: { reason: "no-voice" } as never },
      b3: { artifactId: "art_b3", sheet: "bray-half-hitch" },
    };
    const production = { id: "the-ledger-of-nights", title: "The Ledger of Nights", number: 1 };
    const lines = chapterVoiceLines(chapter, takes, "maren-kest", production);
    assert.deepEqual(lines.map((line) => [line.block, line.sentence, line.file, line.start, line.seconds]), [["b1", 0, "artifacts/b1.wav", 0, 2], ["b1", 1, "artifacts/b1.wav", 2, 4]]);
    // A chapter arranged in Audio Studio sits on another clock, so none of its lines is offered.
    assert.deepEqual(chapterVoiceLines({ ...chapter, audioStudio: { revision: 1, issues: [], omissions: [] }, mix: { file: "cache/mix.m4a", seconds: 30 } }, takes, "maren-kest", production), []);
  });

  it("finds a picture teaser by its own key: a mark beside its block's own, and a bare block key as its first (R-27)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      const production = "the-ledger-of-nights";
      const plan = await planAudiobook(store, production, "neap", { narrator: DEFAULT_NARRATOR });
      const text = plan.blocks.find((row) => row.block.key === "p1.0")!.block.text;
      const mark = pictureMarkKey("p1.0", sentenceHashes(text)[1]!);
      await setAudiobookPicture(store, production, "neap", "p1.0", { file: "world-art.png", source: "world" });
      await setAudiobookPicture(store, production, "neap", mark, { file: "references/maren-kest/head-front.png", source: "cast" });
      const moment = (block: string) => ({ kind: "picture" as const, production, chapter: "neap", block });
      const both = await guideMoments(store, [moment("p1.0"), moment(mark)]);
      assert.deepEqual([...both.made.values()].map((made) => made.picture), ["world-art.png", "references/maren-kest/head-front.png"]);
      // A choice made before marks named themselves kept its block's key: with the block's own
      // picture gone, that names the mark, as it did when the mark went by its block's key.
      await setAudiobookPicture(store, production, "neap", "p1.0", null);
      const bare = await guideMoments(store, [moment("p1.0")]);
      assert.deepEqual([...bare.made.values()].map((made) => made.picture), ["references/maren-kest/head-front.png"]);
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
