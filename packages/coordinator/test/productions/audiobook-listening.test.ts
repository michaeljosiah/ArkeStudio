import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookListeningSchema,
  audiobookTextHash,
  ChapterAudiobookSchema,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_PICTURES_SCHEMA_VERSION } from "../../src/world/commit.js";
import { audiobookBookPath, planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import type { WorldStore } from "../../src/world/store.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
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

async function withHarness(run: (h: { worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; schemaVersion: () => number; store: () => WorldStore }) => Promise<void>, options: { ffmpeg?: FfmpegRunner } = {}): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
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
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async () => wav(),
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
    await run({ worldDir, events, send, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion, store: () => provider.openStore!()! });
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
  it("lists every chapter in order: one read whole, one read in part around its gap, one not read between read ones", () =>
    withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      // Chapter 2 in part: its title and its first paragraph only.
      await read(send, "02-the-same-ink", ["title", "p0.0"]);
      await read(send, "04-her-own-hand");
      const answer = await listen(send, events);
      assert.equal(answer.refused, undefined);
      const listening = AudiobookListeningSchema.parse(answer.listening);
      assert.deepEqual(listening.chapters.map((chapter) => [chapter.order, chapter.state]), [[1, "read"], [2, "part"], [3, "not read"], [4, "read"]]);
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
async function exportPlayer(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[]): Promise<Exported["result"]> {
  await send({ kind: "export-audiobook-player", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST });
  const answer = events.filter((e): e is Exported => e.type === "audiobook.exported").at(-1);
  assert.ok(answer, "the export is answered");
  return answer.result;
}

describe("the audiobook as the player (turn 186e)", () => {
  it("packages only the chapters read whole, the same player, the takes and the pictures, and lists it beside the other packages", () =>
    withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      await read(send, "02-the-same-ink", ["title", "p0.0"]);
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
      const result = await exportPlayer(send, events);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.chapters, 1, "the chapter read in part stays out");
      assert.equal(result.pictures, 2, "the cover and the one picture, once each");
      assert.equal(result.joined, false, "no ffmpeg here: the takes go as they were made");
      const dir = join(worldDir, result.dir);
      const page = await readFile(join(dir, "player.html"), "utf8");
      assert.match(page, /function mountAudiobookPlayer\(root, options\)/, "the app's own player, inlined");
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { kind: string; chapters: Array<{ id: string; audio: Array<{ src: string }>; blocks: unknown[]; pictures: Array<{ src: string }>; opening: string | null }>; files: Array<{ file: string }> };
      assert.equal(manifest.kind, "audiobook");
      assert.deepEqual(manifest.chapters.map((chapter) => chapter.id), ["neap"]);
      const neap = manifest.chapters[0]!;
      assert.equal(neap.audio.length, neap.blocks.length, "a piece a take");
      assert.ok(neap.audio.every((piece) => existsSync(join(dir, piece.src))));
      assert.equal(neap.pictures.length, 1);
      assert.ok(neap.opening !== null && existsSync(join(dir, neap.opening)), "the cover at the start");
      assert.equal(existsSync(join(worldDir, ".staging", "audiobook-export")) ? (await readdir(join(worldDir, ".staging", "audiobook-export"))).length : 0, 0, "nothing left staged");

      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: REQUEST });
      const listed = events.filter((e): e is Packages => e.type === "web-packages.listed").at(-1);
      assert.deepEqual(listed?.packages.map((entry) => [entry.kind, entry.productionId, entry.dir]), [["audiobook", LEDGER, result.dir]]);
    }));

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
