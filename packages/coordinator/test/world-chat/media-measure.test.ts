import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newId, WorldChatCheckReceiptSchema, type AgentMediaInventory, type AgentMediaRegion, type HarnessAdapter } from "@arke-studio/contracts";
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

async function harness(options: { songStreams?: AgentMediaInventory["streams"]; noMeasure?: boolean } = {}) {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const cv = newId("cv"), runId = newId("run"), takeId = newId("ar"), songId = newId("ar"), chat = new WorldChatStore(conversationDir(dir, cv));
  await chat.create(cv, "2026-11-17T00:00:00Z"); await chat.append({ type: "conversation.created", title: "Sync", entryContext: { kind: "world" } });
  const artifact = (id: string, kind: string, file: string, bytes: Buffer) => [
    { path: `artifacts/${file}`, action: "create" as const, baseHash: null, encoding: "base64" as const, content: bytes.toString("base64") },
    { path: `artifacts/${file.replace(/\.\w+$/, "")}.json`, action: "create" as const, baseHash: null, content: JSON.stringify({ id, kind, file, hash: hash(bytes), links: [], origin: { by: "user" }, created: "2026-11-17T00:00:00Z" }) }];
  const grooveId = newId("ar"), stemId = newId("ar"), take2Id = newId("ar");
  await store.commit({ kind: "media-fixture", source: "test", files: [...artifact(takeId, "video", "take.mp4", TAKE), ...artifact(songId, "audio", "song.mp3", SONG),
    ...artifact(grooveId, "audio", "groove.mp3", GROOVE), ...artifact(stemId, "audio", "stem.wav", STEM), ...artifact(take2Id, "video", "take2.mp4", TAKE2)] });
  const leases = new QueryLeaseRegistry(() => store.worldId), lease = leases.mint({ worldId: store.worldId, conversationId: cv, runId, allowedAttachmentIds: [] });
  const stop = new AbortController();
  const adapter = { imageInput: true, imageInputForSession: () => true, imageDestinationForSession: () => ({ provider: "test-provider", local: true }) } as unknown as HarnessAdapter;
  const images = new ConversationImages(store, leases, { adapter, allowed: async () => true, publish: async () => {} }); images.start(runId, "session", stop.signal);
  const calls: Array<{ what: string; startSec: number; endSec: number; region?: AgentMediaRegion; fps?: number }> = [];
  const isSong = async (path: string) => (await readFile(path)).equals(SONG);
  const which = async (path: string) => { const bytes = await readFile(path); return bytes.equals(GROOVE) ? "groove" : bytes.equals(STEM) ? "stem" : bytes.equals(SONG) ? "song" : bytes.equals(TAKE2) ? "take2" : "take"; };
  const tools: AgentMediaTools = {
    version: async () => "ffmpeg version fixture", probeVersion: async () => "ffprobe version fixture",
    probe: async path => {
      const kind = await which(path);
      if (kind === "groove" || kind === "stem") return { durationSec: GROOVE_SEC, streams: [{ ...songInventory.streams[0]!, durationSec: GROOVE_SEC }] };
      if (kind === "take2") return take2Inventory;
      return kind === "song" ? { ...songInventory, streams: options.songStreams ?? songInventory.streams } : takeInventory;
    },
    frame: async () => { throw new Error("no frames in this fixture"); },
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
        const songSide = await isSong(path); calls.push({ what: songSide ? "song" : "take", startSec, endSec });
        assert.equal(rate, RATE);
        const out = new Float32Array(Math.round((endSec - startSec) * rate));
        for (let i = 0; i < out.length; i++) { const t = startSec + i / rate; out[i] = songSide ? songAt(t) : songAt(SLICE + t - SOUND_LATE); }
        return out;
      },
      grayFrames: async (path, stream, startSec, endSec, frameOptions) => {
        if (frameOptions.fps === null) {
          const kind = await which(path), size = frameOptions.size ?? (() => { const g = regionGeometry(stream.width!, stream.height!, frameOptions.region, frameOptions.edge); return { width: g.outWidth, height: g.outHeight }; })();
          calls.push({ what: `${kind}@${size.width}x${size.height}`, startSec, endSec, region: frameOptions.region });
          const count = Math.round((endSec - startSec) * 30), first = Math.round(startSec * 30);
          const frames = Array.from({ length: count }, (_, k) => {
            const n = first + k, shown = Math.floor(n * 24 / 30) * 2.5;
            return panFrame(size.width, size.height, shown, kind === "take2" ? 1.5 : 1);
          });
          return { frames, width: size.width, height: size.height, fps: 30 };
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
  const media = new ConversationMediaInspection(store, leases, { images, tools }); media.start(runId, stop.signal);
  const retrieval = new WorldChatRetrieval({ leases, getBundle: () => store.getBundle(), getIndex: () => null, attachments: new WorldChatAttachmentStore(dir), findAttachment: async () => null,
    readImage: (lease, args) => images.read(lease, args), readMedia: (lease, name, args) => media.read(lease, name, args) });
  return { store, lease, retrieval, calls, take: { kind: "artifact" as const, id: takeId }, song: { kind: "artifact" as const, id: songId },
    groove: { kind: "artifact" as const, id: grooveId }, stem: { kind: "artifact" as const, id: stemId }, take2: { kind: "artifact" as const, id: take2Id },
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

test("the shared leased MCP catalogue lists measure_sync and serves it", async () => {
  const h = await harness(), server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  let served = ""; server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: receipt => { served = receipt.tool; } });
  const rpc = async (method: string, params?: unknown) => (await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  const listed = await rpc("tools/list") as { result: { tools: Array<{ name: string }> } };
  for (const name of ["measure_sync", "song_map", "clip_quality"]) assert.ok(listed.result.tools.some(tool => tool.name === name), name);
  await rpc("tools/call", { name: "measure_sync", arguments: { source: h.take, range: { startSec: .5, endSec: 3.5 }, reference: { source: h.song, startSec: 2.5 } } });
  assert.equal(served, "measure-sync");
});
