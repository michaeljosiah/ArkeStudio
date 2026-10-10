import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AudiobookListeningSchema,
  DEFAULT_VIDEO_OPTIONS,
  type AudiobookVideoOptions,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_PICTURE_FOCUS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { exportAudiobookVideo, forgetVideoJob, pendingVideoJobs, readPictureSize, videoCacheFolder } from "../../src/productions/audiobook-video.js";
import type { WorldStore } from "../../src/world/store.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { anyNarrator } from "../../src/productions/audiobook-listening.js";
import { planAudiobook } from "../../src/productions/audiobook.js";
import { quoteAudiobookMotion, saveAudiobookMotionCandidate, chooseAudiobookMotion } from "../../src/productions/audiobook-motion.js";
import { prepareAudiobookWordTiming } from "../../src/productions/audiobook-word-timing.js";

/**
 * The audiobook as a video (design turn 197): rendered for real through the ffmpeg the app ships,
 * where this checkout has it (`apps/desktop/build-resources/ffmpeg`, or `ARKE_FFMPEG`), and read
 * back with its ffprobe: the streams, the length, the chapter markers, the text track. Without a
 * binary the render tests skip; the rest run on any machine.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CLOCK = "2026-10-04T20:41:00.000Z";
const LEDGER = "the-ledger-of-nights";
const REQUEST = "01J00000000000000000000001";
const FONT = resolve(here, "../../../../apps/desktop/assets/Geist-Regular.ttf");
const BUNDLED = resolve(here, "../../../../apps/desktop/build-resources/ffmpeg/ffmpeg.exe");
const FFMPEG = process.env["ARKE_FFMPEG"] ?? (existsSync(BUNDLED) ? BUNDLED : null);
const FFPROBE = FFMPEG === null ? null : join(dirname(FFMPEG), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const skip = FFMPEG === null || !existsSync(FFMPEG) ? "no bundled ffmpeg in this checkout" : false;

const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};

/** A second of a quiet tone at the readers' rate: a take a mix can be heard in. */
function tone(seconds = 1): Uint8Array {
  const rate = 24_000;
  const samples = Math.round(rate * seconds);
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 6000), 44 + i * 2);
  return new Uint8Array(out);
}

/** The shipped binary run as the desktop runs it, with ffmpeg's clock read off its progress lines. */
function realRunner(calls: string[][]): FfmpegRunner {
  return {
    slateFont: FONT,
    run: (args, onProgress, signal, onSeconds) =>
      new Promise<void>((done, fail) => {
        calls.push(args);
        if (signal.aborted) return fail(new Error("cancelled before start"));
        const child = spawn(FFMPEG!, ["-hide_banner", ...args], { windowsHide: true });
        let tail = "";
        const abort = () => child.kill("SIGKILL");
        signal.addEventListener("abort", abort, { once: true });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          tail = (tail + text).slice(-4000);
          const match = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
          if (match) {
            const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
            onProgress(Math.min(99, seconds));
            onSeconds?.(seconds);
          }
        });
        child.on("error", fail);
        child.on("exit", (code) => {
          signal.removeEventListener("abort", abort);
          if (code === 0) done();
          else fail(new Error(`ffmpeg exited ${code}: ${tail.split("\n").filter((line) => !/^\w+=/.test(line)).join("\n").slice(-1500)}`));
        });
      }),
  };
}

interface Probe {
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; sample_rate?: string; channels?: number }>;
  format: { duration: string };
  chapters: Array<{ start_time: string; end_time: string; tags?: { title?: string } }>;
}

function probe(file: string): Promise<Probe> {
  return new Promise((done, fail) => {
    const child = spawn(FFPROBE!, ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", file], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done(JSON.parse(out) as Probe) : fail(new Error(`ffprobe exited ${code}`))));
  });
}

/** One frame of the file as raw grey, for a look at what it shows. */
function frameLuma(file: string, at: number, width: number, height: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = spawn(FFMPEG!, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done(Buffer.concat(chunks)) : fail(new Error(`ffmpeg exited ${code}`))));
  });
}

type Harness = { root: string; worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; store: () => WorldStore; coordinator: Coordinator; calls: string[][] };

async function withHarness(run: (h: Harness) => Promise<void>, options: { ffmpeg?: boolean } = {}): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const calls: string[][] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-04", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    mediaProbe: { durationSec: async () => 1, info: async () => ({ durationSec: 1, hasAudio: true }) },
    ...(options.ffmpeg === true ? { ffmpeg: realRunner(calls) } : {}),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async () => tone(),
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
    await run({ root, worldDir, events, send, store: () => provider.openStore!()!, coordinator, calls });
  } finally {
    await provider.close();
  }
}

const read = (send: Harness["send"], chapterFile: string, blocks?: string[]) =>
  send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile, ...(blocks !== undefined ? { blocks } : {}) });

type Exported = Extract<DomainEvent, { type: "audiobook.video-exported" }>;
type State = Extract<DomainEvent, { type: "audiobook.video-state" }>;
type Progress = Extract<DomainEvent, { type: "export.progress" }>;

let ids = 0;
const exportId = () => `vb_01J8G${String(++ids).padStart(21, "0")}`;

async function render(h: Harness, options: Partial<AudiobookVideoOptions>): Promise<Exported> {
  const id = exportId();
  await h.send({ kind: "export-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, exportId: id, options: { ...DEFAULT_VIDEO_OPTIONS, ...options } });
  const answer = h.events.filter((e): e is Exported => e.type === "audiobook.video-exported" && e.exportId === id).at(-1);
  assert.ok(answer, "the render is answered");
  return answer;
}

const near = (actual: number, expected: number, within: number, what: string) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);

describe("the audiobook as a video (turn 197)", () => {
  it("keeps a chapter's video scope through readiness, cache reuse, job recovery and delivery receipts", () =>
    withHarness(async (h) => {
      await read(h.send, "01-neap");
      await read(h.send, "02-the-same-ink", ["title"]);
      await read(h.send, "04-her-own-hand");
      const scope = { kind: "chapter" as const, chapterId: "neap" };
      await h.send({ kind: "read-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, options: { ...DEFAULT_VIDEO_OPTIONS, scope } });
      const state = h.events.filter((event): event is State => event.type === "audiobook.video-state").at(-1)!.state!;
      assert.deepEqual(state.scope, scope);
      assert.deepEqual(state.chapters.map((chapter) => chapter.chapterId), ["neap"]);
      // This test exercises selection, filenames and cache boundaries; codec quality is covered
      // by the real ffmpeg cases below. A stand-in writes exactly the output the service asks for.
      const ffmpeg: FfmpegRunner = { slateFont: FONT, run: async (args) => { await writeFile(args[args.length - 1]!, "video"); } };
      const context = () => ({ ffmpeg, clock: () => CLOCK, exportId: exportId(), signal: new AbortController().signal });
      const selected = await exportAudiobookVideo(h.store(), LEDGER, { ...DEFAULT_VIDEO_OPTIONS, scope, files: "book" }, context());
      assert.ok(selected.ok, JSON.stringify(selected));
      assert.deepEqual(selected.scope, scope);
      assert.deepEqual(selected.chapterIds, ["neap"]);
      assert.equal(selected.files.length, 1);
      assert.deepEqual(selected.files[0]!.chapterIds, ["neap"]);
      assert.match(selected.files[0]!.name, /01-neap\.mp4$/);
      const book = await exportAudiobookVideo(h.store(), LEDGER, DEFAULT_VIDEO_OPTIONS, context());
      assert.ok(book.ok, JSON.stringify(book));
      assert.equal(book.made, 1, "the selected chapter's identical encode is reused by the book");
      assert.notEqual(book.dir, selected.dir, "whole-book delivery cannot overwrite the chapter receipt");
      const manifest = JSON.parse(await readFile(join(h.worldDir, selected.dir, "video.json"), "utf8"));
      assert.deepEqual(manifest.scope, scope);
      assert.deepEqual(manifest.chapterIds, ["neap"]);
      await h.send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: REQUEST });
      const listed = h.events.filter((event): event is Extract<DomainEvent, { type: "web-packages.listed" }> => event.type === "web-packages.listed").at(-1)!.packages.find((entry) => entry.dir === selected.dir)!;
      assert.deepEqual(listed.scope, scope);
      assert.deepEqual(listed.chapterIds, ["neap"], "the saved chapter delivery survives a book render and reconnect");
      const incompleteScope = { kind: "chapter" as const, chapterId: "the-same-ink" };
      const incomplete = await exportAudiobookVideo(h.store(), LEDGER, { ...DEFAULT_VIDEO_OPTIONS, scope: incompleteScope }, context());
      assert.equal(incomplete.ok, false);
      if (!incomplete.ok) assert.match(incomplete.blockers.join(" "), /this chapter is not read whole yet/);
      await assert.rejects(exportAudiobookVideo(h.store(), LEDGER, { ...DEFAULT_VIDEO_OPTIONS, scope: { kind: "chapter", chapterId: "gone" } }, context()), /no longer in this production/);
      const pending = { exportId: exportId(), startedAt: CLOCK, options: { ...DEFAULT_VIDEO_OPTIONS, scope } };
      await writeFile(join(h.worldDir, videoCacheFolder(LEDGER), "job.json"), JSON.stringify(pending));
      assert.deepEqual((await pendingVideoJobs(h.store()))[0]?.options.scope, scope, "a restart resumes exactly the selected chapter");
      await forgetVideoJob(h.store(), LEDGER);
    }));

  it("says what a render would make before anything is made, and refuses on a machine with no ffmpeg", () =>
    withHarness(async (h) => {
      await read(h.send, "01-neap");
      await read(h.send, "02-the-same-ink", ["title", "p0.0"]);
      await h.send({ kind: "read-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, options: DEFAULT_VIDEO_OPTIONS });
      const state = h.events.filter((e): e is State => e.type === "audiobook.video-state").at(-1)!;
      assert.equal(state.refused, undefined);
      assert.deepEqual(state.state?.chapters.map((chapter) => [chapter.chapterId, chapter.rendered]), [["neap", false]], "only the chapter read whole, not yet rendered");
      assert.ok((state.state?.chapters[0]?.seconds ?? 0) > 3);
      assert.match(state.state?.readBy ?? "", /^Read by George’s voice$/);
      const answer = await render(h, {});
      assert.deepEqual(answer.result, { ok: false, blockers: ["making a video needs ffmpeg, which this machine does not have"] });
    }));

  it("keeps a picture's focus on the picture, past the build before it, and back to the centre", () =>
    withHarness(async (h) => {
      await read(h.send, "01-neap");
      await h.send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
      const before = h.store().getBundle().meta.schemaVersion;
      assert.ok(before < AUDIOBOOK_PICTURE_FOCUS_SCHEMA_VERSION);
      await h.send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: { x: 0.62, y: 0.42 }, requestId: REQUEST });
      const record = h.events.filter((e): e is Extract<DomainEvent, { type: "audiobook.record" }> => e.type === "audiobook.record").at(-1)!;
      assert.equal(record.refused, undefined);
      assert.deepEqual(record.record?.pictures?.["p1.0"]?.focus, { x: 0.62, y: 0.42 });
      assert.equal(h.store().getBundle().meta.schemaVersion, AUDIOBOOK_PICTURE_FOCUS_SCHEMA_VERSION, "raised before the first focus");
      await h.send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST });
      const listening = AudiobookListeningSchema.parse(h.events.filter((e): e is Extract<DomainEvent, { type: "audiobook.listening" }> => e.type === "audiobook.listening").at(-1)!.listening);
      assert.deepEqual(listening.chapters[0]!.pictures[0]!.focus, { x: 0.62, y: 0.42 }, "the plan carries it to the preview and the render");
      await h.send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: null });
      const raw = JSON.parse(await readFile(join(h.worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")) as { pictures: Record<string, Record<string, unknown>> };
      assert.equal("focus" in raw.pictures["p1.0"]!, false, "the centre is no field");
      await h.send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p0.0", focus: { x: 0.5, y: 0.5 } });
      assert.match(h.events.filter((e): e is Extract<DomainEvent, { type: "audiobook.record" }> => e.type === "audiobook.record").at(-1)!.refused ?? "", /no picture/);
    }));

  it("renders a chapter to MP4 through the shipped ffmpeg: H.264 4:2:0 at 30, AAC 48 kHz, a text track, a chapter marker, the sidecars, a receipt", { skip }, () =>
    withHarness(
      async (h) => {
        await read(h.send, "01-neap");
        await h.send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
        await h.send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST });
        const answer = await render(h, { shape: "1280x720", subtitles: "burn-in+sidecar" });
        assert.ok(answer.result.ok, JSON.stringify(answer.result));
        const { dir, files, made } = answer.result;
        assert.equal(made, 1);
        assert.match(dir, /^exports\/the-ledger-of-nights-video-20261004$/);
        assert.deepEqual(files.map((file) => [file.name, file.shape, file.sidecars]), [["the-ledger-of-nights-01-neap.mp4", "1280x720", [".srt", ".vtt"]]]);
        assert.equal(files[0]!.picture, "artifacts/board-v2.png", "the thumbnail is the chapter's first picture");
        const file = join(h.worldDir, dir, files[0]!.name);
        assert.equal((await stat(file)).size, files[0]!.bytes);
        const info = await probe(file);
        const video = info.streams.find((s) => s.codec_type === "video")!;
        assert.deepEqual([video.codec_name, video.width, video.height, video.pix_fmt, video.avg_frame_rate], ["h264", 1280, 720, "yuv420p", "30/1"]);
        const audio = info.streams.find((s) => s.codec_type === "audio")!;
        assert.deepEqual([audio.codec_name, audio.sample_rate, audio.channels], ["aac", "48000", 2]);
        assert.equal(info.streams.find((s) => s.codec_type === "subtitle")?.codec_name, "mov_text", "the text track");
        near(Number(info.format.duration), files[0]!.seconds, 0.1, "the file is the chapter's length");
        assert.equal(info.chapters.length, 1);
        assert.equal(info.chapters[0]!.tags?.title, "Neap");
        const srt = await readFile(join(h.worldDir, dir, "the-ledger-of-nights-01-neap.srt"), "utf8");
        assert.match(srt, /^1\n00:00:00,000 --> /);
        assert.ok(srt.trim().split("\n\n").every((cue) => cue.split("\n").slice(2).every((line) => line.length <= 42) && cue.split("\n").length <= 4), `at most two lines of 42: ${srt}`);
        assert.match(await readFile(join(h.worldDir, dir, "the-ledger-of-nights-01-neap.vtt"), "utf8"), /^WEBVTT\n\n00:00:00\.000 --> /);
        // The opening is the title card over the picture blurred; the picture itself comes after.
        const card = await frameLuma(file, 0.5, 64, 36);
        const picture = await frameLuma(file, files[0]!.seconds - 0.5, 64, 36);
        const mean = (frame: Buffer) => frame.reduce((sum, value) => sum + value, 0) / frame.length;
        assert.ok(mean(card) < mean(picture), `the card is dimmed: ${mean(card)} against ${mean(picture)}`);

        const progress = h.events.filter((e): e is Progress => e.type === "export.progress" && e.deliveryKind === "audiobook-video");
        assert.equal(progress[0]!.status, "running");
        assert.equal(progress.at(-1)!.status, "done");
        assert.equal(progress.at(-1)!.percent, 100);
        assert.equal(progress.at(-1)!.output, `${dir}/${files[0]!.name}`);
        assert.equal(progress.at(-1)!.video?.title, "The Ledger of Nights");
        const percents = progress.map((event) => event.percent);
        assert.deepEqual(percents, [...percents].sort((a, b) => a - b), "the percent only rises");
        const receipts = await readdir(join(h.worldDir, "exports", ".completed"));
        assert.ok(receipts.includes(`${answer.exportId}.json`), "a receipt as every export's");
        assert.deepEqual(await pendingVideoJobs(h.store()), [], "nothing left to resume");

        await h.send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: REQUEST });
        const listed = h.events.filter((e): e is Extract<DomainEvent, { type: "web-packages.listed" }> => e.type === "web-packages.listed").at(-1)!;
        assert.deepEqual(listed.packages.map((entry) => [entry.kind, entry.dir]), [["audiobook-video", dir]], "Publications lists the video");

        // Render again: nothing changed, nothing encoded; then a focus moved remakes the chapter.
        const encodes = () => h.calls.filter((args) => args.includes("-/filter_complex")).length;
        const before = encodes();
        const again = await render(h, { shape: "1280x720", subtitles: "burn-in+sidecar" });
        assert.ok(again.result.ok);
        assert.equal(again.result.made, 0, "Render again with nothing changed makes nothing");
        assert.equal(encodes(), before);
        await h.send({ kind: "read-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, options: { ...DEFAULT_VIDEO_OPTIONS, shape: "1280x720", subtitles: "burn-in+sidecar" } });
        assert.deepEqual(h.events.filter((e): e is State => e.type === "audiobook.video-state").at(-1)!.state?.chapters.map((chapter) => chapter.rendered), [true]);
        const rates = JSON.parse(await readFile(join(h.root, "audiobook-video-rates.json"), "utf8")) as Record<string, { bytesPerSec: number; speed: number }>;
        assert.ok(rates["1280x720/push"]!.bytesPerSec > 0 && rates["1280x720/push"]!.speed > 0, "this machine's rate, measured");
        await h.send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: { x: 0.2, y: 0.5 } });
        const moved = await render(h, { shape: "1280x720", subtitles: "burn-in+sidecar" });
        assert.ok(moved.result.ok);
        assert.equal(moved.result.made, 1, "a focus moved is a new picture to the cache");
        const pieces = await readdir(join(h.worldDir, videoCacheFolder(LEDGER), "neap"));
        assert.equal(pieces.length, 2, "a chapter keeps its newest two pieces");
      },
      { ffmpeg: true },
    ));

  it("fills the frame with a 3:2 picture at 16:9 and at 9:16, cropped around its focus, and burns two lines at most", { skip }, () =>
    withHarness(
      async (h) => {
        await read(h.send, "01-neap");
        // A 3:2 picture as Na love or Juju's are (1536 × 1024, here 600 × 400): white on its left
        // half, black on its right, so a frame shows where the crop stands and whether bars came back.
        await new Promise<void>((done, fail) => {
          const child = spawn(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=600x400,drawbox=x=300:y=0:w=300:h=400:color=black:t=fill", "-frames:v", "1", join(h.worldDir, "artifacts", "board-v2.png")], { windowsHide: true });
          child.on("error", fail);
          child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`))));
        });
        assert.deepEqual(await readPictureSize(join(h.worldDir, "artifacts", "board-v2.png")), { width: 600, height: 400 });
        await h.send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
        const column = (frame: Buffer, width: number, height: number, x: number) => Array.from({ length: height }, (_, y) => frame[y * width + x]!);
        const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

        // 16:9 with Slow push: the picture covers the frame; its left edge is the picture's white,
        // not a bar, at the start of the hold and at its end.
        const wide = await render(h, { shape: "1280x720", subtitles: "burn-in+sidecar", titleCards: false });
        assert.ok(wide.result.ok, JSON.stringify(wide.result));
        const wideFile = join(h.worldDir, wide.result.dir, wide.result.files[0]!.name);
        const seconds = wide.result.files[0]!.seconds;
        for (const at of [seconds * 0.55, seconds - 0.1]) {
          const frame = await frameLuma(wideFile, at, 64, 36);
          assert.ok(mean(column(frame, 64, 36, 0).slice(0, 18)) > 200, `the left edge is picture, not a bar, at ${at}`);
          assert.ok(mean(column(frame, 64, 36, 63).slice(0, 18)) < 40, `the right edge is the picture's black half at ${at}`);
          assert.ok(mean(Array.from({ length: 30 }, (_, x) => frame[x]!)) > 200, "the top row is picture");
        }
        const srt = await readFile(join(h.worldDir, wide.result.dir, wide.result.files[0]!.name.replace(/\.mp4$/, ".srt")), "utf8");
        for (const cue of srt.trim().split(/\n\n/)) assert.ok(cue.split("\n").length <= 4, `two lines at most: ${cue}`);

        // 9:16: a full-height column around the focus — on the white half, then the black.
        await h.send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: { x: 0.25, y: 0.5 } });
        const left = await render(h, { shape: "1080x1920", slowPush: false, subtitles: "none", titleCards: false });
        assert.ok(left.result.ok, JSON.stringify(left.result));
        const leftFrame = await frameLuma(join(h.worldDir, left.result.dir, left.result.files[0]!.name), left.result.files[0]!.seconds - 0.2, 18, 32);
        assert.ok(Math.min(...leftFrame) > 200, "the column stands on the white half, edge to edge");
        await h.send({ kind: "set-audiobook-picture-focus", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", focus: { x: 0.8, y: 0.5 } });
        const right = await render(h, { shape: "1080x1920", slowPush: false, subtitles: "none", titleCards: false });
        assert.ok(right.result.ok, JSON.stringify(right.result));
        const rightFrame = await frameLuma(join(h.worldDir, right.result.dir, right.result.files[0]!.name), right.result.files[0]!.seconds - 0.2, 18, 32);
        assert.ok(Math.max(...rightFrame) < 40, "and moved, on the black half");
      },
      { ffmpeg: true },
    ));

  it("reads a picture's size from its header, and none from a JPEG that says it is turned", async () => {
    const { root } = await makeTempRoot();
    const jpeg = (orientation: number | null) => {
      const exif = orientation === null ? Buffer.alloc(0) : (() => {
        const tiff = Buffer.alloc(26);
        tiff.write("MM", 0, "latin1");
        tiff.writeUInt16BE(42, 2);
        tiff.writeUInt32BE(8, 4);
        tiff.writeUInt16BE(1, 8);
        tiff.writeUInt16BE(0x0112, 10);
        tiff.writeUInt16BE(3, 12);
        tiff.writeUInt32BE(1, 14);
        tiff.writeUInt16BE(orientation, 18);
        const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
        const head = Buffer.from([0xff, 0xe1, 0, 0]);
        head.writeUInt16BE(body.length + 2, 2);
        return Buffer.concat([head, body]);
      })();
      const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, 0x04, 0x00, 0x06, 0x00, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
      return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, frame, Buffer.from([0xff, 0xd9])]);
    };
    await writeFile(join(root, "plain.jpg"), jpeg(null));
    await writeFile(join(root, "upright.jpg"), jpeg(1));
    await writeFile(join(root, "turned.jpg"), jpeg(6));
    assert.deepEqual(await readPictureSize(join(root, "plain.jpg")), { width: 1536, height: 1024 });
    assert.deepEqual(await readPictureSize(join(root, "upright.jpg")), { width: 1536, height: 1024 });
    assert.equal(await readPictureSize(join(root, "turned.jpg")), null, "cropped in ffmpeg's own terms instead");
    assert.equal(await readPictureSize(join(root, "missing.png")), null);
  });

  it("joins one file for the book from the cached chapters: the cover first, a marker a chapter, the vertical crop", { skip }, () =>
    withHarness(
      async (h) => {
        await read(h.send, "01-neap");
        await read(h.send, "03-nothing-wrong-with-it");
        await h.send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", picture: { file: "artifacts/board-v2.png", source: "scenes" }, requestId: REQUEST });
        const answer = await render(h, { files: "book", shape: "1080x1920", slowPush: false, subtitles: "sidecar", titleCards: false });
        assert.ok(answer.result.ok, JSON.stringify(answer.result));
        assert.deepEqual(answer.result.files.map((file) => file.name), ["the-ledger-of-nights.mp4"]);
        const info = await probe(join(h.worldDir, answer.result.dir, "the-ledger-of-nights.mp4"));
        const video = info.streams.find((s) => s.codec_type === "video")!;
        assert.deepEqual([video.width, video.height], [1080, 1920]);
        assert.equal(info.streams.find((s) => s.codec_type === "subtitle")?.codec_name, "mov_text");
        assert.deepEqual(info.chapters.map((chapter) => chapter.tags?.title), ["Neap", "Nothing wrong with it"]);
        // An MP4's chapter track starts at the top, so the opening is the first chapter's; the
        // second starts after the cover's five seconds and the whole of the first.
        await h.send({ kind: "read-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, options: DEFAULT_VIDEO_OPTIONS });
        const neap = h.events.filter((e): e is State => e.type === "audiobook.video-state").at(-1)!.state!.chapters[0]!.seconds;
        assert.equal(Number(info.chapters[0]!.start_time), 0);
        near(Number(info.chapters[1]!.start_time), 5 + neap, 0.01, "the second chapter's marker");
        near(Number(info.format.duration), answer.result.files[0]!.seconds, 0.3, "the book's length");
        assert.equal(answer.result.made, 2);
        const srt = await readFile(join(h.worldDir, answer.result.dir, "the-ledger-of-nights.srt"), "utf8");
        assert.match(srt, /^1\n00:00:05,000 --> /, "the words start after the opening");
      },
      { ffmpeg: true },
    ));

  it("keeps the finished chapters on Cancel and forgets the render; a render the app closed under is resumed", { skip }, () =>
    withHarness(
      async (h) => {
        await read(h.send, "01-neap");
        await read(h.send, "03-nothing-wrong-with-it");
        // Cancel once the second chapter is encoding: the first is kept, the second is not.
        const id = exportId();
        const started = h.send({ kind: "export-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, exportId: id, options: { ...DEFAULT_VIDEO_OPTIONS, shape: "1280x720", slowPush: false } });
        for (let i = 0; i < 600; i++) {
          const second = h.events.some((e) => e.type === "export.progress" && e.exportId === id && e.video?.chapter === 2);
          if (second) break;
          await new Promise((wait) => setTimeout(wait, 50));
        }
        await h.send({ kind: "cancel-export", worldId: WORLD_ID, exportId: id });
        await started;
        const answer = h.events.filter((e): e is Exported => e.type === "audiobook.video-exported" && e.exportId === id).at(-1)!;
        assert.deepEqual(answer.result, { ok: false, blockers: ["the render was cancelled"] });
        const folder = join(h.worldDir, "exports", "the-ledger-of-nights-video-20261004");
        assert.deepEqual((await readdir(folder)).filter((name) => name.endsWith(".mp4")), ["the-ledger-of-nights-01-neap.mp4"], "the finished chapter is kept, the partial one is not");
        assert.deepEqual(await pendingVideoJobs(h.store()), [], "a Cancel forgets the render");
        assert.equal(h.events.filter((e): e is Progress => e.type === "export.progress" && e.exportId === id).at(-1)!.status, "cancelled");
        // A render the same day cancelled before it has placed anything leaves the day's folder as it was.
        const stopped = new AbortController();
        stopped.abort();
        assert.deepEqual(await exportAudiobookVideo(h.store(), LEDGER, { ...DEFAULT_VIDEO_OPTIONS, shape: "1280x720", slowPush: false }, { ffmpeg: realRunner([]), clock: () => CLOCK, exportId: exportId(), signal: stopped.signal }), { ok: false, blockers: ["the render was cancelled"] });
        assert.deepEqual((await readdir(folder)).filter((name) => name.endsWith(".mp4")), ["the-ledger-of-nights-01-neap.mp4"], "the earlier render's file stays");
        await forgetVideoJob(h.store(), LEDGER);

        // The app closing under a render: the note stays, and the next start resumes it, making
        // only the chapter not yet made.
        const control = new AbortController();
        const closing = exportAudiobookVideo(h.store(), LEDGER, { ...DEFAULT_VIDEO_OPTIONS, shape: "1280x720", slowPush: false }, {
          ffmpeg: realRunner([]),
          clock: () => CLOCK,
          exportId: exportId(),
          signal: control.signal,
          onProgress: (place) => {
            if (place.chapter === 2) control.abort();
          },
        });
        assert.deepEqual(await closing, { ok: false, blockers: ["the render was cancelled"] });
        const pending = await pendingVideoJobs(h.store());
        assert.equal(pending.length, 1, "the note stays for the next start");
        (h.coordinator as unknown as { resumeAudiobookVideos(store: WorldStore): void }).resumeAudiobookVideos(h.store());
        for (let i = 0; i < 1200; i++) {
          if (h.events.some((e) => e.type === "audiobook.video-exported" && e.exportId === pending[0]!.exportId)) break;
          await new Promise((wait) => setTimeout(wait, 50));
        }
        const resumed = h.events.filter((e): e is Exported => e.type === "audiobook.video-exported" && e.exportId === pending[0]!.exportId).at(-1);
        assert.ok(resumed?.result.ok, JSON.stringify(resumed?.result));
        assert.equal(resumed.result.made, 1, "only the chapter not yet made");
        assert.equal(resumed.requestId, undefined, "no window asked for it");
        assert.deepEqual(await pendingVideoJobs(h.store()), []);
      },
      { ffmpeg: true },
    ));

  it("refuses a second render of a book already rendering", { skip }, () =>
    withHarness(
      async (h) => {
        await read(h.send, "01-neap");
        const first = h.send({ kind: "export-audiobook-video", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, exportId: exportId(), options: { ...DEFAULT_VIDEO_OPTIONS, shape: "1280x720", slowPush: false } });
        await new Promise((wait) => setTimeout(wait, 20));
        const second = await render(h, { shape: "1280x720" });
        assert.deepEqual(second.result, { ok: false, blockers: ["this book is already rendering"] });
        await first;
      },
      { ffmpeg: true },
    ));
});


it("renders chosen motion with measured highlighted words, repeats/holds its clock and keeps plain sidecars", { skip }, () => withHarness(async (h) => {
  await read(h.send, "01-neap");
  await h.send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p0.0", picture: { file: "world-art.png", source: "world" }, requestId: REQUEST });
  const store = h.store();
  const runner = realRunner(h.calls), signal = new AbortController().signal;
  const clip = join(h.root, "moving.mp4");
  await runner.run(["-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=0.5", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], () => {}, signal);
  const filed = await fileArtifact(store, { sourcePath: clip, mediaProbe: { durationSec: async () => .5, info: async () => ({ durationSec: .5, width: 320, height: 180, hasVideo: true, hasAudio: true }) } });
  assert.ok(filed.outcome === "filed");
  const model: ManifestModel = { id: "fixture", displayName: "Fixture", provider: "fal", capability: "video", modes: { "first-frame": { locked: [] } }, accepts: { referenceImages: 0, startFrame: true, endFrame: false }, limits: { durations: { "5": "5" } }, pricing: { kind: "unmetered" } };
  const quote = await quoteAudiobookMotion(store, LEDGER, "01-neap", "p0.0", model, { kind: "video", durationSec: 5 }, "A small movement.");
  await saveAudiobookMotionCandidate(store, LEDGER, "01-neap", "p0.0", quote, filed.artifact.id);
  await chooseAudiobookMotion(store, LEDGER, "01-neap", "p0.0", "candidate", "repeat", filed.artifact.id);
  const plan = await planAudiobook(store, LEDGER, "01-neap", { narrator: await anyNarrator(store, LEDGER) });
  for (const { block } of plan.blocks) {
    const words = block.text.trim().split(/\s+/), step = .9 / words.length;
    await prepareAudiobookWordTiming(store, LEDGER, plan, block.key, async () => ({ text: block.text, seconds: 1, engine: { id: "whisper.cpp/dtw-word-boundaries-v1", version: "test", model: "fixture" }, words: words.map((text, i) => ({ text, startSec: .05 + i * step, endSec: .05 + (i + .65) * step, probability: .95 })) }), signal);
  }
  const repeat = await render(h, { shape: "1280x720", titleCards: false, slowPush: true, subtitles: "burn-in+sidecar", captionStyle: "word" });
  assert.ok(repeat.result.ok, JSON.stringify(repeat.result));
  const repeatFile = join(h.worldDir, repeat.result.dir, repeat.result.files[0]!.name);
  const reviewDir = process.env["ARKE_MOTION_REVIEW_DIR"];
  if (reviewDir !== undefined) {
    await mkdir(reviewDir, { recursive: true });
    await copyFile(repeatFile, join(reviewDir, "motion-word-captions.mp4"));
    await copyFile(clip, join(reviewDir, "fixture-clip.mp4"));
    await runner.run(["-y", "-ss", "1.2", "-i", repeatFile, "-frames:v", "1", join(reviewDir, "motion-word-captions.png")], () => {}, signal);
  }
  const info = await probe(repeatFile);
  assert.equal(info.streams.filter((stream) => stream.codec_type === "audio").length, 1, "only the narration mix is mapped");
  const sidecar = await readFile(repeatFile.replace(/\.mp4$/, ".srt"), "utf8");
  assert.doesNotMatch(sidecar, /\\c&H|<font|\\k/, "sidecars stay plain text");
  const rendering = h.calls.filter((args) => args.includes("-/filter_complex")).at(-1)!;
  assert.ok(rendering.includes("-stream_loop"), "repeat reads a looping input");
  await chooseAudiobookMotion(store, LEDGER, "01-neap", "p0.0", "behavior", "hold");
  const hold = await render(h, { shape: "1280x720", titleCards: false, slowPush: true, subtitles: "burn-in+sidecar", captionStyle: "word" });
  assert.ok(hold.result.ok, JSON.stringify(hold.result));
  assert.equal(hold.result.made, 1, "behavior changes invalidate rendered pixels");
  const holdFile = join(h.worldDir, hold.result.dir, hold.result.files[0]!.name);
  const a = await frameLuma(holdFile, 2.2, 320, 180), b = await frameLuma(holdFile, 2.6, 320, 180);
  const difference = a.subarray(0, 320 * 80).reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / (320 * 80);
  assert.ok(difference < 1.5, `held frame stays still above the captions: ${difference}`);
  const finalInfo = await probe(holdFile);
  near(Number(finalInfo.format.duration), hold.result.files[0]!.seconds, .1, "motion export follows narration length");
}, { ffmpeg: true }));
