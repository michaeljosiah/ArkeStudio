import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openPromise } from "yauzl";
import { guideChapterNumber, guideTeasers, readGuide, readListening, readWorldManifest, type ClientMessage, type DomainEvent, type ListeningBlock, type ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { phrasesOf } from "../../src/productions/arke-player-listening.js";
import { exportArkePlayer, listArkePlayerPackages, packageSlug, pngHasAlpha, webpHasAlpha } from "../../src/productions/arke-player-export.js";
import { checkWorldPackageZip, editionFingerprint } from "../../src/productions/world-package.js";
import { planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Export → Arke Player (design turn 233, SPEC-058 R-1 – R-8): the world package of a Story
 * production, made on this machine and read back by the shared reader before it is named.
 */
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
  const out = Buffer.alloc(44 + 16);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(16, 40);
  return new Uint8Array(out);
}

/** An encoder that makes every output, a few bytes each, and remembers what it was asked. */
function recordingFfmpeg(calls: string[][]): FfmpegRunner {
  return {
    slateFont: "",
    run: async (args) => {
      calls.push(args);
      await writeFile(args[args.length - 1]!, `made by ${args[args.length - 1]!.split(/[\\/]/).pop()}`);
    },
  } as FfmpegRunner;
}

type Exported = Extract<DomainEvent, { type: "arke-player.exported" }>;
type Progress = Extract<DomainEvent, { type: "export.progress" }>;
type Listed = Extract<DomainEvent, { type: "web-packages.listed" }>;

async function withHarness(run: (h: { worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; store: () => WorldStore }) => Promise<void>, ffmpeg?: FfmpegRunner): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => "2026-10-21T09:00:00.000Z" });
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
    manifest: { manifestVersion: 1, generated: "2026-10-21", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    mediaProbe: { durationSec: async () => 3, info: async () => ({ durationSec: 3, hasAudio: true }) },
    ...(ffmpeg !== undefined ? { ffmpeg } : {}),
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
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, store: () => provider.openStore!()! });
  } finally {
    await provider.close();
  }
}

const read = (send: (message: ClientMessage) => Promise<void>, chapterFile: string) => send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile });
const exportId = (n: number) => `ap_01J8G${String(n).padStart(21, "0")}`;
async function exportPackage(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[], n: number, options: { book: boolean; motion: boolean; size?: "full" | "1280" | "960" } = { book: true, motion: true }): Promise<Exported["result"]> {
  await send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: LEDGER, requestId: "01J00000000000000000000001", exportId: exportId(n), options });
  const answer = events.filter((event): event is Exported => event.type === "arke-player.exported" && event.exportId === exportId(n)).at(-1);
  assert.ok(answer, "the export is answered");
  return answer.result;
}

/** Release · New chapters (turn 236d): a part of these chapters, with the author's schedule. */
async function exportPart(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[], n: number, chapters: string[], schedule?: { day?: "friday" | "daily"; next?: string }): Promise<Exported["result"]> {
  await send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: LEDGER, requestId: "01J00000000000000000000001", exportId: exportId(n), options: { book: true, motion: true, part: { chapters, ...(schedule !== undefined ? { schedule } : {}) } } });
  const answer = events.filter((event): event is Exported => event.type === "arke-player.exported" && event.exportId === exportId(n)).at(-1);
  assert.ok(answer, "the export is answered");
  return answer.result;
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

describe("Export → Arke Player (turn 233, SPEC-058)", () => {
  it("reports known external changes before joining audio or fitting pictures", async () => {
    const calls: string[][] = [];
    await withHarness(async ({ worldDir, store }) => {
      const chapter = join(worldDir, "productions", LEDGER, "chapters", "01-neap.md");
      await writeFile(chapter, (await readFile(chapter, "utf8")) + "\nAn outside edit.\n");
      await store().reload();
      assert.equal(store().getBundle().externalEdits.length, 1);
      // The supported CLI calls the shared exporter directly; the UI has an earlier
      // background-world ownership check. Preserve both and the final export gate.
      const result = await exportArkePlayer(store(), LEDGER, { clock: () => "2026-11-01T10:00:00Z", exportId: exportId(91), ffmpeg: recordingFfmpeg(calls), include: { book: true, motion: true }, studioVersion: "test" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.blockers.join(" "), /Review 1 external file change.*Reconcile/);
      assert.deepEqual(calls, [], "no expensive media preparation before the refusal");
      assert.equal(store().getBundle().externalEdits.length, 1, "preflight cannot accept edits");
    }, recordingFfmpeg(calls));
  });
  it("is refused as Needs ffmpeg on a machine without one, and says so in Activity (R-4)", () =>
    withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      const result = await exportPackage(send, events, 1);
      assert.deepEqual(result, { ok: false, blockers: ["Needs ffmpeg"] });
      const progress = events.filter((event): event is Progress => event.type === "export.progress" && event.exportId === exportId(1));
      assert.equal(progress.at(-1)?.status, "failed");
    }));

  it("stops on a Cancel pressed while it is still starting (codex on PR 2058)", () => {
    const calls: string[][] = [];
    return withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      const asked = send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: LEDGER, requestId: "01J00000000000000000000001", exportId: exportId(4), options: { book: true, motion: true } });
      // Cancel the moment Activity shows it, while Publish's settings are still being read.
      while (!events.some((event) => event.type === "export.progress" && event.exportId === exportId(4))) await new Promise((resolve) => setImmediate(resolve));
      await send({ kind: "cancel-export", worldId: WORLD_ID, exportId: exportId(4) });
      await asked;
      const answer = events.filter((event): event is Exported => event.type === "arke-player.exported" && event.exportId === exportId(4)).at(-1);
      assert.deepEqual(answer?.result, { ok: false, blockers: ["the export was cancelled"] });
      assert.equal(calls.length, 0, "nothing was encoded");
    }, recordingFfmpeg(calls));
  });

  it("makes one package of the book and the chapters read whole, read back by the shared reader (R-2, R-5, R-7, R-8)", () => {
    const calls: string[][] = [];
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      const result = await exportPackage(send, events, 2);
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      assert.match(result.file, /^exports\/the-undersong-player-\d{4}-\d{2}-\d{2}\.zip$/);
      assert.equal(result.chapters, 1);
      assert.equal(result.book, true);
      const file = join(worldDir, ...result.file.split("/"));
      const checked = await checkWorldPackageZip(file);
      assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
      assert.equal(checked.sha256, result.sha256);

      const manifestText = await entry(file, "world.json");
      const opened = readWorldManifest(manifestText);
      assert.ok(opened.ok);
      assert.equal(opened.manifest.schemaVersion, 2);
      assert.equal(opened.manifest.id, "the-undersong");
      assert.equal(opened.manifest.name, "The Undersong");
      assert.equal(opened.manifest.keyArt, "key-art");
      const production = opened.manifest.productions[0]!;
      assert.deepEqual([production.id, production.title, production.book, production.listening], [LEDGER, "The Ledger of Nights", "book", "listening"]);
      assert.equal(production.picture, "key-art", "without Publish's cover the key art stands in (R-2)");
      // Nothing of the workshop and no host path rides along (R-5, R-8).
      assert.doesNotMatch(manifestText, /[A-Za-z]:\\|\/Users\/|\/tmp\/|artifacts\//);
      const provenance = JSON.parse(manifestText).provenance;
      assert.equal(provenance.compiler, "arke-studio/arke-player-export");
      assert.equal(provenance.studio, "test");
      assert.match(provenance.originals["key-art"], /^[0-9a-f]{64}$/);

      const listening = readListening(await entry(file, "listening.json"), opened.manifest.assets);
      assert.ok(listening.ok, listening.ok ? "" : listening.reason);
      const chapter = listening.document.chapters[0]!;
      assert.equal(chapter.id, "neap");
      assert.equal(chapter.audio, "ch01");
      assert.equal(chapter.book, "OEBPS/chapter-1.xhtml");
      assert.ok((chapter.phrases ?? []).length > 0, "Text has its phrases");
      assert.ok(chapter.phrases!.every((phrase, index, all) => index === 0 || phrase.at >= all[index - 1]!.end), "phrases follow one another");

      // Pictures fitted for a phone: no longer than 2048 px on a side (R-6).
      assert.ok(calls.some((args) => args.includes("-vf") && args[args.indexOf("-vf") + 1]!.includes("min(2048,iw)")));

      // Activity followed it by its steps (233b), and it ended done.
      const progress = events.filter((event): event is Progress => event.type === "export.progress" && event.exportId === exportId(2));
      assert.equal(progress[0]?.label, "Arke Player · The Ledger of Nights");
      assert.ok(progress.some((event) => event.step?.startsWith("Joining chapters")));
      assert.ok(progress.some((event) => event.step?.startsWith("Fitting pictures")));
      assert.deepEqual([progress.at(-1)?.status, progress.at(-1)?.output], ["done", result.file]);

      // Publications lists it with its length and SHA-256 (233e).
      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: "01J00000000000000000000002" });
      const listed = events.filter((event): event is Listed => event.type === "web-packages.listed").at(-1)!;
      const found = listed.packages.find((entry) => entry.kind === "arke-player");
      assert.deepEqual([found?.file, found?.sha256, found?.bytes, found?.exportId], [result.file, result.sha256, result.bytes, exportId(2)]);
      assert.match(found?.holds ?? "", /^1 chapter · \d+ pictures? · the book$/);

      // A second export the same day is a new edition beside it, never over it (R-7).
      const again = await exportPackage(send, events, 3, { book: false, motion: true });
      assert.ok(again.ok);
      assert.equal(again.file, result.file.replace(/\.zip$/, "-2.zip"));
      assert.equal(again.book, false);
      const second = readWorldManifest(await entry(join(worldDir, ...again.file.split("/")), "world.json"));
      assert.ok(second.ok);
      assert.equal(second.manifest.productions[0]!.book, undefined, "the book left out");
      assert.equal(await readFile(file).then((bytes) => bytes.length), result.bytes, "the first package untouched");
    }, recordingFfmpeg(calls));
  });

  it("shows the production by Publish's cover, not the world's key art (R-2)", () => {
    const calls: string[][] = [];
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      // Publish's cover is the production's own picture; the key art stays the world's. The Player
      // shows a production by its picture, so with the key art in both it showed one picture twice.
      await mkdir(join(worldDir, "covers"), { recursive: true });
      const coverBytes = Buffer.concat([await readFile(join(worldDir, "world-art.png")), Buffer.from("the ledger's own cover")]);
      await writeFile(join(worldDir, "covers", "ledger.png"), coverBytes);
      await send({ kind: "publish-story", worldId: WORLD_ID, productionId: LEDGER, requestId: "01J00000000000000000000003", input: { action: "review", settings: {
        title: "The Ledger of Nights", author: "A. Writer", language: "en", label: "", description: "", cover: "covers/ledger.png", chapterIds: ["neap"], outputs: ["epub"], avoidEmDashes: false,
      } } });
      const result = await exportPackage(send, events, 6, { book: false, motion: true });
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      const manifestText = await entry(join(worldDir, ...result.file.split("/")), "world.json");
      const opened = readWorldManifest(manifestText);
      assert.ok(opened.ok);
      const picture = opened.manifest.productions[0]!.picture;
      assert.ok(picture !== undefined && picture !== "key-art", `the production has its own picture, not ${picture}`);
      assert.equal(opened.manifest.keyArt, "key-art", "the world keeps its key art");
      assert.equal(JSON.parse(manifestText).provenance.originals[picture], createHash("sha256").update(coverBytes).digest("hex"), "it is Publish's cover");
      assert.equal(opened.manifest.productions[0]!.author, "A. Writer");
    }, recordingFfmpeg(calls));
  });
});

describe("Release · New chapters (turn 236, SPEC-058 R-43 – R-47)", () => {
  it("makes a part of the chapters read whole since the edition, naming the edition by the Player's fingerprint", () => {
    const calls: string[][] = [];
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      // With no edition yet, a part has nothing to follow (R-43).
      assert.deepEqual(await exportPart(send, events, 10, ["the-same-ink"]), { ok: false, blockers: ["Release the whole world first · a part follows an edition"] });
      const edition = await exportPackage(send, events, 11);
      assert.ok(edition.ok, edition.ok ? "" : edition.blockers.join("; "));
      const editionFile = join(worldDir, ...edition.file.split("/"));
      const editionManifest = readWorldManifest(await entry(editionFile, "world.json"));
      assert.ok(editionManifest.ok);

      await read(send, "02-the-same-ink");
      await send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "03-nothing-wrong-with-it", blocks: ["title"] });
      // Only chapters read whole go to a listener (R-3, R-44): chapter 3 is read in part.
      const early3 = await exportPart(send, events, 12, ["the-same-ink", "nothing-wrong-with-it"]);
      assert.deepEqual(early3, { ok: false, blockers: ["Chapter 3 · Nothing wrong with it · not read whole yet"] });

      const part = await exportPart(send, events, 13, ["the-same-ink"], { day: "friday", next: "2026-11-06" });
      assert.ok(part.ok, part.ok ? "" : part.blockers.join("; "));
      assert.match(part.file, /^exports\/the-undersong-part-\d{4}-\d{2}-\d{2}\.zip$/);
      assert.equal(part.part, 1);
      assert.equal(part.chapters, 1);
      const file = join(worldDir, ...part.file.split("/"));
      const checked = await checkWorldPackageZip(file);
      assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
      const opened = readWorldManifest(await entry(file, "world.json"));
      assert.ok(opened.ok, opened.ok ? "" : opened.reason);
      assert.equal(opened.manifest.schemaVersion, 4);
      assert.deepEqual(opened.manifest.part, { follows: edition.edition, fingerprint: editionFingerprint(editionManifest.manifest), number: 1, schedule: { day: "friday", next: "2026-11-06" } });
      // Nothing released before is sent again: no key art, cover or guide, and only its chapter (R-45).
      assert.equal(opened.manifest.keyArt, undefined);
      assert.equal(opened.manifest.guide, undefined);
      assert.equal(opened.manifest.productions[0]!.picture, undefined);
      const listening = readListening(await entry(file, "listening.json"), opened.manifest.assets);
      assert.ok(listening.ok, listening.ok ? "" : listening.reason);
      assert.deepEqual(listening.document.chapters.map((chapter) => [chapter.id, chapter.order, chapter.book]), [["the-same-ink", 2, "OEBPS/chapter-1.xhtml"]]);
      assert.equal(listening.document.cover, undefined);
      const progress = events.filter((event): event is Progress => event.type === "export.progress" && event.exportId === exportId(13));
      assert.equal(progress[0]?.label, "Arke Player · part · The Ledger of Nights");

      // Publications keeps what each release held (R-47).
      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: "01J00000000000000000000005" });
      const listed = events.filter((event): event is Listed => event.type === "web-packages.listed").at(-1)!;
      const found = listed.packages.find((entry) => entry.exportId === exportId(13));
      assert.deepEqual(found?.release?.part?.number, 1);
      assert.deepEqual(found?.release?.chapters.map((chapter) => chapter.id), ["the-same-ink"]);
      assert.equal(listed.packages.find((entry) => entry.exportId === exportId(11))?.release?.part, undefined);

      // The next part follows the same edition, numbered 2; a chapter released already is refused.
      await read(send, "03-nothing-wrong-with-it");
      assert.equal((await exportPart(send, events, 14, ["the-same-ink"])).ok, false);
      const second = await exportPart(send, events, 15, ["nothing-wrong-with-it"]);
      assert.ok(second.ok, second.ok ? "" : second.blockers.join("; "));
      assert.equal(second.part, 2);
      const secondManifest = readWorldManifest(await entry(join(worldDir, ...second.file.split("/")), "world.json"));
      assert.ok(secondManifest.ok);
      assert.equal(secondManifest.manifest.part?.fingerprint, editionFingerprint(editionManifest.manifest));
      assert.equal(secondManifest.manifest.part?.schedule, undefined, "a schedule is the request's, kept by the sheet");
    }, recordingFfmpeg(calls));
  });
});

describe("a world's teasers (turn 236, SPEC-059 R-24 – R-29)", () => {
  it("carries them in the guide: an entry public from the start, a picture, and a clip cut from its moment", () => {
    const calls: string[][] = [];
    return withHarness(async ({ worldDir, events, send, store }) => {
      await read(send, "01-neap");
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "world-art.png", source: "world" }, requestId: "01J00000000000000000000003" });
      await send({ kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "characters", id: "maren-kest", entry: { public: true, sections: { Essence: { public: true } } } } });
      // A place that waits for a chapter is in the Guide, but never a teaser (R-25).
      await send({ kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "locations", id: "the-vigil", entry: { public: true, after: { production: LEDGER, chapter: "neap" } } } });
      const before = store().getBundle().meta.schemaVersion;
      await send({ kind: "set-guide-teasers", worldId: WORLD_ID, change: { teasers: [
        { kind: "character", sheet: "maren-kest" },
        { kind: "clip", production: LEDGER, chapter: "neap", block: "p1.0" },
        { kind: "location", sheet: "the-vigil" },
        { kind: "picture", production: LEDGER, chapter: "neap", block: "p1.0" },
      ] } });
      // A build before teasers reads the record as unreadable, so the world is raised first.
      assert.ok(before < 108);
      assert.equal(store().getBundle().meta.schemaVersion, 108);
      assert.equal(store().getBundle().guide.teasers?.length, 4, "the Guide keeps every choice, marked or not (R-27)");

      const result = await exportPackage(send, events, 9);
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      const file = join(worldDir, ...result.file.split("/"));
      const checked = await checkWorldPackageZip(file);
      assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
      const opened = readWorldManifest(await entry(file, "world.json"));
      assert.ok(opened.ok);
      const readBack = readGuide(await entry(file, "guide/guide.json"), opened.manifest.assets);
      assert.ok(readBack.ok, readBack.ok ? "" : readBack.reason);
      const guide = readBack.guide;
      assert.equal(guide.version, 2);
      const teasers = guideTeasers(guide);
      assert.deepEqual(teasers.map((teaser) => teaser.kind), ["character", "clip", "picture"], "the waiting place is left out");
      const clip = teasers[1]!;
      assert.ok(clip.kind === "clip");
      assert.equal(opened.manifest.assets[clip.audio]?.mediaType, "audio/mp4");
      assert.ok(clip.duration > 0 && clip.duration <= 30_000);
      assert.equal(clip.title, "Neap");
      assert.deepEqual([clip.production, clip.chapter], [LEDGER, "neap"]);
      // Cut from the moment's start and joined as one file; its picture fitted to 1280 for a full screen.
      assert.ok(calls.some((args) => args.includes("-filter_complex") && /concat=n=\d+:v=0:a=1/.test(args[args.indexOf("-filter_complex") + 1]!)));
      assert.ok(calls.some((args) => args.includes("-vf") && args[args.indexOf("-vf") + 1]!.includes("min(1280,iw)")));
    }, recordingFfmpeg(calls));
  });
});

describe("the package's parts", () => {
  it("knows a transparent PNG from an opaque one (R-6)", () => {
    const png = (colorType: number, chunk?: string) => {
      const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write("IHDR", 4, "latin1");
      // Bit depth, then colour type: bytes 24 and 25 of the file.
      ihdr[16] = 8;
      ihdr[17] = colorType;
      const extra = chunk === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(chunk, "latin1"), Buffer.alloc(4)]);
      const idat = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("IDAT", "latin1"), Buffer.alloc(4)]);
      return new Uint8Array(Buffer.concat([head, ihdr, extra, idat]));
    };
    assert.equal(pngHasAlpha(png(6)), true);
    assert.equal(pngHasAlpha(png(2)), false);
    assert.equal(pngHasAlpha(png(2, "tRNS")), true);
    assert.equal(pngHasAlpha(png(3, "PLTE")), false);
  });

  it("knows a transparent WebP, lossy with VP8X or lossless (R-6)", () => {
    const webp = (chunk: string, flagOrBits: number) => {
      const bytes = Buffer.alloc(32);
      bytes.write("RIFF", 0, "latin1");
      bytes.write("WEBP", 8, "latin1");
      bytes.write(chunk, 12, "latin1");
      if (chunk === "VP8X") bytes[20] = flagOrBits;
      if (chunk === "VP8L") { bytes[20] = 0x2f; bytes.writeUInt32LE(flagOrBits, 21); }
      return new Uint8Array(bytes);
    };
    assert.equal(webpHasAlpha(webp("VP8X", 0x10)), true);
    assert.equal(webpHasAlpha(webp("VP8X", 0x00)), false);
    assert.equal(webpHasAlpha(webp("VP8L", 1 << 28)), true);
    assert.equal(webpHasAlpha(webp("VP8L", 0)), false);
    assert.equal(webpHasAlpha(webp("VP8 ", 0)), false);
  });

  it("carries the world's guide when something is public, and none when nothing is (SPEC-059 R-13, R-15)", () => {
    const calls: string[][] = [];
    return withHarness(async ({ worldDir, events, send }) => {
      await read(send, "01-neap");
      // Nothing public: no guide, and the package stays at the schema an older Player reads.
      const plain = await exportPackage(send, events, 5);
      assert.ok(plain.ok, plain.ok ? "" : plain.blockers.join("; "));
      assert.equal(plain.guide, false);
      const plainManifest = readWorldManifest(await entry(join(worldDir, ...plain.file.split("/")), "world.json"));
      assert.ok(plainManifest.ok);
      assert.equal(plainManifest.manifest.schemaVersion, 2);
      assert.equal(plainManifest.manifest.guide, undefined);

      const after = { production: LEDGER, chapter: "neap" };
      await send({ kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "characters", id: "maren-kest", entry: { public: true, sections: { Essence: { public: true }, Relationships: { public: true, after } } } } });
      await send({ kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "locations", id: "the-vigil", entry: { public: true, sections: { Look: { public: true } } } } });
      await send({ kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "lore", id: "CANON-001", entry: { public: true, after } } });
      // An open thread turned on by hand still never ships (R-3).
      await send({ kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "lore", id: "CANON-044", entry: { public: true } } });

      const result = await exportPackage(send, events, 6);
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      assert.equal(result.guide, true);
      const file = join(worldDir, ...result.file.split("/"));
      const checked = await checkWorldPackageZip(file);
      assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
      const opened = readWorldManifest(await entry(file, "world.json"));
      assert.ok(opened.ok);
      assert.equal(opened.manifest.schemaVersion, 3);
      assert.equal(opened.manifest.guide, "guide");
      const readBack = readGuide(await entry(file, "guide/guide.json"), opened.manifest.assets);
      assert.ok(readBack.ok, readBack.ok ? "" : readBack.reason);
      const guide = readBack.guide;
      assert.deepEqual(guide.characters.map((character) => character.id), ["maren-kest"]);
      const maren = guide.characters[0]!;
      assert.equal(opened.manifest.assets[maren.portrait!]?.mediaType.startsWith("image/"), true);
      assert.deepEqual(maren.sections.map((section) => [section.heading, guideChapterNumber(guide, section.after)]), [["Essence", null], ["Relationships", 1]]);
      assert.doesNotMatch(JSON.stringify(guide), /Room note/);
      assert.deepEqual(guide.lore.map((lore) => lore.id), ["canon-001"]);
      // A reader in the book finds the chapter by its document.
      assert.equal(guide.productions[0]?.chapters.find((chapter) => chapter.id === "neap")?.book, "OEBPS/chapter-1.xhtml");
      // Its pictures are fitted for a phone's page: no longer than 1024 px on a side (R-13).
      assert.ok(calls.some((args) => args.includes("-vf") && args[args.indexOf("-vf") + 1]!.includes("min(1024,iw)")));
      assert.match(JSON.parse(await readFile(`${file}.json`, "utf8")).holds, /the guide/);
    }, recordingFfmpeg(calls));
  });

  it("carries a moment's Tall beside its picture, and fits the narration's pictures to the chosen Size (turn 235, SPEC-058 R-37, R-41, R-42)", () => {
    const calls: string[][] = [];
    return withHarness(async ({ worldDir, events, send, store }) => {
      await read(send, "01-neap");
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "world-art.png", source: "world" }, requestId: "01J00000000000000000000003" });
      // The Tall is made in the next slice; here it is written as that slice will write it.
      const { chapter } = await planAudiobook(store(), LEDGER, "neap", { narrator: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" } });
      await updateAudiobook(store(), LEDGER, chapter, (current) => ({ ...current, pictures: { ...current.pictures, "p1.0": { ...current.pictures!["p1.0"]!, tall: { file: "references/maren-kest/body-full.png", at: "2026-10-23T09:00:00.000Z", from: "world-art.png" } } } }));

      const result = await exportPackage(send, events, 8, { book: false, motion: true, size: "960" });
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      const file = join(worldDir, ...result.file.split("/"));
      const opened = readWorldManifest(await entry(file, "world.json"));
      assert.ok(opened.ok);
      const listening = readListening(await entry(file, "listening.json"), opened.manifest.assets);
      assert.ok(listening.ok, listening.ok ? "" : listening.reason);
      const shown = listening.document.chapters[0]!.pictures!.find((picture) => picture.tall !== undefined);
      assert.ok(shown, "the moment names its Tall");
      assert.notEqual(shown.tall, shown.picture);
      assert.equal(opened.manifest.assets[shown.tall!]?.mediaType.startsWith("image/"), true);

      // The narration's pictures at 960 on the long side; the key art stays full (R-41).
      const fits = calls.filter((args) => args.includes("-vf") && args[args.indexOf("-vf") + 1]!.startsWith("scale='min("));
      assert.ok(fits.some((args) => args[args.indexOf("-vf") + 1]!.includes("min(960,iw)")), "the moments at 960");
      assert.ok(fits.some((args) => args[args.indexOf("-vf") + 1]!.includes("min(2048,iw)")), "the key art at full");
      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: "01J00000000000000000000004" });
      const listed = events.filter((event): event is Listed => event.type === "web-packages.listed").at(-1)!;
      assert.match(listed.packages.find((entry) => entry.exportId === exportId(8))?.holds ?? "", /· 1 tall/);
    }, recordingFfmpeg(calls));
  });

  it("lists a package only by a whole record beside it, at the length it records (233e)", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => "2026-10-21T09:00:00.000Z" });
    await provider.loadWorld(WORLD_ID);
    try {
      await mkdir(join(worldDir, "exports"), { recursive: true });
      const record = { kind: "arke-player", exportId: "ap_01J8G000000000000000000001", exportedAt: "2026-10-21T09:00:00.000Z", productionId: LEDGER, title: "The Undersong", bytes: 4, sha256: "a".repeat(64), holds: "the book", chapters: 0, pictures: 0, book: true };
      await writeFile(join(worldDir, "exports", "the-undersong-player-2026-10-21.zip"), "zip!");
      await writeFile(join(worldDir, "exports", "the-undersong-player-2026-10-21.zip.json"), JSON.stringify(record));
      // A record edited by hand, missing what Publications needs, and one whose package has grown.
      await writeFile(join(worldDir, "exports", "the-undersong-player-2026-10-21-2.zip"), "zip!");
      await writeFile(join(worldDir, "exports", "the-undersong-player-2026-10-21-2.zip.json"), JSON.stringify({ ...record, productionId: undefined }));
      await writeFile(join(worldDir, "exports", "the-undersong-player-2026-10-21-3.zip"), "zip!!");
      await writeFile(join(worldDir, "exports", "the-undersong-player-2026-10-21-3.zip.json"), JSON.stringify(record));
      const listed = await listArkePlayerPackages(provider.openStore!()!);
      assert.deepEqual(listed.map((entry) => entry.file), ["exports/the-undersong-player-2026-10-21.zip"]);
    } finally {
      await provider.close();
    }
  });

  it("names a world by its slug, within a package's vocabulary", () => {
    assert.equal(packageSlug("the-undersong"), "the-undersong");
    assert.equal(packageSlug(`a-${"b".repeat(80)}`).length, 64);
  });

  it("makes Text's phrases from a block's sentences, or from its measured words (R-11)", () => {
    const block = (overrides: Partial<ListeningBlock>): ListeningBlock => ({ key: "p0.0", number: 2, file: "take.wav", at: 10, seconds: 10, sentences: [{ at: 10, text: "First one. Then a second, twice as long." }], ...overrides });
    const estimated = phrasesOf([block({})], 60_000);
    assert.deepEqual(estimated.map((phrase) => phrase.text), ["First one.", "Then a second, twice as long."]);
    assert.equal(estimated[0]!.at, 10_000);
    assert.equal(estimated[1]!.end, 20_000);
    assert.ok(estimated[0]!.end < estimated[1]!.end && estimated[0]!.end === estimated[1]!.at, "back to back, by length");

    const measured = phrasesOf([block({ words: [{ text: "First", startSec: 10.1, endSec: 10.4, probability: 1 }, { text: "one.", startSec: 10.4, endSec: 10.9, probability: 1 }, { text: "Then", startSec: 11.5, endSec: 11.8, probability: 1 }] })], 60_000);
    assert.deepEqual(measured.map((phrase) => [phrase.text, phrase.at, phrase.end, phrase.words?.length]), [["First one.", 10_100, 10_900, 2], ["Then", 11_500, 11_800, 1]]);

    // Measured words that overlap are kept in order: one starts as the last ends (R-13).
    const overlapping = phrasesOf([block({ words: [{ text: "Slack", startSec: 10, endSec: 10.6, probability: 1 }, { text: "water.", startSec: 10.5, endSec: 11, probability: 1 }] })], 60_000);
    assert.deepEqual(overlapping[0]!.words!.map((word) => [word.at, word.end]), [[10_000, 10_600], [10_600, 11_000]]);
  });

  it("splits a sentence longer than a phrase into pieces that follow one another, losing nothing (R-11)", () => {
    const long = `${Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ")}.`;
    assert.ok(long.length > 4000);
    const phrases = phrasesOf([{ key: "p0.0", number: 2, file: "take.wav", at: 0, seconds: 300, sentences: [{ at: 0, text: long }] }], 300_000);
    assert.ok(phrases.length >= 3);
    assert.ok(phrases.every((phrase) => phrase.text.length <= 2000));
    assert.equal(phrases.map((phrase) => phrase.text).join(" "), long);
    assert.ok(phrases.every((phrase, index) => index === 0 || phrase.at === phrases[index - 1]!.end), "back to back");
    assert.equal(phrases.at(-1)!.end, 300_000);
  });
});

describe("the credits inside the first and last chapters (design turn 252, SPEC-058 R-94)", () => {
  it("opens the first chapter with the opening credits over the cover and closes the last with the closing, with no new key", () =>
    withHarness(async ({ worldDir, events, send }) => {
      await send({ kind: "set-audiobook-credits", worldId: WORLD_ID, productionId: LEDGER, details: { author: "Michael Josiah", narrator: "Ife Balogun" } });
      await read(send, "audiobook-credits");
      await read(send, "01-neap");
      const result = await exportPackage(send, events, 40);
      assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
      const file = join(worldDir, ...result.file.split("/"));
      const checked = await checkWorldPackageZip(file);
      assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
      const opened = readWorldManifest(await entry(file, "world.json"));
      assert.ok(opened.ok);
      const listening = readListening(await entry(file, "listening.json"), opened.manifest.assets);
      assert.ok(listening.ok, listening.ok ? "" : listening.reason);
      const chapter = listening.document.chapters[0]!;
      const phrases = chapter.phrases ?? [];
      const heard = phrases.map((phrase) => phrase.text).join(" ");
      assert.ok(heard.startsWith("The Ledger of Nights. Written by Michael Josiah. Narrated by Ife Balogun."), "the opening is heard first");
      assert.equal(phrases[0]!.at, 0);
      assert.ok(heard.endsWith("The End."), "the closing is heard last");
      const pictures = chapter.pictures ?? [];
      assert.equal(pictures[0]!.at, 0, "the cover shows over the opening");
      assert.equal(pictures.at(-1)!.picture, pictures[0]!.picture, "and again over the closing");
      assert.ok(phrases.every((phrase, index, all) => index === 0 || phrase.at >= all[index - 1]!.end), "phrases follow one another");
    }, recordingFfmpeg([])));
});
