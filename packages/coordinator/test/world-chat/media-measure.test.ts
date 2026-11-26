import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_REVIEW_SPEECH_SCHEMA_VERSION, AGENT_SEAM_SCHEMA_VERSION, MEASURED_WORD_TIMING_ENGINE, newId, productionExportFingerprint, storyTimelineFingerprint, WorldChatCheckReceiptSchema, type AgentMediaInventory, type AgentMediaRegion, type HarnessAdapter, type TimelineClipCommand } from "@arke-studio/contracts";
import { encodePng, solidImage } from "../../src/references/png.js";
import { readSpeechWav, writeSpeechWav } from "../../src/audio/speech-wav.js";
import { recordCompletedExport } from "../../src/productions/export-receipts.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { WorldStore } from "../../src/world/store.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { ConversationImages } from "../../src/world-chat/images.js";
import { ConversationMediaInspection } from "../../src/world-chat/media-inspection.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { WorldChatRetrieval } from "../../src/world-chat/retrieval.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { regionGeometry, type AgentMediaTools } from "../../src/media/agent-media-tools.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const FRAME_PNG = encodePng(solidImage(3, 2, [22, 33, 44, 255]));
const RATE = 16000, TAKE = Buffer.from("TAKE fixture"), SONG = Buffer.from("SONG fixture");

/** Ten seconds of syllables of noise: the song. */
const song = (() => {
  let state = 17;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const envelope = new Float32Array(10 * RATE), samples = new Float32Array(10 * RATE);
  for (let at = 0; at < envelope.length;) {
    const length = Math.round((.08 + random() * .22) * RATE), level = .1 + random() * .7;
    for (let i = at; i < Math.min(envelope.length, at + length); i++) envelope[i] = level;
    at += length + Math.round((.04 + random() * .16) * RATE);
  }
  for (let i = 0; i < samples.length; i++) samples[i] = envelope[i]! * (random() * 2 - 1);
  return { envelope, samples };
})();
/** The take was made from the slice at 2.0 s and sings 120 ms late; its mouth moves 80 ms late. */
const SLICE = 2, SOUND_LATE = .12, MOUTH_LATE = .08;
const songAt = (sec: number) => { const i = Math.round(sec * RATE); return i >= 0 && i < song.samples.length ? song.samples[i]! : 0; };
const envelopeAt = (sec: number) => { const i = Math.round(sec * RATE); return i >= 0 && i < song.envelope.length ? song.envelope[i]! : 0; };

/** Thirty seconds at 100 bpm from 0.3 s, a kick on each beat; and its stem, sung from 2 to 9 s and from 14 to 20 s. */
const GROOVE = Buffer.from("GROOVE fixture"), STEM = Buffer.from("STEM fixture"), GROOVE_SEC = 30;
const grooveAt = (sec: number) => {
  const sinceBeat = (sec - .3) % .6;
  if (sec < .3 || sinceBeat > .15) return 0;
  return .8 * Math.exp(-sinceBeat / .04) * Math.sin(2 * Math.PI * 60 * sinceBeat) + .4 * Math.exp(-sinceBeat / .003) * Math.sin(1e5 * sec * sec);
};
const stemAt = (sec: number) => sec >= 2 && sec < 9 || sec >= 14 && sec < 20 ? .3 * Math.sin(2 * Math.PI * 220 * sec) : 0;
/**
 * A 20 s film, for a contact sheet found in the picture, and a 6 s export of a two-clip timeline.
 * The film's shots change on its own 30 fps frames 97, 225 and 362: 3.233, 7.5 and 12.067 s. Read
 * ten frames a second they are found at 3.2, 7.5 and 12.1 s, because the resampler's frame for a
 * tenth is the film's last frame before a twentieth of a second past it. So the first cut falls a
 * frame after the time it is found at, and the last a frame before.
 */
const FILM = Buffer.from("FILM fixture"), EXPORT = Buffer.from("EXPORT fixture"), FILM_CUT_FRAMES = [97, 225, 362];
const filmFrame = (frame: number, pixels: number) => new Uint8Array(pixels).fill(40 + 50 * FILM_CUT_FRAMES.filter(cut => cut <= frame).length + frame % 3);
const filmInventory = (durationSec: number): AgentMediaInventory => ({ durationSec, streams: [{ index: 0, kind: "video", codec: "fixture", width: 1280, height: 720, frameRate: "30/1", durationSec, startTimeSec: 0 }] });
/** A second, sharper 1080p version of the take for clip_quality's comparison. */
const TAKE2 = Buffer.from("TAKE2 fixture");
const take2Inventory: AgentMediaInventory = { durationSec: 6, streams: [{ index: 0, kind: "video", codec: "fixture", width: 1920, height: 1080, frameRate: "30/1", durationSec: 6, startTimeSec: 0 }] };
/**
 * A pattern panned about two pixels a frame, 24 fps motion carried at 30 (every fifth frame
 * repeats). The sharper copy is the same clip with its detail strengthened, as an upscale gives.
 */
const panFrame = (width: number, height: number, shift: number, contrast: number) => {
  const frame = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + shift) * 1280 / width, v = y * 720 / height;
    frame[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + contrast * (40 * Math.sin(u * .37) * Math.cos(v * .23) + 20 * Math.sin(u * .9 + v * .7)))));
  }
  return frame;
};
const takeInventory: AgentMediaInventory = { durationSec: 6, streams: [
  { index: 0, kind: "video", codec: "fixture", width: 1280, height: 720, frameRate: "30/1", durationSec: 6, startTimeSec: 0 },
  { index: 1, kind: "audio", codec: "fixture", sampleRate: RATE, channels: 1, durationSec: 6, startTimeSec: 0 },
] };
const songInventory: AgentMediaInventory = { durationSec: 10, streams: [{ index: 0, kind: "audio", codec: "fixture", sampleRate: RATE, channels: 1, durationSec: 10, startTimeSec: 0 }] };

/** A word of the film's sound, on the film's own clock, for a harness that can hear; `untimed` is one the measured reader cannot place. */
type Said = { text: string; startSec: number; probability?: number; untimed?: boolean };
async function harness(options: { songStreams?: AgentMediaInventory["streams"]; noMeasure?: boolean; said?: () => Said[] } = {}) {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const cv = newId("cv"), runId = newId("run"), takeId = newId("ar"), songId = newId("ar"), chat = new WorldChatStore(conversationDir(dir, cv));
  await chat.create(cv, "2026-11-17T00:00:00Z"); await chat.append({ type: "conversation.created", title: "Sync", entryContext: { kind: "world" } });
  const artifact = (id: string, kind: string, file: string, bytes: Buffer) => [
    { path: `artifacts/${file}`, action: "create" as const, baseHash: null, encoding: "base64" as const, content: bytes.toString("base64") },
    { path: `artifacts/${file.replace(/\.\w+$/, "")}.json`, action: "create" as const, baseHash: null, content: JSON.stringify({ id, kind, file, hash: hash(bytes), links: [], origin: { by: "user" }, created: "2026-11-17T00:00:00Z" }) }];
  const grooveId = newId("ar"), stemId = newId("ar"), take2Id = newId("ar"), filmId = newId("ar");
  await store.commit({ kind: "media-fixture", source: "test", files: [...artifact(takeId, "video", "take.mp4", TAKE), ...artifact(songId, "audio", "song.mp3", SONG),
    ...artifact(grooveId, "audio", "groove.mp3", GROOVE), ...artifact(stemId, "audio", "stem.wav", STEM), ...artifact(take2Id, "video", "take2.mp4", TAKE2),
    ...artifact(filmId, "video", "film.mp4", FILM)] });
  const leases = new QueryLeaseRegistry(() => store.worldId), lease = leases.mint({ worldId: store.worldId, conversationId: cv, runId, allowedAttachmentIds: [] });
  const stop = new AbortController();
  const adapter = { imageInput: true, imageInputForSession: () => true, imageDestinationForSession: () => ({ provider: "test-provider", local: true }) } as unknown as HarnessAdapter;
  const images = new ConversationImages(store, leases, { adapter, allowed: async () => true, publish: async () => {} }); images.start(runId, "session", stop.signal);
  const calls: Array<{ what: string; startSec: number; endSec: number; region?: AgentMediaRegion; fps?: number }> = [];
  let heardFrom = 0;
  const which = async (path: string) => { const bytes = await readFile(path); return bytes.equals(GROOVE) ? "groove" : bytes.equals(STEM) ? "stem" : bytes.equals(SONG) ? "song" : bytes.equals(TAKE2) ? "take2"
    : bytes.equals(FILM) ? "film" : bytes.equals(EXPORT) ? "export" : "take"; };
  const tools: AgentMediaTools = {
    version: async () => "ffmpeg version fixture", probeVersion: async () => "ffprobe version fixture",
    probe: async path => {
      const kind = await which(path);
      if (kind === "groove" || kind === "stem") return { durationSec: GROOVE_SEC, streams: [{ ...songInventory.streams[0]!, durationSec: GROOVE_SEC }] };
      if (kind === "take2") return take2Inventory;
      if (kind === "film") return filmInventory(20);
      if (kind === "export") return { durationSec: 6, streams: [...filmInventory(6).streams, { index: 1, kind: "audio", codec: "fixture", sampleRate: 48000, channels: 2, durationSec: 6, startTimeSec: 0 }] };
      return kind === "song" ? { ...songInventory, streams: options.songStreams ?? songInventory.streams } : takeInventory;
    },
    frame: async (_path, _stream, at, end, _signal, region) => { calls.push({ what: "frame", startSec: at, endSec: end, region }); return { bytes: FRAME_PNG, width: 3, height: 2, sourceTimeSec: at }; },
    audio: async () => { throw new Error("no channel QC in this fixture"); },
    ...(options.noMeasure ? {} : {
      pcmAudio: async (path, _stream, startSec, endSec, format) => {
        const kind = await which(path), frames = Math.round((endSec - startSec) * format.rate), out = new Float32Array(frames * format.channels);
        calls.push({ what: `${kind}@${format.rate}x${format.channels}`, startSec, endSec });
        for (let i = 0; i < frames; i++) {
          const t = startSec + i / format.rate, value = kind === "stem" ? stemAt(t) : grooveAt(t);
          for (let c = 0; c < format.channels; c++) out[i * format.channels + c] = value;
        }
        return out;
      },
      monoAudio: async (path, _stream, startSec, endSec, rate) => {
        const kind = await which(path), songSide = kind === "song"; calls.push({ what: kind, startSec, endSec });
        assert.equal(rate, RATE);
        const out = new Float32Array(Math.round((endSec - startSec) * rate));
        // The export's mix is the song from the slice; a take carries that same sound 120 ms late.
        for (let i = 0; i < out.length; i++) { const t = startSec + i / rate; out[i] = songSide ? songAt(t) : kind === "export" ? songAt(SLICE + t) : songAt(SLICE + t - SOUND_LATE); }
        return out;
      },
      loudness: async () => ({ integratedLufs: -14, rangeLu: 5, truePeakDbtp: -.4, shortTermMaxLufs: -11 }),
      /*
       * The derivative the local readers are given: a tone under each word of `said` and quiet
       * between, so the stretches of voice are found where the words are. The first sample of each
       * twentieth of a second holds that step's number, which is how the readers below know where
       * in the window a stretch they are handed begins.
       */
      ...(options.said ? { speechAudio: async (_path: string, _stream: unknown, startSec: number, endSec: number) => {
        heardFrom = startSec; calls.push({ what: "speech", startSec, endSec });
        const samples = new Float32Array(Math.round((endSec - startSec) * 16000));
        for (const word of options.said!()) {
          const from = Math.round((word.startSec - startSec) * 16000);
          for (let i = Math.max(0, from); i < Math.min(samples.length, from + 3200); i++) samples[i] = .25 * Math.sin(2 * Math.PI * 220 * i / 16000);
        }
        for (let step = 0; step * 800 < samples.length; step++) samples[step * 800] = (step + 1) / 32768;
        return { bytes: writeSpeechWav({ rate: 16000, samples }), durationSec: samples.length / 16000 };
      } } : {}),
      tile: async (_path, _stream, atSec, size) => { calls.push({ what: "tile", startSec: atSec, endSec: atSec }); return new Uint8Array(size.width * size.height * 4).fill(Math.round(atSec * 10) % 256); },
      grayFrames: async (path, stream, startSec, endSec, frameOptions) => {
        if (frameOptions.fps === 10 && await which(path) === "film") {
          // Each shot a flat grey of its own, with a little movement inside it; each tenth shows the film's last frame before a twentieth past it.
          calls.push({ what: "film@10", startSec, endSec });
          return { frames: Array.from({ length: Math.round((endSec - startSec) * 10) }, (_, k) => filmFrame(Math.ceil((startSec + k / 10 + .05) * 30 - 1e-6) - 1, 64 * 36)),
            width: 64, height: 36, fps: 10 };
        }
        if (frameOptions.fps === null) {
          const kind = await which(path), size = frameOptions.size ?? (() => { const g = regionGeometry(stream.width!, stream.height!, frameOptions.region, frameOptions.edge); return { width: g.outWidth, height: g.outHeight }; })();
          calls.push({ what: `${kind}@${size.width}x${size.height}`, startSec, endSec, region: frameOptions.region });
          if (kind === "film") {
            // The film's own frames in the interval, each at its own time from the read's start.
            const first = Math.ceil(startSec * 30 - 1e-6), count = Math.ceil(endSec * 30 - 1e-6) - first;
            const frames = Array.from({ length: count }, (_, k) => filmFrame(first + k, size.width * size.height));
            return { frames, width: size.width, height: size.height, fps: 30, ...(frameOptions.times ? { times: frames.map((_, k) => (first + k) / 30 - startSec) } : {}) };
          }
          const count = Math.round((endSec - startSec) * 30), first = Math.round(startSec * 30);
          const frames = Array.from({ length: count }, (_, k) => {
            const n = first + k, shown = Math.floor(n * 24 / 30) * 2.5;
            return panFrame(size.width, size.height, shown, kind === "take2" ? 1.5 : 1);
          });
          return { frames, width: size.width, height: size.height, fps: 30, ...(frameOptions.times ? { times: frames.map((_, k) => k / 30) } : {}) };
        }
        calls.push({ what: "mouth", startSec, endSec, region: frameOptions.region, fps: frameOptions.fps ?? undefined });
        const frames: Uint8Array[] = [];
        const fps = frameOptions.fps;
        for (let k = 0; k < Math.round((endSec - startSec) * fps); k++) {
          const from = SLICE + startSec + k / fps - MOUTH_LATE; let sum = 0;
          for (let s = 0; s < 40; s++) sum += envelopeAt(from + s / 1000);
          frames.push(new Uint8Array(96 * 40).fill(Math.round(40 + 200 * sum / 40)));
        }
        return { frames, width: 96, height: 40, fps };
      },
    }),
  };
  // The words `said` puts in the stretch a reader is handed, each at its time from the stretch's start.
  const inStretch = (bytes: Uint8Array) => {
    const pcm = readSpeechWav(bytes), seconds = pcm.samples.length / 16000, from = heardFrom + (Math.round(pcm.samples[0]! * 32768) - 1) * .05;
    return { seconds, words: options.said!().filter(word => word.startSec >= from - 1e-6 && word.startSec < from + seconds - 1e-6)
      .map(word => ({ word, startSec: Math.max(0, word.startSec - from) })) };
  };
  // The measured reader hears them with their times, and refuses a stretch holding a word it cannot time; the plain reader gives the stretch's text alone.
  const speech = options.said && (async (bytes: Uint8Array) => {
    const { seconds, words } = inStretch(bytes);
    if (words.some(({ word }) => word.untimed)) throw new Error("a word has no usable timing or an unresolved pause");
    const timed = words.map(({ word, startSec }) => ({ text: word.text, startSec, endSec: Math.min(seconds, startSec + .2), probability: word.probability ?? .9 }));
    return { text: timed.map(word => word.text).join(" "), seconds, engine: { id: MEASURED_WORD_TIMING_ENGINE, version: "1", model: "base-en" }, words: timed };
  });
  const speechText = options.said && (async (bytes: Uint8Array) => inStretch(bytes).words.map(({ word }) => word.text).join(" "));
  const media = new ConversationMediaInspection(store, leases, { images, tools, ...(speech && speechText ? { speech, speechText } : {}) }); media.start(runId, stop.signal);
  const retrieval = new WorldChatRetrieval({ leases, getBundle: () => store.getBundle(), getIndex: () => null, attachments: new WorldChatAttachmentStore(dir), findAttachment: async () => null,
    readImage: (lease, args) => images.read(lease, args), readMedia: (lease, name, args) => media.read(lease, name, args) });
  return { store, lease, retrieval, calls, take: { kind: "artifact" as const, id: takeId }, song: { kind: "artifact" as const, id: songId },
    groove: { kind: "artifact" as const, id: grooveId }, stem: { kind: "artifact" as const, id: stemId }, take2: { kind: "artifact" as const, id: take2Id },
    film: { kind: "artifact" as const, id: filmId }, takeId, take2Id,
    loaded: () => new WorldChatService(dir).load(cv) };
}

test("a take that sings 120 ms late against the song: measured, follows, start it 120 ms later; the receipt raises schema 140", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "measure_sync", { source: h.take, range: { startSec: .5, endSec: 3.5 }, reference: { source: h.song, startSec: 2.5 } });
  const media = outcome.receipt.media!, sync = media.sync!;
  assert.equal(outcome.receipt.status, "complete"); assert.equal(outcome.receipt.tool, "measure-sync"); assert.equal(media.coverage, "measured-sync");
  assert.equal(sync.method, "soundtrack"); assert.equal(sync.streamIndex, 1); assert.equal(sync.lagSec, .12); assert.ok(sync.correlation! > .9);
  assert.equal(sync.follows, true); assert.equal(sync.sourceShiftSec, .12);
  assert.deepEqual({ ...sync.reference }, { source: h.song, sourceHash: hash(SONG), streamIndex: 0, startSec: 2.5, endSec: 5.5 });
  assert.deepEqual(h.calls.map(call => [call.what, call.startSec, call.endSec]), [["song", 2.5, 5.5], ["take", .5, 3.5]]);
  assert.match(outcome.receipt.querySummary!, /^Lip sync measured/); assert.match(media.limitations.join(" "), /not that the words are the same/);
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal((await h.loaded())!.mediaReceipts!.length, 1);
  assert.equal(h.store.getBundle().meta.schemaVersion, 140);
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 139 }), /newer|version|schema/i);
});

test("the mouth method reads frames from the box round the mouth and finds a mouth 80 ms late", async () => {
  const h = await harness(), region = { x: .4, y: .5, width: .2, height: .15 };
  const outcome = await h.retrieval.call(h.lease.token, "measure_sync", { source: h.take, range: { startSec: .5, endSec: 4.5 }, reference: { source: h.song, startSec: 2.5 }, method: "mouth", region });
  const sync = outcome.receipt.media!.sync!;
  assert.equal(sync.method, "mouth"); assert.equal(sync.streamIndex, 0); assert.deepEqual({ ...sync.region }, region);
  assert.equal(sync.stepSec, .04); assert.equal(sync.lagSec, .08); assert.equal(sync.takeActiveFraction, null);
  const mouth = h.calls.find(call => call.what === "mouth")!;
  assert.deepEqual({ ...mouth.region }, region); assert.equal(mouth.fps, 25);
  assert.match(outcome.receipt.media!.limitations.join(" "), /coarse proxy/);
});

test("a measurement refuses a mouth without its box, a reference interval past its end, and an ambiguous reference track", async () => {
  const h = await harness();
  const args = { source: h.take, range: { startSec: .5, endSec: 3.5 }, reference: { source: h.song, startSec: 2.5 } };
  await assert.rejects(h.retrieval.call(h.lease.token, "measure_sync", { ...args, method: "mouth" }), /region round the mouth/);
  await assert.rejects(h.retrieval.call(h.lease.token, "measure_sync", { ...args, reference: { source: h.song, startSec: 8 } }), /past the end of the reference/);
  const two = await harness({ songStreams: [songInventory.streams[0]!, { ...songInventory.streams[0]!, index: 1 }] });
  await assert.rejects(two.retrieval.call(two.lease.token, "measure_sync", { ...args, source: two.take, reference: { source: two.song, startSec: 2.5 } }), /explicit audio stream of the reference/);
  const chosen = await two.retrieval.call(two.lease.token, "measure_sync", { ...args, source: two.take, reference: { source: two.song, startSec: 2.5, streamIndex: 1 } });
  assert.equal(chosen.receipt.media!.sync!.reference.streamIndex, 1);
  assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("a host without the measurement decoder refuses without a receipt or a schema raise", async () => {
  const h = await harness({ noMeasure: true }), before = h.store.getBundle().meta.schemaVersion;
  const outcome = await h.retrieval.call(h.lease.token, "measure_sync", { source: h.take, range: { startSec: .5, endSec: 3.5 }, reference: { source: h.song, startSec: 2.5 } });
  assert.equal(outcome.receipt.status, "unavailable");
  assert.equal(h.store.getBundle().meta.schemaVersion, before); assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("song_map: 100 bpm, beats on the kicks, the Studio's sections, and where the stem sings; the receipt raises schema 141", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "song_map", { source: h.groove, vocal: { source: h.stem } });
  const media = outcome.receipt.media!, song = media.song!;
  assert.equal(outcome.receipt.status, "complete"); assert.equal(outcome.receipt.tool, "song-map"); assert.equal(media.coverage, "measured-song"); assert.equal(media.range, undefined);
  assert.equal(song.startSec, 0); assert.equal(song.endSec, GROOVE_SEC); assert.ok(Math.abs(song.tempoBpm! - 100) < .5, String(song.tempoBpm));
  for (const beat of song.beats) assert.ok(Math.abs(((beat - .3) / .6) - Math.round((beat - .3) / .6)) * .6 < .03, `beat ${beat} off the kicks`);
  assert.ok(song.beats.length >= 45, String(song.beats.length));
  assert.equal(song.sections[0]!.startSec, 0); assert.equal(song.sections[song.sections.length - 1]!.endSec, GROOVE_SEC);
  assert.deepEqual(song.vocal!.intervals, [{ startSec: 2, endSec: 9 }, { startSec: 14, endSec: 20 }]);
  assert.equal(song.vocal!.sourceHash, hash(STEM));
  assert.ok(Math.abs(song.sections.reduce((sum, s) => sum + s.vocalFraction! * (s.endSec - s.startSec), 0) - 13) < .2);
  // Sections come from the effects analysis, fed 48 kHz stereo; beats and voice from 16 kHz mono.
  assert.ok(h.calls.some(call => call.what === "groove@48000x2") && h.calls.some(call => call.what === "groove@16000x1") && h.calls.some(call => call.what === "stem@16000x1"));
  assert.match(outcome.receipt.querySummary!, /^Song mapped/);
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal(h.store.getBundle().meta.schemaVersion, 141);
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 140 }), /newer|version|schema/i);
});

test("song_map reads a window on the source's clock and refuses one past the end", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "song_map", { source: h.groove, window: { startSec: 10, endSec: 25 } });
  const song = outcome.receipt.media!.song!;
  assert.equal(song.startSec, 10); assert.equal(song.endSec, 25); assert.equal(song.vocal, null);
  assert.ok(song.beats.every(beat => beat >= 10 && beat <= 25) && song.beats.length >= 20);
  assert.ok(h.calls.filter(call => call.what.startsWith("groove")).every(call => call.startSec >= 10 && call.endSec <= 25));
  await assert.rejects(h.retrieval.call(h.lease.token, "song_map", { source: h.groove, window: { startSec: 20, endSec: 40 } }), /past the end/);
  await assert.rejects(h.retrieval.call(h.lease.token, "song_map", { source: h.groove, window: { startSec: 0, endSec: 1000 } }), /song_map/);
});

test("clip_quality: the take's 24-in-30 repeats every fifth frame; a sharper 1080p copy, met at one size, is sharper without shimmer; schema 142", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "clip_quality", { source: h.take, range: { startSec: 0, endSec: 4 }, compare: { source: h.take2 } });
  const quality = outcome.receipt.media!.quality!;
  assert.equal(outcome.receipt.tool, "clip-quality"); assert.equal(outcome.receipt.media!.coverage, "measured-quality");
  assert.equal(quality.streamIndex, 0); assert.equal(quality.cadence.repeatPeriod, 5); assert.ok(Math.abs(quality.cadence.motionFps! - 24) < .2, String(quality.cadence.motionFps));
  assert.equal(quality.compare!.cadence.repeatPeriod, 5); assert.equal(quality.compare!.sourceHash, hash(TAKE2));
  // Met at the larger clip's size, its longer side 960: the 720p take enlarged to meet the 1080p one.
  assert.equal(quality.detail.width, 960); assert.equal(quality.detail.height, 540); assert.equal(quality.compare!.detail.width, 960);
  assert.ok(quality.compare!.sharpnessChangePct! > 40, String(quality.compare!.sharpnessChangePct));
  assert.ok(Math.abs(quality.compare!.shimmerChangePct!) < 5, String(quality.compare!.shimmerChangePct));
  // Detail reads the interval's middle two seconds; cadence the whole interval.
  assert.ok(h.calls.some(call => call.what === "take@960x540" && call.startSec === 1 && call.endSec === 3));
  assert.ok(h.calls.some(call => call.what === "take@128x72" && call.startSec === 0 && call.endSec === 4));
  assert.match(outcome.receipt.querySummary!, /^Clip quality measured/);
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal(h.store.getBundle().meta.schemaVersion, 142);
});

test("clip_quality measures a region alone, and refuses a compared clip of another shape", async () => {
  const h = await harness(), region = { x: .4, y: .1, width: .3, height: .5 };
  const one = await h.retrieval.call(h.lease.token, "clip_quality", { source: h.take, range: { startSec: 0, endSec: 3 }, region });
  const quality = one.receipt.media!.quality!;
  assert.deepEqual({ ...quality.region }, region); assert.equal(quality.compare, null);
  assert.equal(quality.detail.width, 384); assert.equal(quality.detail.height, 360);
  await assert.rejects(h.retrieval.call(h.lease.token, "clip_quality", { source: h.take, range: { startSec: 0, endSec: 3 }, compare: { source: h.groove } }), /video stream of the compared clip/);
  // A small region rounds to 128x44 at 720p and 192x64 at 1080p; the pictures are one shape, so they are compared.
  const small = await h.retrieval.call(h.lease.token, "clip_quality", { source: h.take, range: { startSec: 0, endSec: 3 }, region: { x: .4, y: .4, width: .1, height: .06 }, compare: { source: h.take2 } });
  assert.equal(small.receipt.status, "complete"); assert.equal(small.receipt.media!.quality!.compare!.detail.width, 192);
  await assert.rejects(h.retrieval.call(h.lease.token, "clip_quality", { source: h.take, range: { startSec: 0, endSec: 3 }, compare: { source: h.take2, range: { startSec: 0, endSec: 2 } } }), /clip_quality/);
});

test("cut_contact_sheet on a film with no cut behind it: shots found where the picture jumps, a tile from each one's middle, one page; schema 143", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: h.film });
  const sheet = outcome.receipt.media!.sheet!;
  assert.equal(outcome.receipt.tool, "cut-contact-sheet"); assert.equal(outcome.receipt.media!.coverage, "contact-sheet");
  assert.equal(sheet.shotsFrom, "picture"); assert.equal(sheet.productionId, null);
  assert.deepEqual(sheet.shots.map(shot => [shot.startSec, shot.endSec, shot.label]), [[0, 3.2, null], [3.2, 7.5, null], [7.5, 12.1, null], [12.1, 20, null]]);
  assert.deepEqual(h.calls.filter(call => call.what === "tile").map(call => call.startSec), [1.6, 5.35, 9.8, 16.05]);
  assert.equal(sheet.pages.length, 1); assert.equal(outcome.imageContent!.length, 1);
  assert.equal(sheet.pages[0]!.image.width, 1488); assert.equal(sheet.pages[0]!.image.sourceHash, hash(FILM));
  assert.match(outcome.receipt.querySummary!, /^Contact sheet/);
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal(h.store.getBundle().meta.schemaVersion, 143);
});

test("cut_contact_sheet with seams: the frame either side of each cut, three cuts on one image, on any film; schema 151", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: h.film, seams: true });
  const sheet = outcome.receipt.media!.sheet!;
  /*
   * Each cut is placed on the film's own frames: the first frame of the new shot and the frame
   * before it. Found ten frames a second they read 3.2, 7.5 and 12.1 s; the film's frame at 3.2 s
   * is still the old shot, and its frame at 12.1 s is the new shot's second (codex on PR 3330).
   */
  assert.deepEqual(sheet.seams, [{ shot: 2, atSec: 3.233, beforeSec: 3.2, afterSec: 3.233 }, { shot: 3, atSec: 7.5, beforeSec: 7.467, afterSec: 7.5 }, { shot: 4, atSec: 12.067, beforeSec: 12.033, afterSec: 12.067 }]);
  // The frames around each found time are read small, every one of them, to find the step that is the cut.
  assert.deepEqual(h.calls.filter(call => call.what === "film@64x36").map(call => [Math.round(call.startSec * 10) / 10, Math.round(call.endSec * 10) / 10]).sort((a, b) => a[0]! - b[0]!), [[2.9, 3.3], [7.2, 7.6], [11.8, 12.2]]);
  // Each is asked for a hair before its frame's time: the decoder gives the next frame at or after the time it is asked for.
  assert.deepEqual(h.calls.filter(call => call.what === "tile").map(call => Math.round(call.startSec * 1000) / 1000).sort((a, b) => a - b), [3.199, 3.232, 7.466, 7.499, 12.032, 12.066]);
  assert.deepEqual(sheet.shots.map(shot => [shot.startSec, shot.endSec]), [[0, 3.233], [3.233, 7.5], [7.5, 12.067], [12.067, 20]], "the shots' table rides with the cuts, on the same frames");
  assert.deepEqual(sheet.pages.map(page => [page.firstShot, page.lastShot, page.image.width]), [[2, 4, 1196]]);
  assert.equal(outcome.imageContent!.length, 1, "one image of the budget, however many cuts it holds");
  assert.match(outcome.receipt.media!.limitations.join(" "), /Two still frames a cut/);
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal(h.store.getBundle().meta.schemaVersion, AGENT_SEAM_SCHEMA_VERSION);
  // One shot has no cut to show.
  await assert.rejects(h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: h.film, seams: true, window: { startSec: 0, endSec: 3 } }), /one shot/);
});

test("a contact sheet with no image left for its pages is refused before the film is read or a media call spent", async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) assert.equal((await h.retrieval.call(h.lease.token, "sample_video", { source: h.take, range: { startSec: 0, endSec: 1 }, count: 8 })).receipt.status, "complete");
  const outcome = await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: h.film });
  assert.deepEqual(outcome.result, { unavailable: true, reason: "cut_contact_sheet: this run has reached its 24-image inspection limit. Left in this run: 4 speech, 13 media and 2 listening calls, 0 images." });
  assert.deepEqual(h.calls.filter(call => call.what === "tile" || call.what === "film@10"), []);
});

/** A two-clip cut of the fixture's production, both clips' own sound muted under the mix, and an export stamped with that cut. */
async function cutAndExport(h: Awaited<ReturnType<typeof harness>>, id: string, options: { label?: string; bed?: boolean; over?: boolean; hole?: boolean } = {}) {
  const production = h.store.getBundle().productions.find(row => row.meta.id === "saltlight")!;
  // A bed that runs on past the picture: the export trims sound to the picture's end.
  const bed: TimelineClipCommand[] = options.bed ? [{ kind: "add-track", trackId: "tr_bed", trackKind: "audio", name: "Bed" },
    { kind: "place", trackId: "tr_bed", clip: { id: "cl_bed", startFrame: 0, durationFrames: 400, sourceInFrames: 0, source: { kind: "artifact", artifactId: h.song.id, label: "Bed" } } }] : [];
  // A second Picture track that is shown: its clip starts with the opening and lies over it.
  const over: TimelineClipCommand[] = options.over ? [{ kind: "add-track", trackId: "tr_over", trackKind: "picture", name: "Over" },
    { kind: "place", trackId: "tr_over", clip: { id: "cl_over", startFrame: 0, durationFrames: 48, sourceInFrames: 0, audio: "mute", source: { kind: "artifact", artifactId: h.take2Id, label: "Over the opening" } } }] : [];
  await applyHumanTimelineCommand(h.store, "saltlight", { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    // With a hole, the opening stops a second short of the close, and the export shows black between them.
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_open", startFrame: 0, durationFrames: options.hole ? 72 : 96, sourceInFrames: 0, audio: "mute", source: { kind: "artifact", artifactId: h.takeId, label: options.label ?? "The opening" } } },
    ...bed,
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_close", startFrame: 96, durationFrames: 48, sourceInFrames: 0, audio: "mute", source: { kind: "artifact", artifactId: h.take2Id, label: "The close" } } },
    // A muted upper track puts nothing in the export, so its clip is no shot of the sheet or the review.
    { kind: "add-track", trackId: "tr_hidden", trackKind: "picture", name: "Hidden" },
    { kind: "place", trackId: "tr_hidden", clip: { id: "cl_hidden", startFrame: 24, durationFrames: 24, sourceInFrames: 0, source: { kind: "artifact", artifactId: h.take2Id, label: "Not shown" } } },
    { kind: "set-track", trackId: "tr_hidden", muted: true },
    ...over] });
  const current = h.store.getBundle().productions.find(row => row.meta.id === "saltlight")!;
  assert.equal(current.timeline?.status, "ready");
  await mkdir(join(h.store.dir, "exports"), { recursive: true }); await writeFile(join(h.store.dir, "exports", `${id}.mp4`), EXPORT);
  const stamp = { worldId: h.store.worldId, productionId: "saltlight", status: "done" as const, createdAt: "2026-11-17T00:00:00Z", deliveryKind: "video" as const };
  await recordCompletedExport(h.store, { ...stamp, id, output: `exports/${id}.mp4`, sourceFingerprint: productionExportFingerprint(h.store.getBundle(), current) });
  return { stamp, rate: (current.timeline as { timeline: { frameRate: number } }).timeline.frameRate };
}

test("cut_contact_sheet on an export whose production still holds its cut: the timeline's clips, named", async () => {
  const h = await harness(), { stamp, rate } = await cutAndExport(h, "ex_sheet");
  const outcome = await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: { kind: "export", exportId: "ex_sheet" } });
  const sheet = outcome.receipt.media!.sheet!;
  assert.equal(sheet.shotsFrom, "timeline"); assert.equal(sheet.productionId, "saltlight");
  assert.deepEqual(sheet.shots.map(shot => [shot.label, shot.clipId, shot.startSec, shot.endSec]), [["The opening", "cl_open", 0, 96 / rate], ["The close", "cl_close", 96 / rate, 144 / rate]]);
  // The timeline's cut is exact: its page of cuts shows the frame at the cut and the one frame before it (codex on PR 3330).
  const cut = (await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: { kind: "export", exportId: "ex_sheet" }, seams: true })).receipt.media!.sheet!.seams![0]!;
  assert.deepEqual([cut.shot, cut.atSec, cut.afterSec], [2, 96 / rate, 96 / rate]);
  assert.ok(cut.atSec - cut.beforeSec > 0 && cut.atSec - cut.beforeSec <= 1 / 23, `one frame before, not a fixed lead: ${cut.beforeSec}`);
  // A changed fingerprint (the cut moved on since) falls back to the picture.
  await writeFile(join(h.store.dir, "exports", "ex_old.mp4"), EXPORT);
  await recordCompletedExport(h.store, { ...stamp, id: "ex_old", output: "exports/ex_old.mp4", sourceFingerprint: "production-export-v1:an-older-cut" });
  const old = await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source: { kind: "export", exportId: "ex_old" } });
  assert.equal(old.receipt.media!.sheet!.shotsFrom, "picture");
});

test("a page of cuts of an export whose picture clips overlap finds its cuts in the picture: two clips that start together are no cut", async () => {
  const h = await harness(); await cutAndExport(h, "ex_over", { over: true });
  const source = { kind: "export" as const, exportId: "ex_over" };
  // The sheet of shots still lists every clip the export shows, the upper track's with the base's.
  const plain = (await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source })).receipt.media!.sheet!;
  assert.equal(plain.shotsFrom, "timeline"); assert.deepEqual(plain.shots.map(shot => [shot.clipId, shot.startSec]), [["cl_over", 0], ["cl_open", 0], ["cl_close", 4]]);
  /*
   * Its page of cuts cannot: "cl_open" would be a cut at 0 s whose two frames are one time, which
   * the receipt's schema refused once every frame had been decoded (codex on PR 3330). The cuts
   * are found in the film's own picture instead, and each is placed on its frames.
   */
  const outcome = await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source, seams: true });
  const sheet = outcome.receipt.media!.sheet!;
  assert.equal(sheet.shotsFrom, "picture"); assert.equal(sheet.productionId, null); assert.equal(sheet.seams!.length, sheet.shots.length - 1);
  assert.ok(sheet.seams!.every(seam => seam.beforeSec < seam.atSec && seam.afterSec === seam.atSec), JSON.stringify(sheet.seams));
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
});

test("a page of cuts of an export with a hole between two clips finds its cuts in the picture: black is two cuts, and the clips hold one", async () => {
  const h = await harness(); await cutAndExport(h, "ex_hole", { hole: true });
  const source = { kind: "export" as const, exportId: "ex_hole" };
  const plain = (await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source })).receipt.media!.sheet!;
  assert.equal(plain.shotsFrom, "timeline"); assert.deepEqual(plain.shots.map(shot => [shot.clipId, shot.startSec, shot.endSec]), [["cl_open", 0, 3], ["cl_close", 4, 6]]);
  // From the clips, the page would show the cut out of black at 4 s and miss the cut into it at 3 s (codex on PR 3333).
  const sheet = (await h.retrieval.call(h.lease.token, "cut_contact_sheet", { source, seams: true })).receipt.media!.sheet!;
  assert.equal(sheet.shotsFrom, "picture"); assert.equal(sheet.productionId, null);
});

test("review_export: length against the cut, format, loudness, the shots that repeat frames and the clip 120 ms late, in findings; schema 144", async () => {
  const h = await harness(), { rate } = await cutAndExport(h, "ex_review");
  const outcome = await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_review" } });
  const review = outcome.receipt.media!.review!;
  assert.equal(outcome.receipt.tool, "review-export"); assert.equal(outcome.receipt.media!.coverage, "export-review");
  assert.equal(review.shotsFrom, "timeline"); assert.equal(review.productionId, "saltlight");
  assert.equal(review.length.expectedSec, Math.round(144 / rate * 1000) / 1000); assert.equal(review.length.durationSec, 6);
  assert.deepEqual({ ...review.format, videoCodec: undefined }, { videoStreamIndex: 0, width: 1280, height: 720, frameRate: 30, videoCodec: undefined, audioStreamIndex: 1, sampleRate: 48000, channels: 2, audioCodec: "fixture" });
  assert.deepEqual(review.loudness, { integratedLufs: -14, rangeLu: 5, truePeakDbtp: -.4, shortTermMaxLufs: -11 });
  // The opening's own sound is the mix 120 ms late; the close has no sound of its own to set against it.
  const [open, close] = review.shots;
  assert.equal(open!.sync!.lagSec, .12); assert.equal(open!.sync!.follows, true); assert.equal(open!.sync!.sourceHash, hash(TAKE)); assert.equal(close!.sync, null);
  assert.equal(open!.repeatPeriod, 5);
  assert.ok(review.findings.some(line => line.startsWith("Shot 1 (The opening) is 120 ms late against the mix: start it 0.12 s later")), review.findings.join(" | "));
  assert.ok(review.findings.some(line => line.startsWith("Shot 1 (The opening) repeats a frame about every 5")));
  assert.ok(review.findings.some(line => /true peak is -0\.4 dBTP/.test(line)));
  assert.match(outcome.receipt.querySummary!, /^Film reviewed/);
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal(h.store.getBundle().meta.schemaVersion, 144);
});

test("review_export holds the film to its render plan's length, reads a clip's sound from where the window opens in it, and names a long label short", async () => {
  const h = await harness(), long = "A long name for the opening shot of the film, ".repeat(4).slice(0, 160);
  const { rate } = await cutAndExport(h, "ex_window", { label: long, bed: true });
  const current = h.store.getBundle().productions.find(row => row.meta.id === "saltlight")!;
  assert.ok((current.timeline as { timeline: { tracks: Array<{ id: string }> } }).timeline.tracks.some(track => track.id === "tr_bed"), "the bed was placed");
  const whole = (await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_window" } })).receipt.media!.review!;
  // The bed runs 400 frames, the picture 144: the film is the picture's length, as the export made it.
  assert.equal(whole.length.expectedSec, Math.round(144 / rate * 1000) / 1000); assert.equal(whole.length.differenceSec, 0);
  const named = whole.findings.find(line => line.startsWith("Shot 1 ("))!;
  assert.ok(named.startsWith(`Shot 1 (${long.slice(0, 59)}…) `), named); assert.equal(whole.shots[0]!.label, long);
  // A window opening a second into the opening shot: its own sound is read from a second in, and is still 120 ms late.
  const part = (await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_window" }, window: { startSec: 1, endSec: 3.5 } })).receipt.media!.review!;
  assert.equal(part.shots[0]!.startSec, 1); assert.equal(part.shots[0]!.sync!.lagSec, .12); assert.equal(part.shots[0]!.sync!.follows, true);
});

test("review_export of a film with no cut behind it finds its shots in the picture and measures no sync", async () => {
  const h = await harness();
  const outcome = await h.retrieval.call(h.lease.token, "review_export", { source: h.film });
  const review = outcome.receipt.media!.review!;
  assert.equal(review.shotsFrom, "picture"); assert.equal(review.length.expectedSec, null); assert.equal(review.shots.length, 4);
  assert.ok(review.shots.every(shot => shot.sync === null)); assert.equal(review.loudness, null); assert.ok(review.findings.includes("The film has no sound."));
});

/** A cut of two of the fixture's story shots, shot 12's voice-over then shot 14's line, and an export stamped with it. */
async function storyCutAndExport(h: Awaited<ReturnType<typeof harness>>, id: string, options: { split?: boolean; layered?: boolean } = {}) {
  const production = h.store.getBundle().productions.find(row => row.meta.id === "saltlight")!;
  const shot = (clipId: `cl_${string}`, shotId: string, number: number, startFrame: number, durationFrames: number, trackId: `tr_${string}` = "tr_picture"): TimelineClipCommand => ({ kind: "place", trackId,
    clip: { id: clipId, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "shot", shotId: shotId as never, sceneNumber: 4, shotNumber: number, label: `SC 4 · SH ${number}` } } });
  await applyHumanTimelineCommand(h.store, "saltlight", { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production),
    // Split: shot 12 shown in two clips, with shot 14 between them as an insert would be.
    commands: options.split ? [shot("cl_verse", "sh_12", 12, 0, 48), shot("cl_rest", "sh_14", 14, 48, 48), shot("cl_verse_on", "sh_12", 12, 96, 48)]
      // Layered: shot 12 under the whole film, and shot 14 laid over it from 1 s to 3 s on a second Picture track.
      : options.layered ? [shot("cl_verse", "sh_12", 12, 0, 144), { kind: "add-track", trackId: "tr_over", trackKind: "picture", name: "Over" }, shot("cl_rest", "sh_14", 14, 24, 48, "tr_over")]
      : [shot("cl_verse", "sh_12", 12, 0, 96), shot("cl_rest", "sh_14", 14, 96, 48)] });
  const current = h.store.getBundle().productions.find(row => row.meta.id === "saltlight")!;
  assert.equal(current.timeline?.status, "ready");
  await mkdir(join(h.store.dir, "exports"), { recursive: true }); await writeFile(join(h.store.dir, "exports", `${id}.mp4`), EXPORT);
  await recordCompletedExport(h.store, { worldId: h.store.worldId, productionId: "saltlight", status: "done", createdAt: "2026-11-26T00:00:00Z", deliveryKind: "video",
    id, output: `exports/${id}.mp4`, sourceFingerprint: productionExportFingerprint(h.store.getBundle(), current) });
}
const say = (text: string, from: number, step = .3): Said[] => text.split(" ").map((word, i) => ({ text: word, startSec: Math.round((from + i * step) * 1000) / 1000 }));

test("review_export hears the film: every line of the cut's shots heard under its own shot; schema 152", async () => {
  const h = await harness({ said: () => [...say("the verse under the water", .5), ...say("tell you the rest after", 4.3)] });
  await storyCutAndExport(h, "ex_heard");
  const outcome = await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_heard" } });
  const review = outcome.receipt.media!.review!;
  assert.deepEqual(review.speech, { linesFrom: "cut", unwritten: 0, misplaced: 0, readSec: 6,
    lines: [{ number: 1, shot: 1, said: "as-written", startSec: .5 }, { number: 2, shot: 2, said: "as-written", startSec: 4.3 }] });
  assert.deepEqual(review.findings.filter(line => /^Line |^Words nobody|words could not/.test(line)), [], review.findings.join(" | "));
  assert.deepEqual(h.calls.filter(call => call.what === "speech").map(call => [call.startSec, call.endSec]), [[0, 6]], "read once, a minute at a time");
  assert.equal(WorldChatCheckReceiptSchema.safeParse(outcome.receipt).success, true);
  assert.equal(h.store.getBundle().meta.schemaVersion, AGENT_REVIEW_SPEECH_SCHEMA_VERSION);
});

test("review_export finds a line the mix moved under another shot, words nobody wrote, and says when it cannot hear", async () => {
  // Shot 14's line lost its place and plays at the top, under shot 12; a take's "oh no" follows the voice-over.
  const moved = await harness({ said: () => [...say("tell you the rest after", .3), ...say("the verse under the water", 2), ...say("oh no", 5)] });
  await storyCutAndExport(moved, "ex_moved");
  const review = (await moved.retrieval.call(moved.lease.token, "review_export", { source: { kind: "export", exportId: "ex_moved" } })).receipt.media!.review!;
  const heard = review.findings.filter(line => /^Line |^Words nobody/.test(line));
  assert.ok(heard.some(line => /^Line 2 is heard at 0:00\.3 under shot 1, not its own shot 2\.$/.test(line)) || heard.some(line => /^Line 2 .* is not heard in its place; words like it are heard at 0:00\.3\.$/.test(line)), heard.join(" | "));
  assert.ok(heard.some(line => /^Words nobody wrote at 0:05\.0: "oh no"\.$/.test(line)), heard.join(" | "));
  // A host with no local reader does not report silence: it says the lines were not checked.
  const deaf = await harness(); await storyCutAndExport(deaf, "ex_deaf");
  const unheard = (await deaf.retrieval.call(deaf.lease.token, "review_export", { source: { kind: "export", exportId: "ex_deaf" } })).receipt.media!.review!;
  assert.equal(unheard.speech, undefined);
  assert.ok(unheard.findings.includes("The film's words could not be read on this host, so its lines were not checked."));
  assert.equal(deaf.store.getBundle().meta.schemaVersion, 144, "a review with no words in it is the review it was");
});

test("review_export holds a shot shown in two clips of the cut to its line once", async () => {
  // Shot 12 runs to 2 s, shot 14 to 4 s, and shot 12 again to 6 s: the voice-over is said once, under the first of them.
  const h = await harness({ said: () => [...say("the verse under the water", .3), ...say("tell you the rest after", 2.2)] });
  await storyCutAndExport(h, "ex_split", { split: true });
  const review = (await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_split" } })).receipt.media!.review!;
  assert.equal(review.shots.length, 3);
  // Counted for each clip, the line read as said and then not heard (codex on PR 3333).
  assert.deepEqual(review.speech!.lines, [{ number: 1, shot: 1, said: "as-written", startSec: .3 }, { number: 2, shot: 2, said: "as-written", startSec: 2.2 }]);
  assert.deepEqual(review.findings.filter(line => /^Line |^Words nobody/.test(line)), [], review.findings.join(" | "));
});

test("review_export hears the lines of a cut with a second Picture track, and does not say which shot they are under", async () => {
  // Shot 14 is laid over shot 12 from 1 s to 3 s and says its line there. Both clips hold that second: which one the film shows is the render's to say.
  const h = await harness({ said: () => [...say("the verse under the water", .1, .15), ...say("tell you the rest after", 1.2)] });
  await storyCutAndExport(h, "ex_layered", { layered: true });
  const review = (await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_layered" } })).receipt.media!.review!;
  assert.deepEqual(review.speech!.lines.map(line => [line.number, line.shot, line.said]), [[1, 1, "as-written"], [2, 2, "as-written"]]);
  // Looked up by the first clip holding the time, the insert's line read as under the base (codex on PR 3333).
  assert.deepEqual(review.findings.filter(line => /^Line |^Words nobody/.test(line)), [], review.findings.join(" | "));
});

test("review_export does not hold a film to a scene with more lines than it sets beside one", async () => {
  const h = await harness({ said: () => say("the verse under the water", .5) });
  const scenePath = "productions/saltlight/scenes/04-the-verse-rises.json", raw = await readFile(join(h.store.dir, scenePath)), scene = JSON.parse(raw.toString("utf8"));
  scene.script = { blocks: Array.from({ length: 401 }, (_, i) => ({ id: `blk_${i}`, kind: "dialogue", speaker: "maren-kest", text: "Yes." })) };
  await h.store.commit({ kind: "media-fixture", source: "test", files: [{ path: scenePath, action: "replace", baseHash: hash(raw), content: JSON.stringify(scene, null, 2) }] });
  await mkdir(join(h.store.dir, "exports"), { recursive: true }); await writeFile(join(h.store.dir, "exports", "ex_long.mp4"), EXPORT);
  await recordCompletedExport(h.store, { worldId: h.store.worldId, productionId: "saltlight", status: "done", createdAt: "2026-11-26T00:00:00Z", deliveryKind: "video",
    id: "ex_long", output: "exports/ex_long.mp4", sourceFingerprint: "production-export-v1:a-cut-made-elsewhere" });
  const review = (await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_long" }, script: { productionId: "saltlight", sceneId: "sc_04" } })).receipt.media!.review!;
  // Cut short at 400, the lines past it were read as words nobody wrote (codex on PR 3333).
  assert.equal(review.speech, undefined);
  assert.ok(review.findings.includes("The scene holds 401 spoken lines, more than a review sets beside a film (400), so its lines were not checked."), review.findings.join(" | "));
  assert.deepEqual(h.calls.filter(call => call.what === "speech"), [], "and the film is not read for them");
});

test("review_export keeps a line the measured reader cannot time: heard, with no time, and its stretch is never words nobody wrote", async () => {
  // Film sound: the second line sits over a room the measured reader refuses, and the plain reader adds words of its own after it.
  const h = await harness({ said: () => [...say("the verse under the water", .5), ...say("tell you the rest after la la", 4.3, .2).map(word => ({ ...word, untimed: true }))] });
  await storyCutAndExport(h, "ex_untimed");
  const review = (await h.retrieval.call(h.lease.token, "review_export", { source: { kind: "export", exportId: "ex_untimed" } })).receipt.media!.review!;
  assert.deepEqual(review.speech, { linesFrom: "cut", unwritten: 0, misplaced: 0, readSec: 6,
    lines: [{ number: 1, shot: 1, said: "as-written", startSec: .5 }, { number: 2, shot: 2, said: "as-written", startSec: null }] });
  assert.deepEqual(review.findings.filter(line => /^Line |^Words nobody|words could not/.test(line)), [], review.findings.join(" | "));
});

test("review_export holds a cut made outside the Studio to the script of the scene the call names", async () => {
  // The film says the first line, never the second, and a name the script has is said as something else.
  const h = await harness({ said: () => [...say("the verse under the water", .5), ...say("i do it in a bag go and greet her before i die", 3, .2)] });
  const scenePath = "productions/saltlight/scenes/04-the-verse-rises.json", raw = await readFile(join(h.store.dir, scenePath));
  const scene = JSON.parse(raw.toString("utf8"));
  scene.script = { blocks: [{ id: "blk_verse", kind: "dialogue", speaker: "maren-kest", text: "The verse, under the water." },
    { id: "blk_rest", kind: "dialogue", speaker: "maren-kest", text: "Tell you the rest after." },
    { id: "blk_name", kind: "dialogue", speaker: "maren-kest", text: "Maren Kest, abeg, go and greet her before I die." },
    { id: "blk_look", kind: "action", text: "She looks at the water." }] };
  await h.store.commit({ kind: "media-fixture", source: "test", files: [{ path: scenePath, action: "replace", baseHash: hash(raw), content: JSON.stringify(scene, null, 2) }] });
  // An export whose cut the production no longer holds: a film with no cut behind it, as a file from outside is.
  await mkdir(join(h.store.dir, "exports"), { recursive: true }); await writeFile(join(h.store.dir, "exports", "ex_outside.mp4"), EXPORT);
  await recordCompletedExport(h.store, { worldId: h.store.worldId, productionId: "saltlight", status: "done", createdAt: "2026-11-26T00:00:00Z", deliveryKind: "video",
    id: "ex_outside", output: "exports/ex_outside.mp4", sourceFingerprint: "production-export-v1:a-cut-made-elsewhere" });
  const source = { kind: "export" as const, exportId: "ex_outside" };
  const review = (await h.retrieval.call(h.lease.token, "review_export", { source, script: { productionId: "saltlight", sceneId: "sc_04" } })).receipt.media!.review!;
  assert.equal(review.shotsFrom, "picture");
  assert.deepEqual(review.speech!.lines.map(line => [line.number, line.shot, line.said]), [[1, null, "as-written"], [2, null, "not-heard"], [3, null, "partly"]]);
  assert.equal(review.speech!.linesFrom, "script");
  const heard = review.findings.filter(line => line.startsWith("Line "));
  assert.deepEqual(heard, ["Line 2 \"Tell you the rest after.\" is not heard.", "Line 3: nothing like the name maren kest is heard (the line is at 0:03.8); listen to it."], review.findings.join(" | "));
  /*
   * A window on the film's second half hears only the third line. The lines before the first one
   * heard were not listened for, so they are not reported: the first read "not heard" for line 1,
   * which the film says in its first two seconds (codex on PR 3333).
   */
  const later = (await h.retrieval.call(h.lease.token, "review_export", { source, window: { startSec: 2.5, endSec: 6 }, script: { productionId: "saltlight", sceneId: "sc_04" } })).receipt.media!.review!;
  assert.deepEqual(later.speech!.lines.map(line => [line.number, line.said]), [[3, "partly"]]);
  assert.deepEqual(later.findings.filter(line => line.startsWith("Line ")), ["Line 3: nothing like the name maren kest is heard (the line is at 0:03.8); listen to it."], later.findings.join(" | "));
  // A window with none of the scene's lines in it says so, rather than nothing at all.
  const none = (await h.retrieval.call(h.lease.token, "review_export", { source, window: { startSec: 5.5, endSec: 6 }, script: { productionId: "saltlight", sceneId: "sc_04" } })).receipt.media!.review!;
  assert.equal(none.speech, undefined); assert.ok(none.findings.includes("None of the scene's lines is heard in this part of the film."), none.findings.join(" | "));
  // Without the scene named it has no lines to be held to, and says nothing of words.
  const unheld = (await h.retrieval.call(h.lease.token, "review_export", { source })).receipt.media!.review!;
  assert.equal(unheld.speech, undefined); assert.equal(unheld.findings.some(line => /^Line |words could not/.test(line)), false);
  await assert.rejects(h.retrieval.call(h.lease.token, "review_export", { source, script: { productionId: "saltlight", sceneId: "sc_99" } }), /not in this world/);
});

test("sample_video looks closely at a box: the region reaches the decoder and the receipt, and raises schema 143", async () => {
  const h = await harness(), region = { x: .4, y: .5, width: .2, height: .15 };
  const outcome = await h.retrieval.call(h.lease.token, "sample_video", { source: h.take, range: { startSec: 0, endSec: 1 }, count: 1, region });
  assert.equal(outcome.receipt.media!.coverage, "sampled-frames-only"); assert.deepEqual({ ...outcome.receipt.media!.region }, region);
  assert.deepEqual({ ...h.calls.find(call => call.what === "frame")!.region }, region);
  assert.equal(h.store.getBundle().meta.schemaVersion, 143);
  // Without a box nothing changes: no region on the receipt, and no new boundary.
  const plain = await harness(), whole = await plain.retrieval.call(plain.lease.token, "sample_video", { source: plain.take, range: { startSec: 0, endSec: 1 }, count: 1 });
  assert.equal(whole.receipt.media!.region, undefined); assert.ok(plain.store.getBundle().meta.schemaVersion < 140);
  await assert.rejects(h.retrieval.call(h.lease.token, "sample_video", { source: h.take, range: { startSec: 0, endSec: 1 }, region: { x: .9, y: .5, width: .2, height: .15 } }), /sample_video/);
});

test("the shared leased MCP catalogue lists measure_sync and serves it", async () => {
  const h = await harness(), server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  let served = ""; server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: receipt => { served = receipt.tool; } });
  const rpc = async (method: string, params?: unknown) => (await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  const listed = await rpc("tools/list") as { result: { tools: Array<{ name: string }> } };
  for (const name of ["measure_sync", "song_map", "clip_quality", "cut_contact_sheet", "review_export"]) assert.ok(listed.result.tools.some(tool => tool.name === name), name);
  await rpc("tools/call", { name: "measure_sync", arguments: { source: h.take, range: { startSec: .5, endSec: 3.5 }, reference: { source: h.song, startSec: 2.5 } } });
  assert.equal(served, "measure-sync");
});
