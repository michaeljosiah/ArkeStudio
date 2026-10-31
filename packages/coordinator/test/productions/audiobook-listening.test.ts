import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookListeningSchema,
  audiobookTextHash,
  ChapterAudiobookSchema,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
  type AudiobookScope,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_PICTURES_SCHEMA_VERSION } from "../../src/world/commit.js";
import { audiobookBookPath, planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import type { WorldStore } from "../../src/world/store.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { createRetailAudioTools, type RetailAudioTools, type RetailMeasurements } from "../../src/audio/retail.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-process.js";
import { createNodeFfmpegRunner } from "../../src/media/node-media-host.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-66..R-73): the plan the player
 * plays — every chapter in order, a chapter read in part playing its made blocks around its gaps,
 * a chapter not read listed and held — and a picture set on a block, written into the chapter's
 * record past the build before pictures.
 */
const CLOCK = "2026-10-03T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};

function wav(): Uint8Array {
  const samples = 8;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(out);
}

type Listening = Extract<DomainEvent, { type: "audiobook.listening" }>;
type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;

async function withHarness(run: (h: { root: string; worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; schemaVersion: () => number; store: () => WorldStore }) => Promise<void>, options: { ffmpeg?: FfmpegRunner; retail?: RetailAudioTools; speech?: () => Uint8Array; openPath?: (file: string) => void; listeningDeadlineMs?: number; provider?: (provider: FsWorldProvider) => void } = {}): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  options.provider?.(provider);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    mediaProbe: { durationSec: async () => 3, info: async () => ({ durationSec: 3, hasAudio: true }) },
    ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
    ...(options.retail ? { audioMediaTools: { retail: options.retail, probe: async () => { throw new Error("unused"); }, preparePcmWav: async () => { throw new Error("unused"); }, analyze: async () => { throw new Error("unused"); } } } : {}),
    ...(options.openPath !== undefined ? { openPath: options.openPath } : {}),
    ...(options.listeningDeadlineMs !== undefined ? { listeningDeadlineMs: options.listeningDeadlineMs } : {}),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async () => options.speech?.() ?? wav(),
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
      hostedReaders: [],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ root, worldDir, events, send, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion, store: () => provider.openStore!()! });
  } finally {
    await provider.close();
  }
}

const REQUEST = "01J00000000000000000000001";
const read = (send: (message: ClientMessage) => Promise<void>, chapterFile: string, blocks?: string[]) =>
  send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile, ...(blocks !== undefined ? { blocks } : {}) });
async function listen(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[]): Promise<Listening> {
  await send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST });
  const answer = events.filter((e): e is Listening => e.type === "audiobook.listening").at(-1);
  assert.ok(answer, "the listening plan is answered");
  return answer;
}

describe("the book as a listener hears it (turn 186)", () => {
  it("lists manuscript chapters in order and excludes an outlined chapter even when it has saved takes", () =>
    withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      // Chapter 2 in part: its title and its first paragraph only.
      await read(send, "02-the-same-ink", ["title", "p0.0"]);
      await read(send, "04-her-own-hand");
      const answer = await listen(send, events);
      assert.equal(answer.refused, undefined);
      const listening = AudiobookListeningSchema.parse(answer.listening);
      assert.deepEqual(listening.chapters.map((chapter) => [chapter.order, chapter.state]), [[1, "read"], [2, "part"], [3, "not read"]]);
      assert.equal(listening.cover, "world-art.png", "the world's key art is the book's cover");

      const neap = listening.chapters[0]!;
      assert.equal(neap.gaps.length, 0);
      assert.equal(neap.blocks[0]!.key, "title", "the title first");
      assert.equal(neap.seconds, neap.blocks.length * 3, "the takes back to back, nothing added");
      assert.ok(neap.blocks.every((block, index) => block.at === index * 3 && block.file.startsWith("artifacts/")));
      assert.ok(neap.blocks.every((block) => block.artifactId !== undefined), "each block's take by its artifact, for a timing layer to address");
      assert.equal(neap.opening, "world-art.png", "no picture on its opening block: the cover");

      const part = listening.chapters[1]!;
      assert.deepEqual(part.blocks.map((block) => block.key), ["title", "p0.0"]);
      assert.equal(part.gaps.length, 1);
      assert.equal(part.gaps[0]!.from, 3, "the gap starts after the made blocks");
      assert.equal(part.gaps[0]!.at, 6, "where the clock stands when it is reached");

      const unread = listening.chapters[2]!;
      assert.equal(unread.seconds, 0);
      assert.deepEqual(unread.blocks, [], "listed and held, nothing to play");
    }));

  it("sets a picture on a block past the build before pictures, places it on the clock, and takes it off again", () =>
    withHarness(async ({ worldDir, events, send, schemaVersion }) => {
      await read(send, "01-neap");
      assert.ok(schemaVersion() < AUDIOBOOK_PICTURES_SCHEMA_VERSION);
      const set = (block: string, picture: { file: string; source: "world" | "cast" | "scenes" | "generated" } | null) =>
        send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block, picture, requestId: REQUEST });
      const answer = () => events.filter((e): e is RecordEvent => e.type === "audiobook.record").at(-1)!;

      await set("p1.0", { file: "world-art.png", source: "world" });
      assert.equal(answer().refused, undefined);
      assert.equal(answer().record?.pictures?.["p1.0"]?.file, "world-art.png");
      assert.equal(schemaVersion(), AUDIOBOOK_PICTURES_SCHEMA_VERSION, "raised before the first pictured record");
      const onDisk = ChapterAudiobookSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")));
      assert.equal(onDisk.pictures?.["p1.0"]?.source, "world");

      const listening = AudiobookListeningSchema.parse((await listen(send, events)).listening);
      const neap = listening.chapters[0]!;
      const placed = neap.pictures[0]!;
      assert.equal(placed.key, "p1.0");
      assert.equal(placed.number, 3);
      assert.equal(placed.at, neap.blocks.find((block) => block.key === "p1.0")!.at);
      assert.equal(placed.seconds, neap.seconds - placed.at, "holds to the chapter's end");

      await set("p0.0", { file: "../outside.png", source: "world" });
      assert.match(answer().refused ?? "", /not in this world/, "only a picture the world holds");

      await set("p1.0", null);
      assert.equal(answer().record?.pictures, undefined);
      const raw = JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")) as Record<string, unknown>;
      assert.equal("pictures" in raw, false, "a record with none is written without the field");
    }));

  it("plays the takes whose words stand whoever would read them now: no voice catalogue is asked (codex on PR 1491)", () =>
    withHarness(async ({ worldDir, events, send, store }) => {
      await read(send, "01-neap");
      // The book now names a cloud narrator this machine has no voice for: every take is stale
      // to a reader's eye, and none is unplayable.
      const book = { schemaVersion: 1, reading: "narrator", narrator: { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "gone", label: "Gone" } };
      await writeFile(join(worldDir, audiobookBookPath(LEDGER)), JSON.stringify(book), "utf8");
      await store().reload();
      const neap = AudiobookListeningSchema.parse((await listen(send, events)).listening).chapters[0]!;
      assert.equal(neap.state, "read");
      assert.deepEqual(neap.gaps, []);
    }));

  it("removes a picture that followed its words to the block, wherever it is kept (codex on PR 1491)", () =>
    withHarness(async ({ worldDir, events, send, store }) => {
      const plan = await planAudiobook(store(), LEDGER, "neap", { narrator: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" } });
      const words = plan.blocks.find((planned) => planned.block.key === "p1.0")!.block.text;
      // Kept under a key a paragraph's move left behind, with p1.0's words.
      await updateAudiobook(store(), LEDGER, plan.chapter, (current) => ({ ...current, pictures: { "p9.0": { file: "world-art.png", source: "world", textHash: audiobookTextHash(words), at: CLOCK } } }));
      const shown = AudiobookListeningSchema.parse((await listen(send, events)).listening).chapters[0]!.pictures;
      assert.deepEqual(shown.map((picture) => picture.key), ["p1.0"], "shown on the block that says its words");
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: null, requestId: REQUEST });
      const answer = events.filter((e): e is RecordEvent => e.type === "audiobook.record").at(-1)!;
      assert.equal(answer.refused, undefined);
      assert.equal(answer.record?.pictures, undefined, "the old key goes with Remove");
      const raw = JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")) as Record<string, unknown>;
      assert.equal("pictures" in raw, false);
    }));

  it("stops showing a picture whose artifact is retired, though its bytes stay (codex on PR 1491)", () =>
    withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p0.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
      assert.equal(AudiobookListeningSchema.parse((await listen(send, events)).listening).chapters[0]!.pictures.length, 1);
      await send({ kind: "retire-artifact", worldId: WORLD_ID, artifactId: "ar_01J8G0000000000000000000R3" });
      assert.equal(AudiobookListeningSchema.parse((await listen(send, events)).listening).chapters[0]!.pictures.length, 0);
    }));

  it("refuses a block the chapter no longer has", () =>
    withHarness(async ({ events, send }) => {
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p999.0", picture: { file: "world-art.png", source: "world" } });
      const answer = events.filter((e): e is RecordEvent => e.type === "audiobook.record").at(-1);
      assert.match(answer?.refused ?? "", /no longer in the chapter/);
    }));
});

type Exported = Extract<DomainEvent, { type: "audiobook.exported" }>;
type Packages = Extract<DomainEvent, { type: "web-packages.listed" }>;
async function exportPlayer(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[], scope?: AudiobookScope): Promise<Exported["result"]> {
  await send({ kind: "export-audiobook-player", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, ...(scope !== undefined ? { scope } : {}) });
  const answer = events.filter((e): e is Exported => e.type === "audiobook.exported").at(-1);
  assert.ok(answer, "the export is answered");
  return answer.result;
}

describe("the audiobook as the player (turn 186e)", () => {
  it("opens a completed audiobook player through the host and refuses missing or unlisted players", () => {
    const opened: string[] = [];
    return withHarness(async ({ worldDir, send, events }) => {
      await read(send, "01-neap");
      const result = await exportPlayer(send, events, { kind: "chapter", chapterId: "neap" });
      assert.ok(result.ok, JSON.stringify(result));
      const dir = result.dir.slice("exports/".length);
      await send({ kind: "open-exports-folder", worldId: WORLD_ID, dir, file: "player.html" });
      assert.equal(opened.length, 1);
      assert.deepEqual(await readFile(opened[0]!), await readFile(join(worldDir, result.file)));
      await send({ kind: "open-exports-folder", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD", dir, file: "player.html" });
      const unlisted = join(worldDir, "exports", "audiobook-unlisted");
      await mkdir(unlisted);
      await writeFile(join(unlisted, "player.html"), "Unlisted HTML");
      await send({ kind: "open-exports-folder", worldId: WORLD_ID, dir: "audiobook-unlisted", file: "player.html" });
      await writeFile(join(unlisted, "manifest.json"), JSON.stringify({ kind: "interactive", productionId: LEDGER, provenance: { exportedAt: CLOCK } }));
      await send({ kind: "open-exports-folder", worldId: WORLD_ID, dir: "audiobook-unlisted", file: "player.html" });
      await rename(join(worldDir, result.file), join(worldDir, result.dir, "player.saved"));
      await send({ kind: "open-exports-folder", worldId: WORLD_ID, dir, file: "player.html" });
      assert.equal(opened.length, 1, "no other world, unlisted HTML, non-audiobook package or missing player reaches the host");
    }, { openPath: file => opened.push(file) });
  });

  it("keeps chapter export scope through listening, package and receipt, and never falls back from an incomplete or missing chapter", () =>
    withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      await read(send, "02-the-same-ink", ["title"]);
      await read(send, "04-her-own-hand");
      const scope: AudiobookScope = { kind: "chapter", chapterId: "neap" };
      await send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, scope });
      const plan = events.filter((event): event is Listening => event.type === "audiobook.listening").at(-1)!.listening!;
      assert.deepEqual(plan.chapters.map((chapter) => chapter.chapterId), ["neap"]);
      assert.deepEqual(plan.scope, scope);
      const result = await exportPlayer(send, events, scope);
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.scope, scope);
      assert.deepEqual(result.chapterIds, ["neap"]);
      const manifest = JSON.parse(await readFile(join(worldDir, result.dir, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.scope, scope);
      assert.deepEqual(manifest.chapters.map((chapter: { id: string }) => chapter.id), ["neap"]);
      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: REQUEST });
      const listed = events.filter((event): event is Packages => event.type === "web-packages.listed").at(-1)!.packages.find((entry) => entry.dir === result.dir)!;
      assert.deepEqual(listed.scope, scope, "reconnect keeps the saved delivery's selection");
      assert.deepEqual(listed.chapterIds, ["neap"]);
      const page = await readFile(join(worldDir, result.dir, "player.html"), "utf8");
      assert.ok(page.includes(`arke-ab-${WORLD_ID}-${LEDGER}-chapter-neap`), "chapter place does not overwrite the whole-book place");
      const incomplete = await exportPlayer(send, events, { kind: "chapter", chapterId: "the-same-ink" });
      assert.deepEqual(incomplete, { ok: false, blockers: ["this chapter is not read whole yet"] });
      const missing = await exportPlayer(send, events, { kind: "chapter", chapterId: "gone" });
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.match(missing.blockers.join(" "), /no longer in this production/);
      const book = await exportPlayer(send, events, { kind: "book" });
      assert.ok(book.ok, JSON.stringify(book));
      assert.deepEqual(book.chapterIds, ["neap"], "old outline takes never enter a book export");
      const bookManifest = JSON.parse(await readFile(join(worldDir, book.dir, "manifest.json"), "utf8"));
      assert.deepEqual(bookManifest.chapters.map((chapter: { id: string }) => chapter.id), ["neap"]);
      const outlineScope: AudiobookScope = { kind: "chapter", chapterId: "her-own-hand" };
      await send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, scope: outlineScope });
      const outline = events.filter((event): event is Listening => event.type === "audiobook.listening").at(-1)!.listening!;
      assert.deepEqual(outline.chapters.map((chapter) => [chapter.chapterId, chapter.state]), [["her-own-hand", "read"]]);
      const takeFiles = outline.chapters[0]!.blocks.map((block) => join(worldDir, block.file));
      const savedTakes = await Promise.all(takeFiles.map((file) => readFile(file)));
      const chapterExport = await exportPlayer(send, events, outlineScope);
      assert.ok(chapterExport.ok, JSON.stringify(chapterExport));
      assert.deepEqual(chapterExport.chapterIds, ["her-own-hand"], "the author can still export that chapter explicitly");
      assert.deepEqual(await Promise.all(takeFiles.map((file) => readFile(file))), savedTakes, "existing media stays unchanged");
      for (const selection of [{ chapters: ["her-own-hand"] }, { blocks: [{ chapterId: "her-own-hand", key: "title" }] }]) {
        await send({ kind: "audiobook-word-timing", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, action: "read", ...selection });
        const timing = events.filter((event) => event.type === "audiobook.word-timing").at(-1)!;
        assert.equal(timing.type, "audiobook.word-timing");
        assert.ok(timing.state.blocks.length > 0, "explicit outlined chapter tooling still receives its saved audio");
        assert.ok(timing.state.blocks.every((block) => block.chapterId === "her-own-hand"));
      }
    }));

  it("packages only the chapters read whole, the same player, the takes and the pictures, and lists it beside the other packages", () =>
    withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      await read(send, "02-the-same-ink", ["title", "p0.0"]);
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
      await send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: { x: 0.72, y: 0.31 }, requestId: REQUEST });
      const result = await exportPlayer(send, events);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.chapters, 1, "the chapter read in part stays out");
      assert.equal(result.pictures, 2, "the cover and the one picture, once each");
      assert.equal(result.joined, false, "no ffmpeg here: the takes go as they were made");
      const dir = join(worldDir, result.dir);
      const page = await readFile(join(dir, "player.html"), "utf8");
      assert.match(page, /function mountAudiobookPlayer\(root, options\)/, "the app's own player, inlined");
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { kind: string; chapters: Array<{ id: string; audio: Array<{ src: string }>; blocks: unknown[]; pictures: Array<{ src: string; at: number; seconds: number; focus?: { x: number; y: number } }>; opening: string | null }>; files: Array<{ file: string }> };
      assert.equal(manifest.kind, "audiobook");
      assert.deepEqual(manifest.chapters.map((chapter) => chapter.id), ["neap"]);
      const neap = manifest.chapters[0]!;
      assert.equal(neap.audio.length, neap.blocks.length, "a piece a take");
      assert.ok(neap.audio.every((piece) => existsSync(join(dir, piece.src))));
      assert.equal(neap.pictures.length, 1);
      assert.deepEqual(neap.pictures[0]!.focus, { x: 0.72, y: 0.31 }, "the shared package retains the focus used in Listen");
      const currentPlan = AudiobookListeningSchema.parse((await listen(send, events)).listening);
      assert.equal(neap.pictures[0]!.seconds, currentPlan.chapters[0]!.pictures[0]!.seconds, "the package retains the exact picture hold");
      assert.ok(neap.opening !== null && existsSync(join(dir, neap.opening)), "the cover at the start");
      assert.equal(existsSync(join(worldDir, ".staging", "audiobook-export")) ? (await readdir(join(worldDir, ".staging", "audiobook-export"))).length : 0, 0, "nothing left staged");

      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: REQUEST });
      const listed = events.filter((e): e is Packages => e.type === "web-packages.listed").at(-1);
      assert.deepEqual(listed?.packages.map((entry) => [entry.kind, entry.productionId, entry.dir]), [["audiobook", LEDGER, result.dir]]);
    }));

  it("refuses a package if picture focus changes while its media is being staged", () => {
    let blockExport = false;
    let entered!: () => void;
    let release!: () => void;
    const staging = new Promise<void>((resolve) => (entered = resolve));
    const proceed = new Promise<void>((resolve) => (release = resolve));
    const ffmpeg: FfmpegRunner = { slateFont: "", run: async (args) => {
      if (blockExport) { entered(); await proceed; }
      await writeFile(args[args.length - 1]!, "audio");
    } };
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
      blockExport = true;
      const exporting = exportPlayer(send, events);
      await staging;
      try {
        await send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: { x: 0.1, y: 0.9 }, requestId: REQUEST });
      } finally { release(); }
      const result = await exporting;
      assert.equal(result.ok, false, "stale focus cannot be delivered as the current plan");
      if (!result.ok) assert.match(result.blockers.join(" "), /changed/);
      assert.equal(existsSync(join(worldDir, ".staging", "audiobook-export")) ? (await readdir(join(worldDir, ".staging", "audiobook-export"))).length : 0, 0);
    }, { ffmpeg });
  });

  it("joins each chapter's takes into one file where this machine has ffmpeg", () => {
    const calls: string[][] = [];
    const ffmpeg: FfmpegRunner = {
      slateFont: "",
      run: async (args) => {
        calls.push(args);
        await writeFile(args[args.length - 1]!, "audio");
      },
    };
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      const result = await exportPlayer(send, events);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.joined, true);
      const manifest = JSON.parse(await readFile(join(worldDir, result.dir, "manifest.json"), "utf8")) as { chapters: Array<{ audio: Array<{ src: string; at: number }> }> };
      assert.deepEqual(manifest.chapters[0]!.audio.map((piece) => [piece.src, piece.at]), [["media/chapter-01.m4a", 0]]);
      const join_ = calls.find((args) => args.includes("concat"));
      assert.ok(join_, "the takes joined back to back by the concat demuxer, nothing added");
    }, { ffmpeg });
  });

  it("is registered with the exports, so shutdown and cancel stop a join in progress (codex on PR 1498)", () => {
    let started!: () => void;
    const joining = new Promise<void>((resolve) => (started = resolve));
    const ffmpeg: FfmpegRunner = {
      slateFont: "",
      run: (args, _progress, signal) => {
        if (!args.includes("concat") && !args.some((arg) => arg.endsWith(".wav"))) return writeFile(args[args.length - 1]!, "audio");
        started();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    };
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      const exportId = "ab_01J8G0000000000000000000X1";
      const running = send({ kind: "export-audiobook-player", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, exportId });
      await joining;
      await send({ kind: "cancel-export", worldId: WORLD_ID, exportId });
      await running;
      const answer = events.filter((e): e is Exported => e.type === "audiobook.exported").at(-1);
      assert.deepEqual(answer?.result, { ok: false, blockers: ["the export was cancelled"] });
      assert.equal(existsSync(join(worldDir, "exports", `audiobook-${LEDGER}-${exportId}`)), false, "nothing named");
    }, { ffmpeg });
  });

  it("refuses a book with no chapter read whole", () =>
    withHarness(async ({ events, send }) => {
      await read(send, "01-neap", ["title"]);
      const result = await exportPlayer(send, events);
      assert.deepEqual(result, { ok: false, blockers: ["no chapter is read whole yet"] });
    }));
});

describe("retail chapter files (SPEC-047 R-22/R-23)", () => {
  const ffmpeg: FfmpegRunner = { slateFont: "", run: async () => { throw new Error("Unexpected fallback render"); } };
  function retail(options: { noise?: number; corrupt?: boolean; output?: Partial<RetailMeasurements>; encode?: RetailAudioTools["encode"] } = {}): RetailAudioTools {
    const durations = new Map<string, number>();
    return {
      inspect: async (file, _signal, range) => ({ seconds: range ? range.to - range.from : durations.get(file) ?? 1, channels: file.endsWith(".mp3") ? 2 : 1,
        codec: file.endsWith(".mp3") ? "mp3" : "pcm_s16le", bitrate: 192000, sampleRate: 44100,
        rmsDb: -20.5, peakDb: -4, truePeakDb: -4, noiseFloorDb: options.noise ?? -80,
        headSeconds: file.endsWith(".mp3") ? 1.1 : 0, tailSeconds: file.endsWith(".mp3") ? 2.1 : 0,
        ...(file.endsWith(".mp3") ? options.output : {}) }),
      encode: options.encode ?? (async (_input, output, options_) => {
        const frame = Buffer.alloc(Math.floor(144 * 192000 / 44100)); frame.set([255, 251, options.corrupt ? 144 : 176, options_.channels === 1 ? 192 : 0]);
        const seconds = options_.to - options_.from + 3.2;
        await writeFile(output, Buffer.concat(Array.from({ length: Math.ceil(seconds * 44100 / 1152) }, () => frame))); durations.set(output, seconds);
      }),
    };
  }
  const exportChapters = (send: (message: ClientMessage) => Promise<void>, scope?: AudiobookScope) => send({ kind: "export-audiobook-chapters", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, exportId: "ab_01J8G0000000000000000000X1", ...(scope ? { scope } : {}) });
  const result = (events: DomainEvent[]) => events.filter((event): event is Extract<DomainEvent, { type: "audiobook.exported" }> => event.type === "audiobook.exported").at(-1)!.result;

  it("exports a selected complete chapter with a validation manifest, lists it, and leaves no scratch files", () => withHarness(async ({ worldDir, events, send }) => {
    await read(send, "01-neap");
    const scope: AudiobookScope = { kind: "chapter", chapterId: "neap" };
    await exportChapters(send, scope);
    const made = result(events); assert.ok(made.ok, JSON.stringify(made));
    const report = JSON.parse(await readFile(join(worldDir, made.file), "utf8"));
    assert.equal(report.kind, "audiobook-chapters"); assert.deepEqual(report.scope, scope);
    assert.deepEqual(report.chapterIds, ["neap"]); assert.equal(report.files.length, 1);
    assert.equal(report.files[0].file, "01-Chapter1.mp3"); assert.equal(report.files[0].measurements.rmsDb, -20.5);
    assert.deepEqual(await readdir(join(worldDir, made.dir)), ["01-Chapter1.mp3", "manifest.json"]);
    assert.deepEqual(await readdir(join(worldDir, ".staging/audiobook-chapters")), []);
    await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: REQUEST });
    const listed = events.filter((event): event is Extract<DomainEvent, { type: "web-packages.listed" }> => event.type === "web-packages.listed").at(-1)!;
    assert.equal(listed.packages[0]?.kind, "audiobook-chapters");
    assert.equal(events.filter(event => event.type === "export.progress").at(-1)?.status, "done");
  }, { ffmpeg, retail: retail() }));

  it("exports the read credits as files of their own, the opening first and the closing last (SPEC-047 R-216)", () => withHarness(async ({ worldDir, events, send }) => {
    await send({ kind: "set-audiobook-credits", worldId: WORLD_ID, productionId: LEDGER, details: { author: "Michael Josiah", narrator: "Ife Balogun" } });
    await read(send, "audiobook-credits");
    await read(send, "01-neap");
    await exportChapters(send);
    const made = result(events); assert.ok(made.ok, JSON.stringify(made));
    assert.deepEqual((await readdir(join(worldDir, made.dir))).sort(), ["00-OpeningCredits.mp3", "01-Chapter1.mp3", "02-ClosingCredits.mp3", "manifest.json"]);
    const report = JSON.parse(await readFile(join(worldDir, made.file), "utf8"));
    assert.deepEqual(report.credits.map((file: { file: string; credit: string }) => [file.credit, file.file]), [["opening", "00-OpeningCredits.mp3"], ["closing", "02-ClosingCredits.mp3"]]);
    assert.deepEqual(report.files.map((file: { file: string }) => file.file), ["01-Chapter1.mp3"], "the chapters' list stays the chapters'");
    // A chapter exported alone is a chapter, not the book: no credits ride with it.
    await send({ kind: "export-audiobook-chapters", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, exportId: "ab_01J8G0000000000000000000X2", scope: { kind: "chapter", chapterId: "neap" } });
    const alone = result(events); assert.ok(alone.ok, JSON.stringify(alone));
    assert.deepEqual((await readdir(join(worldDir, alone.dir))).sort(), ["01-Chapter1.mp3", "manifest.json"]);
  }, { ffmpeg, retail: retail() }));

  for (const [label, tools, reason] of [["noisy source", retail({ noise: -30 }), /noise/], ["wrong final bitrate", retail({ corrupt: true }), /not 192 kbps CBR/],
    ["decoded RMS outside range", retail({ output: { rmsDb: -12 } }), /RMS/], ["decoded peak above the ceiling", retail({ output: { truePeakDb: -1 } }), /peaks/],
    ["decoded noisy content despite quiet padding", retail({ output: { noiseFloorDb: -30 } }), /noise floor/], ["decoded spacing outside range", retail({ output: { tailSeconds: 6 } }), /quiet/]] as const) {
    it(`refuses ${label} without publishing a folder`, () => withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap"); await exportChapters(send);
      const answer = result(events); assert.equal(answer.ok, false);
      if (!answer.ok) assert.match(answer.blockers.join("; "), reason);
      assert.deepEqual(await readdir(join(worldDir, ".staging/audiobook-chapters")), []);
      assert.equal((await readdir(join(worldDir, "exports")).catch(() => [])).some(file => file.includes("-chapters-")), false);
    }, { ffmpeg, retail: tools }));
  }
  it("cancels the original native work and removes its staging folder", async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    await withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap"); const running = exportChapters(send); await ready;
      await send({ kind: "cancel-export", worldId: WORLD_ID, exportId: "ab_01J8G0000000000000000000X1" }); await running;
      assert.deepEqual(result(events), { ok: false, blockers: ["the export was cancelled"] });
      assert.deepEqual(await readdir(join(worldDir, ".staging/audiobook-chapters")), []);
    }, { ffmpeg, retail: retail({ encode: async (_input, _output, _options, signal) => {
      started(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } }) });
  });
  it("refuses source bytes replaced while encoding", () => {
    const tools = retail(); const encode = tools.encode;
    tools.encode = async (input, ...args) => { await encode(input, ...args); await writeFile(input, "changed"); };
    return withHarness(async ({ events, send }) => {
      await read(send, "01-neap"); await exportChapters(send);
      const answer = result(events); assert.equal(answer.ok, false);
      if (!answer.ok) assert.match(answer.blockers.join("; "), /changed/);
    }, { ffmpeg, retail: tools });
  });
  it("delivers measured native MP3 from kept WAV takes without changing them", { skip: !process.env.ARKE_FFMPEG }, async () => {
    const ffmpegPath = process.env.ARKE_FFMPEG!;
    const tools = createRetailAudioTools(createNodeMediaProcessRunner({ ffmpeg: ffmpegPath, ffprobe: process.env.ARKE_FFPROBE ?? ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1") }));
    const speech = () => {
      const samples = new Float32Array(24000 * 3);
      for (let index = 4800; index < samples.length - 7200; index++) if (index % 24000 < 16000) samples[index] = Math.sin(2 * Math.PI * 300 * index / 24000) * 0.04;
      return writeSpeechWav({ rate: 24000, samples });
    };
    await withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      const before = (await listen(send, events)).listening!.chapters[0]!;
      const originals = await Promise.all(before.blocks.map(block => readFile(join(worldDir, block.file))));
      await exportChapters(send, { kind: "chapter", chapterId: "neap" });
      const made = result(events); assert.ok(made.ok, JSON.stringify(made));
      const report = JSON.parse(await readFile(join(worldDir, made.file), "utf8"));
      assert.equal(report.files[0].measurements.bitrate, 192000);
      assert.equal(report.files[0].measurements.channels, 2);
      assert.ok(report.files[0].measurements.rmsDb >= -23 && report.files[0].measurements.rmsDb <= -18);
      assert.ok(report.files[0].measurements.truePeakDb <= -3);
      const after = await Promise.all(before.blocks.map(block => readFile(join(worldDir, block.file))));
      assert.deepEqual(after, originals);
    }, { ffmpeg: createNodeFfmpegRunner(ffmpegPath, ""), retail: tools, speech });
  });
});

describe("the book read while a long run goes on (2026-10-24)", () => {
  const ask = (send: (message: ClientMessage) => Promise<void>, requestId: string, scope?: AudiobookScope) =>
    send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId, ...(scope !== undefined ? { scope } : {}) });
  const answers = (events: DomainEvent[]) => events.filter((e): e is Listening => e.type === "audiobook.listening");

  it("answers every ask made while a read runs from one read begun after them, not one read each", () => {
    let reads = 0, counting = false;
    let holding!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    return withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      const asks = ["01J00000000000000000000A01", "01J00000000000000000000A02", "01J00000000000000000000A03", "01J00000000000000000000A04"];
      counting = true;
      const first = ask(send, asks[0]!);
      await held;
      // The windows ask again on every picture landed while the first read still runs.
      const rest = asks.slice(1).map((requestId) => ask(send, requestId));
      release();
      await Promise.all([first, ...rest]);
      assert.deepEqual(answers(events).map((answer) => answer.requestId).sort(), asks);
      assert.ok(answers(events).every((answer) => answer.refused === undefined && answer.listening?.chapters[0]?.state === "read"));
      assert.equal(reads, 2, "the asks made during the first read share the one after it");
      counting = false;
      // A chapter is its own read, not held behind the book's.
      await ask(send, "01J00000000000000000000A05", { kind: "chapter", chapterId: "neap" });
      assert.equal(answers(events).at(-1)?.listening?.chapters.length, 1);
    }, {
      provider: (provider) => {
        const background = provider.withBackgroundWorldStore.bind(provider);
        provider.withBackgroundWorldStore = async (worldId, fn, options) => background(worldId, async (store) => {
          if (counting) reads += 1;
          if (counting && reads === 1) { holding(); await barrier; }
          return fn(store);
        }, options);
      },
    });
  });

  it("answers a read whose world never comes as stalled, within the deadline, and says where it stuck", () => {
    let abandoned = false;
    // No keep-alive: the fake world below owns no I/O, so the stalled read's deadline is all that
    // holds the loop open, and must (CoalescedReads keeps it ref'd).
    return withHarness(async ({ root, events, send }) => {
      await ask(send, REQUEST);
      const answer = answers(events).at(-1);
      assert.equal(answer?.requestId, REQUEST);
      assert.equal(answer?.listening, null);
      assert.equal(answer?.refused, "reading took too long · try again");
      assert.equal(abandoned, true, "the wait for the world is given up, so its turn retains nothing");
      let logged = "";
      for (let i = 0; i < 50 && !logged.includes("audiobook.listening-failed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        logged = await readFile(join(root, "logs", "app.jsonl"), "utf8").catch(() => "");
      }
      const failure = logged.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["kind"] === "audiobook.listening-failed");
      assert.match(String(failure?.["message"]), /^stalled for \d+ s waiting for the world$/);
      // The next ask is read afresh; it is not held behind the one that stalled.
      await ask(send, "01J00000000000000000000B02");
      assert.equal(answers(events).at(-1)?.requestId, "01J00000000000000000000B02");
    }, {
      listeningDeadlineMs: 50,
      provider: (provider) => {
        // The world's queue held by something that does not end, as every store call behind it would wait.
        provider.withBackgroundWorldStore = (_worldId, _fn, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => { abandoned = true; reject(options.signal!.reason); }, { once: true });
        });
      },
    });
  });
});
