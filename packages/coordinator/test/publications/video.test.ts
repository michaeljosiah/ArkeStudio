import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, toNamespacedPath } from "node:path";
import { it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { applyTimelineCommands, seedEmptyPictureTimeline, type VideoPublicationRequest } from "@arke-studio/contracts";
import { compileVideoPublication, type VideoPublicationCompilerOptions } from "../../src/publications/video.js";
import { verifyPublicationDirectory } from "../../src/publications/verify.js";
import { publishVideoPublication } from "../../src/publications/publish.js";
import { extractPublicationZip } from "../../src/publications/archive.js";
import { parseFfprobeJson } from "../../src/media/probe.js";
import { WorldStore } from "../../src/world/store.js";
import { hashMedia, scanWorld } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

const ARTIFACT = "ar_01J8G0000000000000000000A1";
const bytes = Buffer.from("captured source video");
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t: TestContext) {
  const world = await makeTempWorld(), scratch = await tempDir("arke-compiled-publication-");
  const production = (await scanWorld(world)).bundle.productions.find(item => item.meta.id === "saltlight")!;
  const timeline = applyTimelineCommands(seedEmptyPictureTimeline(production), [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_movie", startFrame: 0, durationFrames: 48, sourceInFrames: 24,
      source: { kind: "artifact", artifactId: ARTIFACT, label: "movie" } } },
    { kind: "add-subtitle-track", trackId: "tr_en", name: "English", language: "en" },
    { kind: "add-cue", trackId: "tr_en", cue: { id: "cu_en", text: "[Bell rings] <hello>", startFrame: 0, endFrame: 36 } },
    { kind: "add-subtitle-track", trackId: "tr_fr", name: "French", language: "fr" },
    { kind: "add-cue", trackId: "tr_fr", cue: { id: "cu_fr", text: "Bonjour", startFrame: 24, endFrame: 72 } },
  ]);
  await mkdir(join(world, "artifacts"), { recursive: true });
  await writeFile(join(world, "artifacts/movie.mp4"), bytes);
  await writeFile(join(world, "artifacts/movie.json"), JSON.stringify({ id: ARTIFACT, kind: "video", file: "movie.mp4",
    hash: hash(bytes), origin: { by: "user" }, links: [], created: "2026-09-01T00:00:00Z",
    mediaInfo: { durationSec: 6, hasAudio: true, hasVideo: true } }));
  const timelinePath = join(world, "productions/saltlight/timeline.json");
  await writeFile(timelinePath, JSON.stringify(timeline));
  const store = await WorldStore.open(world);
  t.after(() => store.close());
  const request: VideoPublicationRequest = { productionId: "saltlight", id: `urn:uuid:${randomUUID()}`, edition: "First",
    title: "Saltlight", language: "en", preset: "review-cut", scope: { kind: "production" }, timelineRevision: timeline.revision,
    textTracks: [ { trackId: "tr_en", kind: "captions", label: "English CC", default: true },
      { trackId: "tr_fr", kind: "subtitles", label: "Français", default: false } ] };
  const invocations: string[][] = [];
  const options: VideoPublicationCompilerOptions = { scratchRoot: scratch, encoderVersion: "test-1",
    encoder: { slateFont: "unused-font", run: async args => { invocations.push(args); await writeFile(args.at(-1)!, "encoded movie"); } },
    probe: { info: async path => ({ durationSec: basename(path) === "movie.mp4" ? 2 : 6, hasAudio: true, hasVideo: true }) } };
  return { world, scratch, store, request, options, invocations, timeline, timelinePath };
}

it("compiles a clean movie and selectable WebVTT from deduplicated captured inputs", async t => {
  const f = await fixture(t);
  let copies = 0;
  const result = await compileVideoPublication(f.store, f.request, { ...f.options, onCopied: () => { copies++; } });
  t.after(() => result.dispose());
  assert.equal(copies, 1, "picture and audio share one captured file");
  const args = f.invocations[0]!;
  const inputs = args.flatMap((arg, i) => arg === "-i" ? [args[i + 1]!] : []);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0], inputs[1]);
  // Hosted Windows can supply an 8.3 TEMP alias; the compiler canonicalizes that root.
  const scratch = await realpath(f.scratch);
  assert.ok(inputs.every(path => {
    const child = relative(toNamespacedPath(scratch), toNamespacedPath(path));
    return !isAbsolute(child) && !child.startsWith("..");
  }));
  assert.ok(!args.join(" ").includes("drawtext"));
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.deepEqual((await readdir(result.directory)).sort(), ["movie.mp4", "publication.json", "text-0.vtt", "text-1.vtt"]);
  assert.equal(await readFile(join(result.directory, "text-0.vtt"), "utf8"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n[Bell rings] &lt;hello&gt;\n");
  assert.match(await readFile(join(result.directory, "text-1.vtt"), "utf8"), /00:00:01.000 --> 00:00:02.000/);
  assert.equal(result.manifest.content.textTracks[0]!.kind, "captions");
  assert.equal(result.manifest.content.textTracks[1]!.language, "fr");
  const serialized = JSON.stringify(result.manifest);
  assert.ok(!serialized.includes(f.world) && !serialized.includes(f.scratch));
  assert.ok(!serialized.includes("selections") && !serialized.includes("prompt"));
  assert.equal((await verifyPublicationDirectory(result.directory)).manifestSha256, result.manifestSha256);
  assert.deepEqual(await readdir(f.scratch), [basename(result.directory)], "captured inputs were disposed");
  await result.dispose(); await result.dispose();
  assert.deepEqual(await readdir(f.scratch), []);
});

it("keeps the same fingerprint for unchanged inputs and changes it for trim or settings", async t => {
  const f = await fixture(t);
  const fingerprints = [];
  for (let i = 0; i < 4; i++) {
    if (i === 2) {
      f.timeline.tracks[0]!.clips[0]!.sourceInFrames = 30;
      await f.store.ownedWrite(() => writeFile(f.timelinePath, JSON.stringify(f.timeline)));
    }
    const result = await compileVideoPublication(f.store, { ...f.request, title: i === 3 ? "New title" : f.request.title }, f.options);
    fingerprints.push(result.manifest.build.dependencyFingerprint);
    await result.dispose();
  }
  assert.equal(fingerprints[0], fingerprints[1]);
  assert.notEqual(fingerprints[1], fingerprints[2], "trim changes without advancing timeline revision still count");
  assert.notEqual(fingerprints[2], fingerprints[3]);
});

it("publishes a production ZIP and retries the captured edition after the source changes", async t => {
  const f = await fixture(t);
  const options = { ...f.options, outputRoot: f.scratch, operationId: randomUUID(), format: "zip" as const };
  const result = await publishVideoPublication(f.store, f.request, options);
  await f.store.ownedWrite(() => writeFile(join(f.world, "artifacts/movie.mp4"), "later source bytes"));
  const retry = await publishVideoPublication(f.store, f.request, options);
  assert.equal(retry.path, result.path); assert.equal(f.invocations.length, 1);
  const extracted = await extractPublicationZip(result.path, f.scratch);
  try { assert.equal(extracted.manifest.content.textTracks.length, 2); }
  finally { await extracted.dispose(); }
  await assert.rejects(publishVideoPublication(f.store, { ...f.request, title: "Another edition" }, options), { code: "operation-conflict" });
});

for (const change of ["media", "new-record", "timeline"] as const) {
  it(`rejects ${change} changes during capture before starting the encoder`, async t => {
    const f = await fixture(t);
    await assert.rejects(compileVideoPublication(f.store, f.request, { ...f.options, onCopied: async () => {
      if (change === "media") await writeFile(join(f.world, "artifacts/movie.mp4"), "replaced media");
      else if (change === "timeline") await writeFile(f.timelinePath, "{}");
      else await writeFile(join(f.world, "artifacts/new.json"), JSON.stringify({ id: "ar_01J8G0000000000000000NEW01", kind: "image",
        file: "new.png", hash: `sha256:${"b".repeat(64)}`, origin: { by: "user" }, links: [], created: "2026-09-01T00:00:00Z" }));
    } }), { code: "source-changed" });
    assert.equal(f.invocations.length, 0);
    assert.deepEqual(await readdir(f.scratch), []);
  });
}

it("releases the gate after capture and never renders subsequent world edits", async t => {
  const f = await fixture(t);
  const result = await compileVideoPublication(f.store, f.request, { ...f.options, encoder: { ...f.options.encoder, run: async args => {
    await f.store.ownedWrite(() => writeFile(join(f.world, "artifacts/movie.mp4"), "later edit"));
    const path = args[args.indexOf("-i") + 1]!;
    assert.deepEqual(await readFile(path), bytes);
    await writeFile(args.at(-1)!, "encoded movie");
  } } });
  await result.dispose();
});

for (const failure of ["cancel-capture", "cancel-render", "encoder", "bad-movie", "bad-range", "limit", "close"] as const) {
  it(`cleans up its own inputs and output after ${failure}`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.scratch, "keep.txt"), "someone else's file");
    const controller = new AbortController();
    let closing: Promise<void> | undefined;
    const options = { ...f.options, signal: controller.signal };
    if (failure === "cancel-capture") options.onCopied = () => controller.abort();
    if (failure === "bad-movie") options.probe = { info: async path => ({ durationSec: basename(path) === "movie.mp4" ? 99 : 6, hasVideo: true, hasAudio: true }) };
    if (failure === "bad-range") options.probe = { info: async () => ({ durationSec: 0.5, hasVideo: true, hasAudio: true }) };
    if (failure === "limit") options.limits = { assetBytes: 2 };
    if (["cancel-render", "encoder", "close"].includes(failure)) options.encoder = { ...f.options.encoder, run: async args => {
      await writeFile(args.at(-1)!, "partial");
      if (failure === "encoder") throw new Error("encoder failed");
      if (failure === "close") closing = f.store.close();
      else controller.abort();
    } };
    await assert.rejects(compileVideoPublication(f.store, f.request, options));
    await closing;
    assert.deepEqual(await readdir(f.scratch), ["keep.txt"]);
  });
}

it("refuses invalid timelines and missing tracks without encoding", async t => {
  const f = await fixture(t);
  await assert.rejects(compileVideoPublication(f.store, { ...f.request, textTracks: [{ ...f.request.textTracks[0]!, trackId: "tr_missing" }] }, f.options), /not on the timeline/);
  await f.store.ownedWrite(() => writeFile(f.timelinePath, "{}"));
  await assert.rejects(compileVideoPublication(f.store, { ...f.request, timelineRevision: null }, f.options), /Invalid source/);
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(await readdir(f.scratch), []);
});

it("allows deliberate blank picture with no input media and no captions", async t => {
  const f = await fixture(t);
  f.timeline.tracks[0]!.muted = true;
  await f.store.ownedWrite(() => writeFile(f.timelinePath, JSON.stringify(f.timeline)));
  const result = await compileVideoPublication(f.store, { ...f.request, textTracks: [] }, f.options);
  try {
    assert.deepEqual(result.manifest.requires, ["video-v1"]);
    assert.deepEqual(result.manifest.content.textTracks, []);
    assert.deepEqual((await readdir(result.directory)).sort(), ["movie.mp4", "publication.json"]);
    assert.ok(f.invocations[0]!.includes("lavfi"));
  } finally { await result.dispose(); }
});

it("refuses replaced artifact bytes and missing source files before encoding", async t => {
  const f = await fixture(t);
  await f.store.ownedWrite(() => writeFile(join(f.world, "artifacts/movie.mp4"), "changed source"));
  await assert.rejects(compileVideoPublication(f.store, f.request, f.options), /Artifact bytes no longer match/);
  const sidecarPath = join(f.world, "artifacts/movie.json");
  const artifact = JSON.parse(await readFile(sidecarPath, "utf8"));
  artifact.file = "missing.mp4";
  await f.store.ownedWrite(() => writeFile(sidecarPath, JSON.stringify(artifact)));
  await assert.rejects(compileVideoPublication(f.store, f.request, f.options));
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(await readdir(f.scratch), []);
});

it("refuses changed take bytes even when sound is muted, but allows genuinely unmeasured picture", async t => {
  const f = await fixture(t);
  const takeId = "tk_01J8F0000000000000000000B2";
  const takeDir = join(f.world, "productions/saltlight/takes", takeId);
  await writeFile(join(takeDir, "clip.mp4"), bytes);
  await writeFile(join(takeDir, "media-info.json"), JSON.stringify({ sourceHash: hash(Buffer.from("reviewed bytes")),
    probedAt: "2026-09-01T00:00:00Z", mediaInfo: { durationSec: 6, hasVideo: true, hasAudio: true } }));
  f.timeline.tracks[0]!.clips[0]!.source = { kind: "take", takeId, label: "Selected take" };
  f.timeline.tracks[0]!.clips[0]!.audio = "mute";
  await f.store.ownedWrite(() => writeFile(f.timelinePath, JSON.stringify(f.timeline)));
  await assert.rejects(compileVideoPublication(f.store, f.request, f.options), /Take bytes no longer match/);
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(await readdir(f.scratch), []);
  await f.store.ownedWrite(() => writeFile(join(takeDir, "media-info.json"), JSON.stringify({ sourceHash: hash(bytes),
    probedAt: "2026-09-01T00:00:00Z", mediaInfo: { durationSec: 6, hasVideo: true, hasAudio: true } })));
  const measured = await compileVideoPublication(f.store, f.request, f.options);
  await measured.dispose();
  await f.store.ownedWrite(() => unlink(join(takeDir, "media-info.json")));
  const result = await compileVideoPublication(f.store, f.request, f.options);
  await result.dispose();
});

it("keeps a publication fingerprint when unordered rehearsal records are recreated in another order", async t => {
  const f = await fixture(t);
  const ids = ["rh_01J8G0000000000000000000A1", "rh_01J8G0000000000000000000A2"];
  const root = join(f.world, "productions/saltlight/rehearsals");
  await mkdir(root, { recursive: true });
  const sceneId = f.store.getBundle().productions.find(item => item.meta.id === "saltlight")!.scenes[0]!.id;
  const write = async (order: string[]) => {
    for (const id of order) await writeFile(join(root, `${id}.json`), JSON.stringify({ id, sceneId, sceneVersionAtStart: 1,
      notes: {}, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }));
  };
  await write([...ids].reverse());
  const first = await compileVideoPublication(f.store, f.request, f.options);
  const expected = first.manifest.build.dependencyFingerprint;
  await first.dispose();
  for (const id of ids) await unlink(join(root, `${id}.json`));
  await write(ids);
  const scanned = await scanWorld(f.world, { includeOperationalState: false });
  assert.deepEqual(scanned.bundle.productions.find(item => item.meta.id === "saltlight")!.rehearsals.map(item => item.id), ids);
  const second = await compileVideoPublication(f.store, f.request, f.options);
  try { assert.equal(second.manifest.build.dependencyFingerprint, expected); }
  finally { await second.dispose(); }
});

it("rejects a video overlay whose source ends before its authored window", async t => {
  const f = await fixture(t);
  const timeline = applyTimelineCommands(f.timeline, [
    { kind: "add-track", trackId: "tr_overlay", trackKind: "picture", name: "Overlay" },
    { kind: "place", trackId: "tr_overlay", clip: { id: "cl_overlay", startFrame: 0, durationFrames: 48, sourceInFrames: 120,
      audio: "mute", source: { kind: "artifact", artifactId: ARTIFACT, label: "Overlay" } } },
  ]);
  await f.store.ownedWrite(() => writeFile(f.timelinePath, JSON.stringify(timeline)));
  await assert.rejects(compileVideoPublication(f.store, { ...f.request, timelineRevision: timeline.revision }, f.options), /source range/);
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(await readdir(f.scratch), []);
});

it("aborts discovery and streamed media hashing instead of returning partial scan state", async t => {
  const world = await makeTempWorld();
  const scanAbort = new AbortController();
  const scan = scanWorld(world, { signal: scanAbort.signal, includeOperationalState: false });
  scanAbort.abort();
  await assert.rejects(scan, { name: "AbortError" });
  const root = await tempDir("arke-publication-hash-");
  const path = join(root, "large.mp4");
  const file = await open(path, "wx");
  try { await file.truncate(128 * 1024 * 1024); } finally { await file.close(); }
  const controller = new AbortController();
  const hashing = hashMedia(path, controller.signal);
  const timer = setTimeout(() => controller.abort(), 5);
  t.after(() => clearTimeout(timer));
  await assert.rejects(hashing, { name: "AbortError" });
  await writeFile(path, bytes);
  assert.equal(await hashMedia(path), hash(bytes), "an aborted read never populates the hash cache");
});

it("cancellation during discovery releases the read gate without a post-capture scan", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const capturedRead = f.store.ownedRead.bind(f.store);
  let entered = false;
  t.mock.method(f.store, "ownedRead", async <T>(fn: () => Promise<T>) => capturedRead(async () => {
    entered = true;
    const result = fn();
    controller.abort();
    return result;
  }));
  await assert.rejects(compileVideoPublication(f.store, f.request, { ...f.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(entered, true);
  await f.store.ownedWrite(() => writeFile(join(f.world, "artifacts/after-cancel.txt"), "gate released"));
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(await readdir(f.scratch), []);
});

it("encodes and probes a real captured MP4 with selectable captions", { skip: !process.env.ARKE_TEST_FFMPEG || !process.env.ARKE_TEST_FFPROBE }, async t => {
  const f = await fixture(t), execute = promisify(execFile);
  const ffmpeg = process.env.ARKE_TEST_FFMPEG!, ffprobe = process.env.ARKE_TEST_FFPROBE!;
  await execute(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=128x72:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(f.world, "artifacts/movie.mp4")], { windowsHide: true });
  const artifactPath = join(f.world, "artifacts/movie.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  artifact.hash = hash(await readFile(join(f.world, "artifacts/movie.mp4")));
  artifact.mediaInfo.durationSec = 4;
  await writeFile(artifactPath, JSON.stringify(artifact));
  const version = (await execute(ffmpeg, ["-version"], { windowsHide: true })).stdout.split(/\r?\n/)[0]!;
  const result = await publishVideoPublication(f.store, f.request, { ...f.options, encoderVersion: version,
    operationId: randomUUID(), outputRoot: f.scratch, format: "zip",
    encoder: { slateFont: "unused", run: async (args, _progress, signal) => { await execute(ffmpeg, args, { signal, windowsHide: true }); } },
    probe: { info: async (path, opts) => parseFfprobeJson((await execute(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { signal: opts?.signal, windowsHide: true })).stdout) },
  });
  const extracted = await extractPublicationZip(result.path, f.scratch);
  try {
    assert.equal(result.manifest.content.textTracks.length, 2);
    await execute(ffmpeg, ["-v", "error", "-i", join(extracted.directory, "movie.mp4"), "-f", "null", "-"], { windowsHide: true });
    assert.ok(result.manifest.assets.movie!.byteLength > 1000);
  } finally { await extracted.dispose(); }
});
