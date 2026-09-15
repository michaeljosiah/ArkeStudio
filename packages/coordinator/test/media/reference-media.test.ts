import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Job, ManifestModel } from "@arke-studio/contracts";
import { checkSeedanceVideo, prepareReferenceVideo } from "../../src/media/reference-media.js";
import { prepareReferences, validateSeedanceReferences } from "../../src/media/prepare-references.js";
import { readContainedAudioReferences } from "../../src/world/reference-files.js";
import type { WorldStore } from "../../src/world/store.js";
import { tempDir } from "../tmp.js";
import { createHash } from "node:crypto";

test("Seedance admission refuses the actual inline size before probing or enqueue", async () => {
  const dir = await tempDir("arke-seedance-admission-");
  const file = await open(join(dir, "large.mp4"), "w");
  try { await file.truncate(48 * 1024 * 1024 + 1); } finally { await file.close(); }
  const model = { id: "seedance-2.5", limits: { referenceSyntax: "seedance" } } as ManifestModel;
  await assert.rejects(validateSeedanceReferences({ dir } as WorldStore, { params: { videoReferences: ["large.mp4"] } }, model, {}), /48 MB inline limit/);
});

test("a carried predecessor supplies the combined minimum for short attached clips", async () => {
  const dir = await tempDir("arke-seedance-carried-");
  const data = Buffer.concat(["ftyp", "moov", "mdat"].map(tag => {
    const box = Buffer.alloc(8); box.writeUInt32BE(8); box.write(tag, 4); return box;
  }));
  await writeFile(join(dir, "short.mp4"), data);
  const model = { id: "seedance-2.0", accepts: { referenceVideos: 3 }, limits: {
    referenceSyntax: "seedance", minReferenceVideoSec: 2, maxReferenceVideoSec: 15,
  } } as ManifestModel;
  const probe = { durationSec: async () => 1, info: async () => ({ durationSec: 1, width: 1280, height: 720, hasAudio: false }) };
  const params = { videoReferences: ["short.mp4"], referenceMedia: [
    { kind: "video", file: "short.mp4", hash: createHash("sha256").update(data).digest("hex"), durationSec: 1 },
  ] };
  const takeDir = join(dir, "productions", "test", "takes", "prior");
  await mkdir(takeDir, { recursive: true });
  await writeFile(join(takeDir, "clip.mp4"), data);
  const store = { dir, getBundle: () => ({ productions: [{ meta: { id: "test" }, takes: [{ id: "prior", media: "clip.mp4" }] }] }) } as unknown as WorldStore;
  const job = { productionId: "test", params: { ...params, continuedFrom: "prior" } };
  await validateSeedanceReferences(store, job, model, { probe });
  await assert.rejects(validateSeedanceReferences(store, { params }, model, { probe }), /combined duration/);
  await assert.rejects(validateSeedanceReferences(store, { productionId: "test", params: { continuedFrom: "prior" } }, model, {}), /local media tools/);
  await assert.rejects(validateSeedanceReferences(store, job, model, { probe: { ...probe, info: async () => ({ durationSec: 16, width: 1280, height: 720, hasAudio: false }) } }), /duration/);
  const file = await open(join(takeDir, "clip.mp4"), "w");
  try { await file.truncate(48 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(validateSeedanceReferences(store, job, model, { probe }), /inline reference size limit/);
});

test("video preparation uses 24 fps, preserves sound, and removes its private files", async () => {
  for (const hasAudio of [true, false]) {
    let args: string[] = [], path = "";
    const prepared = await prepareReferenceVideo({ contentType: "video/mp4", data: Uint8Array.from([1, 2]) }, {
      probe: { durationSec: async () => 2, info: async file => ({ durationSec: 2, hasAudio: file.endsWith("reference.mp4") || hasAudio }) },
      ffmpeg: { slateFont: "", run: async command => { args = command; path = command.at(-1)!; await writeFile(path, Uint8Array.from([7, 8])); } },
    }, new AbortController().signal);
    assert.equal(prepared.referenceVideo24fps, true);
    assert.equal(prepared.durationSec, 2);
    assert.ok(args.includes("fps=24,scale=864:480:force_original_aspect_ratio=decrease:force_divisible_by=32"));
    assert.equal(args.includes("anullsrc=r=32000:cl=stereo"), !hasAudio);
    await assert.rejects(access(dirname(path)));
  }
});

test("unknown and overlong reference videos refuse without encoding", async () => {
  for (const duration of [null, 1, 16]) {
    let called = false;
    await assert.rejects(prepareReferenceVideo({ contentType: "video/mp4", data: Uint8Array.from([1]) }, {
      probe: { durationSec: async () => duration, info: async () => duration === null ? null : { durationSec: duration, hasAudio: false } },
      ffmpeg: { slateFont: "", run: async () => { called = true; } },
    }, new AbortController().signal));
    assert.equal(called, false);
  }
});

test("standalone audio uses world containment and its reviewed hash", async () => {
  const dir = await tempDir("arke-h3-audio-test-");
  const data = Uint8Array.from([1, 2, 3]);
  await writeFile(join(dir, "tone.wav"), data);
  await assert.rejects(readContainedAudioReferences(dir, ["../tone.wav"]));
  const model = { limits: { referenceSyntax: "minimax-h3" } } as ManifestModel;
  const job = { params: { referenceMedia: [{ kind: "audio", file: "tone.wav", hash: `sha256:${createHash("sha256").update(data).digest("hex")}`, durationSec: 2 }] } } as unknown as Job;
  const store = { dir } as WorldStore;
  const tools = { probe: { durationSec: async () => 2, info: async () => ({ durationSec: 2, hasAudio: true }) } };
  const result = await prepareReferences(store, job, model, [], tools, new AbortController().signal);
  assert.deepEqual(result.audio[0]!.data, data);
  assert.equal(result.audio[0]!.durationSec, 2);
  await writeFile(join(dir, "tone.wav"), Uint8Array.from([9]));
  await assert.rejects(prepareReferences(store, job, model, [], tools, new AbortController().signal), /changed since review/);
});

test("real 30 fps silent input becomes a 24 fps reference with an audio slot", { skip: !process.env.ARKE_TEST_FFMPEG || !process.env.ARKE_TEST_FFPROBE }, async () => {
  const dir = await tempDir("arke-h3-fps-test-");
  const execute = promisify(execFile), ffmpeg = process.env.ARKE_TEST_FFMPEG!, ffprobe = process.env.ARKE_TEST_FFPROBE!;
  const source = join(dir, "source.mp4");
  await execute(ffmpeg, ["-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=256x256:r=30:d=2", "-c:v", "libx264", source], { windowsHide: true });
  const probe = async (file: string) => JSON.parse((await execute(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { windowsHide: true })).stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; r_frame_rate?: string }> };
  const result = await prepareReferenceVideo({ contentType: "video/mp4", data: await readFile(source) }, {
    probe: { durationSec: async file => Number((await probe(file)).format.duration), info: async file => { const value = await probe(file); return { durationSec: Number(value.format.duration), hasAudio: value.streams.some(stream => stream.codec_type === "audio") }; } },
    ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await execute(ffmpeg, args, { windowsHide: true, signal }); } },
  }, new AbortController().signal);
  const target = join(dir, "result.mp4");
  await writeFile(target, result.data);
  const measured = await probe(target);
  assert.equal(measured.streams.find(stream => stream.codec_type === "video")!.r_frame_rate, "24/1");
  assert.equal(measured.streams.some(stream => stream.codec_type === "audio"), true);
  assert.ok(Math.abs(Number(measured.format.duration) - 2) < 0.15);
});

test("Seedance probes dimensions before dispatch, retains bytes and refuses out-of-range media", async () => {
  const model = { id: "seedance-2.0", accepts: { referenceVideos: 3 }, limits: { referenceSyntax: "seedance",
    maxReferenceVideoSec: 15, minReferenceVideoSec: 2, maxReferenceVideoBytes: 50_000_000,
    referenceVideoPixels: { min: 409600, max: 927408 } } } as ManifestModel;
  let width = 1280, height = 720, durationSec = 4;
  const input = { contentType: "video/mp4", data: Uint8Array.from([1, 2]) };
  const probe = { durationSec: async () => durationSec, info: async () => ({ width, height, durationSec, hasAudio: false, hasVideo: true, frameRate: 30 }) };
  const signal = new AbortController().signal;
  assert.deepEqual(await checkSeedanceVideo(input, model, probe, signal), { ...input, durationSec: 4 });
  width = 1920; height = 1080;
  await assert.rejects(checkSeedanceVideo(input, model, probe, signal), /resolution/);
  width = 1280; height = 720; durationSec = 16;
  await assert.rejects(checkSeedanceVideo(input, model, probe, signal), /duration/);
  durationSec = 8;
  const store = { dir: await tempDir("arke-seedance-budget-") } as WorldStore;
  await assert.rejects(prepareReferences(store, { params: {} } as Job, model, [
    { ...input, contentType: "video/mp4" }, { ...input, contentType: "video/mp4" },
  ], { probe }, signal), /combined duration/);
  durationSec = 4;
  const continued = await prepareReferences(store, { params: { continuedFrom: "previous-take", videoReferences: ["stage.mp4"],
    referenceMedia: [{ kind: "video", file: "stage.mp4", hash: createHash("sha256").update(input.data).digest("hex"), durationSec: 4 }],
  } }, model, [
    { contentType: "video/mp4", data: Uint8Array.from([3, 4]) }, { ...input, contentType: "video/mp4" },
  ], { probe }, signal);
  assert.equal(continued.videos.length, 2, "the predecessor is probed separately from the reviewed Bench binding");
});

test("carried segment preflight refuses lost ownership before materializing", async () => {
  const dir = await tempDir("arke-seedance-owned-");
  const store = { dir,
    getBundle: () => ({ productions: [{ meta: { id: "test" }, takes: [{ id: "segment", segment: { passTakeId: "pass", inSec: 0, outSec: 4 } }] }] }),
    ownedWrite: async () => { throw new Error("World ownership was lost"); },
  } as unknown as WorldStore;
  let encoded = false;
  const model = { limits: { referenceSyntax: "seedance" } } as ManifestModel;
  await assert.rejects(validateSeedanceReferences(store, { productionId: "test", params: { continuedFrom: "segment" } }, model, {
    probe: { durationSec: async () => 4, info: async () => ({ durationSec: 4, hasAudio: false }) },
    ffmpeg: { slateFont: "", run: async () => { encoded = true; } },
  }), /ownership was lost/);
  assert.equal(encoded, false);
  await assert.rejects(access(join(dir, "productions")));
});
