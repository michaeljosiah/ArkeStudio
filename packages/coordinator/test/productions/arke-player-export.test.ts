import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openPromise } from "yauzl";
import { readListening, readWorldManifest, type ClientMessage, type DomainEvent, type ListeningBlock, type ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { phrasesOf } from "../../src/productions/arke-player-listening.js";
import { listArkePlayerPackages, packageSlug, pngHasAlpha, webpHasAlpha } from "../../src/productions/arke-player-export.js";
import { checkWorldPackageZip } from "../../src/productions/world-package.js";
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

async function withHarness(run: (h: { worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void> }) => Promise<void>, ffmpeg?: FfmpegRunner): Promise<void> {
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
    await run({ worldDir, events, send });
  } finally {
    await provider.close();
  }
}

const read = (send: (message: ClientMessage) => Promise<void>, chapterFile: string) => send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile });
const exportId = (n: number) => `ap_01J8G00000000000000000000${n}`;
async function exportPackage(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[], n: number, options = { book: true, motion: true }): Promise<Exported["result"]> {
  await send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: LEDGER, requestId: "01J00000000000000000000001", exportId: exportId(n), options });
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
