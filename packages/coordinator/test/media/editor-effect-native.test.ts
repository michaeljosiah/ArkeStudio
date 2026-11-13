import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { applyTimelineCommands, ArtifactSidecarSchema, buildFfmpegArgs, buildRenderPlan, compositeRgba, addWeightedPicture, compositeWeightedTrack, defaultEffectClip, EFFECT_PRESET_CATALOGUE, pictureMotionAt,
  pictureMotionProgress, pictureMotionWindow, pictureSourceSec, PICTURE_SAMPLE_TOLERANCE_SEC, pictureTransitionWeight, prepareEffectReactions, renderEffectLayersRgba, seedEmptyPictureTimeline, textLabel, textPicturePath,
  type ExportPlan, type ProductionBundle, type RenderPictureLayer, type TextLook, type TimelineClip } from "@arke-studio/contracts";
import { analysisFixture } from "./effect-analysis-fixture.js";
import { createNodeEffectRasterHost } from "../../src/media/node-effect-renderer.js";
import { createNodeMediaProcessRunner, createNodeFfmpegRunner } from "../../src/media/node-media-host.js";
import { paintTextPicture, textPicturePng } from "../../src/productions/editor-text-pictures.js";

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg", ffprobe = process.env["ARKE_FFPROBE"] ?? "ffprobe";
const signal = () => new AbortController().signal;
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe });
const hasFfmpeg = (await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10_000, maxStdoutBytes: 32_768, maxStderrBytes: 32_768 })).code === 0;
if (process.env["ARKE_EFFECT_NATIVE_REQUIRED"] === "1") assert.equal(hasFfmpeg, true, "Native effect acceptance requires FFmpeg");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidence = process.env["ARKE_EFFECT_EVIDENCE_DIR"];
if (evidence) await mkdir(resolve(evidence), { recursive: true });
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10_000, maxStdoutBytes: 32_768, maxStderrBytes: 32_768 });
const report: Record<string, unknown> = { ffmpegVersion: new TextDecoder().decode(version.stdout).split("\n")[0], platform: process.platform, node: process.version };
async function evidenceReport() { if (evidence) await writeFile(join(resolve(evidence), "native-effects.json"), JSON.stringify(report, null, 2)); }
async function fixtureDir(name: string) { return mkdtemp(join(evidence ? resolve(evidence) : tmpdir(), `arke-effect-${name}-`)); }

async function processBytes(args: string[], input?: Uint8Array): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(Buffer.concat(stderr).toString())));
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
async function alphaFile(path: string, pixels: Uint8Array | Uint8ClampedArray, count = 4) {
  await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", "24", "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", "-f", "matroska", path], Buffer.concat(Array.from({ length: count }, () => Buffer.from(pixels))));
}

test("native odd-frame crossfade with transparent stills, scoped effects and upper tracks matches preview at every cropped frame", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("crossfade"), count = 5;
  try {
    const a = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 128, 255, 0, 0, 0, 255, 0, 0, 64]);
    const b = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 128, 0, 0, 255, 0]);
    const scoped = new Uint8ClampedArray(Array.from({ length: 4 }, () => [240, 160, 10, 64]).flat());
    const upper = new Uint8ClampedArray(Array.from({ length: 4 }, () => [20, 210, 80, 64]).flat());
    const composition = new Uint8ClampedArray(Array.from({ length: 4 }, () => [220, 220, 250, 32]).flat());
    for (const [name, pixels] of [["a", a], ["b", b]] as const) await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-i", "pipe:0", "-frames:v", "1", join(dir, `${name}.png`)], Buffer.from(pixels));
    await alphaFile(join(dir, "scoped.mkv"), scoped, count); await alphaFile(join(dir, "upper.mkv"), upper, count); await alphaFile(join(dir, "composition.mkv"), composition, count);
    const fade = { startFrame: 48, durationFrames: 5 };
    const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
      effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 53, effectLayers: [], issues: [], pictureLayers: [
        { clipId: "a", trackId: "picture", order: 0, kind: "media", label: "A", path: "a.png", still: true, startFrame: 0, endFrame: 53, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha", fadeOut: fade },
        { clipId: "b", trackId: "picture", order: 1, kind: "media", label: "B", path: "b.png", still: true, startFrame: 48, endFrame: 100, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha", fadeIn: fade },
        { clipId: "upper", trackId: "upper", order: 2, kind: "media", label: "Upper", path: "upper.mkv", still: false, startFrame: 48, endFrame: 53, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha" },
      ] } };
    const output = join(dir, "crossfade.mkv"), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", [
      { pictureClipId: "a", path: join(dir, "scoped.mkv"), startFrame: 48, endFrame: 53 }, { path: join(dir, "composition.mkv"), startFrame: 48, endFrame: 53 }]);
    args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
    const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * 16);
    let maxError = 0;
    for (let frame = 0; frame < count; frame++) {
      const expected = new Uint8ClampedArray(Array.from({ length: 4 }, () => [0, 0, 0, 255]).flat()), track = new Float32Array(16);
      addWeightedPicture(track, compositeRgba(a.slice(), scoped, "atop"), 1 - frame / count, { x: 0, y: 0, width: 2, height: 2 }, 2);
      addWeightedPicture(track, b, frame / count, { x: 0, y: 0, width: 2, height: 2 }, 2);
      compositeWeightedTrack(expected, track); compositeRgba(expected, upper); compositeRgba(expected, composition);
      for (let channel = 0; channel < 16; channel++) maxError = Math.max(maxError, Math.abs(pixels[frame * 16 + channel]! - expected[channel]!));
    }
    assert.ok(maxError <= 4, `crossfade channel error ${maxError}`); report.crossfade = { maxChannelError: maxError, frames: count, absoluteStartFrame: 48, durationFrames: 5 };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("native Screen/Add clip and scoped/composition blending agrees across an alpha crossfade", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("picture-blend"), count = 5;
  try {
    const lower = new Uint8ClampedArray([30, 50, 80, 255, 100, 20, 90, 128, 0, 0, 0, 255, 80, 120, 50, 255]);
    const a = new Uint8ClampedArray([150, 80, 20, 255, 150, 80, 20, 128, 150, 80, 20, 0, 150, 80, 20, 64]);
    const b = new Uint8ClampedArray([20, 90, 180, 64, 20, 90, 180, 255, 20, 90, 180, 128, 20, 90, 180, 0]);
    const particles = new Uint8ClampedArray(Array.from({ length: 4 }, () => [100, 60, 30, 80]).flat());
    for (const [name, pixels] of [["a", a], ["b", b], ["lower", lower], ["particles", particles]] as const) await alphaFile(join(dir, `${name}.mkv`), pixels, count);
    for (const mode of ["screen", "add"] as const) {
      const fade = { startFrame: 48, durationFrames: 5 };
      const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
        effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 53, effectLayers: [], issues: [], pictureLayers:
          ["lower", "a", "b"].map((name, order) => ({ clipId: name, trackId: name === "lower" ? "lower" : "upper", order, kind: "media", label: name,
            path: `${name}.mkv`, still: false, startFrame: 48, endFrame: 53, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha",
            ...(name === "a" ? { blendMode: mode, opacity: .65, fadeOut: fade } : name === "b" ? { blendMode: "screen" as const, opacity: .8, fadeIn: fade } : {}) })) } };
      const output = join(dir, `${mode}.mkv`), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", [
        { pictureClipId: "a", blendMode: mode, path: join(dir, "particles.mkv"), startFrame: 48, endFrame: 53 },
        { blendMode: mode, path: join(dir, "particles.mkv"), startFrame: 48, endFrame: 53 }]);
      args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
      const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * 16);
      let maxError = 0;
      for (let frame = 0; frame < count; frame++) {
        const expected = new Uint8ClampedArray(Array.from({ length: 4 }, () => [0, 0, 0, 255]).flat()), track = new Float32Array(16);
        compositeRgba(expected, lower);
        addWeightedPicture(track, compositeRgba(a.slice(), particles, "atop", mode), 1 - frame / count, { x: 0, y: 0, width: 2, height: 2 }, 2, expected, mode, .65);
        addWeightedPicture(track, b, frame / count, { x: 0, y: 0, width: 2, height: 2 }, 2, expected, "screen", .8);
        compositeWeightedTrack(expected, track); compositeRgba(expected, particles, "over", mode);
        for (let channel = 0; channel < 16; channel++) maxError = Math.max(maxError, Math.abs(pixels[frame * 16 + channel]! - expected[channel]!));
      }
      assert.ok(maxError <= 4, `${mode} channel error ${maxError}`); report[`picture-${mode}`] = { maxChannelError: maxError, frames: count };
    }
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("real FFmpeg source-atop alpha, picture order, composition order and absolute window agree with the integer compositor", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("parity"), start = performance.now();
  try {
    const lower = new Uint8ClampedArray([20, 80, 180, 0, 20, 80, 180, 32, 20, 80, 180, 128, 20, 80, 180, 255]);
    const scoped = new Uint8ClampedArray(Array.from({ length: 4 }, () => [230, 30, 50, 128]).flat());
    const upper = new Uint8ClampedArray(Array.from({ length: 4 }, () => [20, 210, 80, 64]).flat());
    const atmosphere = new Uint8ClampedArray(Array.from({ length: 4 }, () => [220, 220, 250, 32]).flat());
    await alphaFile(join(dir, "lower.mkv"), lower); await alphaFile(join(dir, "upper.mkv"), upper);
    await alphaFile(join(dir, "scoped.mkv"), scoped); await alphaFile(join(dir, "atmosphere.mkv"), atmosphere);
    const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 4 / 24,
      effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 52, effectLayers: [], issues: [], pictureLayers:
        ["lower", "upper"].map((name, order) => ({ clipId: name, trackId: name, order, kind: "media", label: name, path: `${name}.mkv`, still: false,
          startFrame: 48, endFrame: 52, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha" })) } };
    const output = join(dir, "result.mkv");
    const args = buildFfmpegArgs(plan, dir, output, "unused.ttf", [
      { pictureClipId: "lower", path: join(dir, "scoped.mkv"), startFrame: 48, endFrame: 52 },
      { path: join(dir, "atmosphere.mkv"), startFrame: 48, endFrame: 52 }]);
    const pixelFormat = args.indexOf("-pix_fmt"); args[pixelFormat + 1] = "bgra";
    args.splice(args.length - 1, 0, "-c:v", "ffv1");
    const graphOption = await createNodeFfmpegRunner(ffmpeg, "unused.ttf").graphFileOption!(signal());
    const graphIndex = args.indexOf("-filter_complex"), graph = join(dir, "effect composition.ffgraph");
    await writeFile(graph, args[graphIndex + 1]!);
    args.splice(graphIndex, 2, graphOption, graph);
    await processBytes(args);
    const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    const expected = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    compositeRgba(expected, compositeRgba(lower.slice(), scoped, "atop")); compositeRgba(expected, upper); compositeRgba(expected, atmosphere);
    assert.equal(pixels.length, 4 * 2 * 2 * 4);
    const differences = [...pixels.subarray(0, 16)].map((value, index) => Math.abs(value - expected[index]!));
    assert.ok(Math.max(...differences) <= 2, `native/source compositor difference ${Math.max(...differences)}; actual=${[...pixels.subarray(0, 16)]}, expected=${[...expected]}`);
    for (let frame = 1; frame < 4; frame++) assert.deepEqual(pixels.subarray(frame * 16, (frame + 1) * 16), pixels.subarray(0, 16));
    report.sourceAtop = { graphFileOption: graphOption, maxChannelError: Math.max(...differences), frames: 4, alpha: [0, 32, 128, 255], absoluteStartFrame: 48, durationMs: performance.now() - start };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("real native worker alpha is byte-identical to shared raster, probes images, and cancellation removes its intermediate", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("worker"), start = performance.now();
  try {
    const workerPath = join(dir, "effect-raster-worker.cjs");
    await build({ entryPoints: [join(root, "packages/coordinator/src/media/effect-raster-worker.ts")], outfile: workerPath, bundle: true, platform: "node", format: "cjs", target: "node22" });
    const host = createNodeEffectRasterHost({ ffmpeg, workerPath, mediaProcess: media });
    const effect = defaultEffectClip({ id: "cl_01ARZ3NDEKTSV4RRFFQ69G5FAV", lineageId: "ef_01ARZ3NDEKTSV4RRFFQ69G5FAV", startFrame: 0, durationFrames: 240, preset: "lights", seed: 42 });
    const output = join(dir, "alpha.mkv");
    await host.renderAlpha({ effects: [effect], width: 64, height: 64, frameRate: 24, startFrame: 48, frameCount: 3, output, signal: signal() });
    const decoded = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    for (let frame = 0; frame < 3; frame++) assert.deepEqual(decoded.subarray(frame * 64 * 64 * 4, (frame + 1) * 64 * 64 * 4), Buffer.from(renderEffectLayersRgba([effect], 48 + frame, 24, 64, 64)));
    const image = join(dir, "image.png"); await processBytes(["-y", "-i", output, "-frames:v", "1", image]);
    assert.deepEqual(await host.probePicture(image, signal()), { width: 64, height: 64 });
    const controller = new AbortController(), cancelled = join(dir, "cancelled.mkv");
    await assert.rejects(host.renderAlpha({ effects: [effect], width: 64, height: 64, frameRate: 24, startFrame: 48, frameCount: 240,
      output: cancelled, signal: controller.signal, onProgress: () => controller.abort() }), /cancel/i);
    assert.ok(!(await readdir(dir)).includes("cancelled.mkv"));
    const budgetOutput = join(dir, "budget.mkv");
    await assert.rejects(host.renderAlpha({ effects: [effect], width: 64, height: 64, frameRate: 24, startFrame: 48, frameCount: 30,
      maxBytes: 1024, output: budgetOutput, signal: signal() }));
    assert.ok(!(await readdir(dir)).includes("budget.mkv"));
    await assert.rejects(host.renderAlpha({ effects: [{ ...effect, reaction: { ...effect.reaction, enabled: true } }], width: 64, height: 64,
      frameRate: 24, startFrame: 48, frameCount: 3, output: join(dir, "unready.mkv"), signal: signal() }), /analysis/);
    const first = analysisFixture(), second = analysisFixture({ energy: .2, binding: { kind: "audio-track", trackId: "tr_second" } });
    const manifestsByKey = { [first.manifestKey]: first, [second.manifestKey]: second };
    const reactiveLayers = [first, second].map((manifest, i) => ({ ...effect, id: `cl_reactive_${i}`, seed: i + 42,
      audioInput: manifest.descriptor.binding, reaction: { ...effect.reaction, enabled: true, strength: .9, property: "speed" as const } }));
    const manifestKeyByEffectId = { [reactiveLayers[0]!.id]: first.manifestKey, [reactiveLayers[1]!.id]: second.manifestKey };
    const prepared = prepareEffectReactions(reactiveLayers, manifestsByKey, manifestKeyByEffectId, { startFrame: 48, endFrame: 51 });
    const reactiveOutput = join(dir, "reactive.mkv");
    await host.renderAlpha({ effects: reactiveLayers, width: 64, height: 64, frameRate: 24, startFrame: 48, frameCount: 3,
      manifestsByKey, manifestKeyByEffectId, output: reactiveOutput, signal: signal() });
    const reactivePixels = await processBytes(["-i", reactiveOutput, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    assert.notDeepEqual(reactivePixels.subarray(0, 64 * 64 * 4), Buffer.from(renderEffectLayersRgba(reactiveLayers, 48, 24, 64, 64)), "ready reaction must change rendered pixels");
    for (let frame = 0; frame < 3; frame++) assert.deepEqual(reactivePixels.subarray(frame * 64 * 64 * 4, (frame + 1) * 64 * 64 * 4),
      Buffer.from(renderEffectLayersRgba(reactiveLayers, 48 + frame, 24, 64, 64, prepared)));
    report.reactiveWorker = { alphaByteError: 0, independentlyBoundEffects: 2, frames: 3, absoluteStartFrame: 48, property: "speed" };
    const parity: Array<Record<string, unknown>> = [];
    for (const preset of EFFECT_PRESET_CATALOGUE) for (const fps of [24, 25, 30]) for (const [width, height] of [[128, 72], [72, 128]]) {
      const layer = defaultEffectClip({ id: `cl_${preset.id}`, lineageId: `ef_${preset.id}`, seed: 42, startFrame: 0, durationFrames: 240, preset: preset.id });
      layer.appearance = { ...layer.appearance, amount: 1, opacity: 0.9, size: 0.8 };
      const path = join(dir, `${preset.id}-${fps}-${width}x${height}.mkv`);
      await host.renderAlpha({ effects: [layer], width: width!, height: height!, frameRate: fps, startFrame: 73, frameCount: 1, output: path, signal: signal() });
      const actual = await processBytes(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
      const expected = renderEffectLayersRgba([layer], 73, fps, width!, height!);
      assert.deepEqual(actual, Buffer.from(expected), `${preset.id}/${fps}/${width}x${height}`);
      const mp4 = join(dir, `${preset.id}-${fps}-${width}x${height}.mp4`);
      await processBytes(["-y", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`, "-i", path,
        "-filter_complex", "[0:v][1:v]overlay=0:0:format=gbrp:alpha=straight[v]", "-map", "[v]", "-frames:v", "1", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", mp4]);
      const encoded = await processBytes(["-i", mp4, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
      const ground = new Uint8ClampedArray(expected.length); for (let i = 3; i < ground.length; i += 4) ground[i] = 255;
      compositeRgba(ground, expected);
      let squareError = 0, maxChannelError = 0;
      for (let i = 0; i < ground.length; i++) if (i % 4 !== 3) { const delta = Math.abs(encoded[i]! - ground[i]!); squareError += delta * delta; maxChannelError = Math.max(delta, maxChannelError); }
      const rmse = Math.sqrt(squareError / (width! * height! * 3));
      assert.ok(rmse <= 8, `${preset.id} MP4 RMSE ${rmse}`);
      parity.push({ preset: preset.id, fps, width, height, alphaByteError: 0, mp4RgbRmse: rmse, mp4MaxChannelError: maxChannelError });
    }
    report.worker = { alphaByteError: 0, cancellation: "removed-intermediate", reaction: "refused-unready", durationMs: performance.now() - start, cases: parity };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("real source sampling keeps the previous 30fps frame at nonaligned 24fps in-points and holds the physical tail", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("source-clock");
  try {
    const source = join(dir, "source.mkv");
    const input = Buffer.concat(Array.from({ length: 30 }, (_, frame) => Buffer.from(Array.from({ length: 4 }, () => [frame * 8, frame * 8, frame * 8, 255]).flat())));
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", "30", "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", source], input);
    const sharedBrowserSource = process.env["ARKE_EFFECT_SOURCE_CLOCK_MP4"];
    if (sharedBrowserSource) await copyFile(sharedBrowserSource, join(dir, "source.mp4"));
    else await processBytes(["-y", "-i", source, "-vf", "scale=32:32", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", join(dir, "source.mp4")]);
    const samples = [];
    for (const sourceName of ["source.mkv", "source.mp4"]) for (const sourceInSec of [0.05, 0.9]) {
      const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 8 / 24,
        effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 56, effectLayers: [], issues: [], pictureLayers: [{
          clipId: "source", trackId: "source", order: 0, kind: "media", label: "source", path: sourceName, still: false,
          startFrame: 48, endFrame: 56, sourceInSec, sourceOutSec: 1, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha" }] } };
      const output = join(dir, `result-${sourceName}-${sourceInSec}.mkv`), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", []);
      args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1");
      await processBytes(args);
      const frames = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
      assert.equal(frames.length, 8 * 16);
      const actual = Array.from({ length: 8 }, (_, i) => Math.round(frames[i * 16]! / 8));
      const expected = Array.from({ length: 8 }, (_, i) => Math.floor(Math.min(1 - 0.0001, sourceInSec + i / 24 + 0.0001) * 30));
      assert.deepEqual(actual, expected);
      samples.push({ sourceName, sourceInSec, actual, expected });
    }
    report.sourceSampling = { sourceFps: 30, outputFps: 24, samples };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("a film at another speed or backwards exports, at every frame, the source frame the Viewer seeks to", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("clip-speed");
  try {
    // Sixty frames, each grey level its own number, at the film's rate and at another: at 24 fps
    // every other source frame starts exactly on a sample at 2x, the tie the export must not flip.
    for (const rate of [24, 30]) {
      const input = Buffer.concat(Array.from({ length: 60 }, (_, frame) => Buffer.from(Array.from({ length: 4 }, () => [frame * 4, frame * 4, frame * 4, 255]).flat())));
      await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", String(rate), "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", join(dir, `source-${rate}.mkv`)], input);
      await processBytes(["-y", "-i", join(dir, `source-${rate}.mkv`), "-vf", "scale=32:32", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", join(dir, `source-${rate}.mp4`)]);
    }
    const samples = [];
    const cases: Array<{ speed?: number; reverse?: true }> = [{ speed: 2 }, { speed: .5 }, { speed: 1.25 }, { speed: 1.05 }, { reverse: true }, { speed: 2, reverse: true }, { speed: .75, reverse: true }, { speed: 4 }];
    for (const rate of [24, 30]) for (const extension of ["mkv", "mp4"]) for (const retime of cases) for (const [startFrame, endFrame] of [[48, 66], [53, 61]] as const) {
      const sourceOutSec = 60 / rate;
      const layer: RenderPictureLayer = { clipId: "source", trackId: "source", order: 0, kind: "media", label: "source", path: `source-${rate}.${extension}`, still: false,
        startFrame: 48, endFrame: 66, sourceInSec: .25, sourceOutSec, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha", ...retime };
      const count = endFrame - startFrame;
      const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
        effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: 24, startFrame, endFrame, effectLayers: [], issues: [], pictureLayers: [layer] } };
      const name = `${rate}-${extension}-${retime.speed ?? 1}${retime.reverse ? "r" : ""}-${startFrame}`;
      const output = join(dir, `result-${name}.mkv`), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", []);
      args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1");
      await processBytes(args);
      const frames = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
      assert.equal(frames.length, count * 16, name);
      const actual = Array.from({ length: count }, (_, i) => Math.round(frames[i * 16]! / 4));
      // Where each source frame begins, as its file says: Matroska stamps to the millisecond, so
      // frame 10 of 24 begins at 0.417 there and at 10/24 in the MP4.
      const begins = (frame: number) => extension === "mkv" ? Math.round(frame * 1000 / rate) / 1000 : frame / rate;
      // What the Viewer's pool seeks to: the frame's source second, a tolerance inside it, held at
      // the source's end. It shows the last frame that has begun by then.
      const expected = Array.from({ length: count }, (_, i) => {
        const sought = Math.max(0, Math.min(sourceOutSec - .0001, pictureSourceSec(layer, startFrame + i, 24) + PICTURE_SAMPLE_TOLERANCE_SEC));
        return Array.from({ length: 60 }, (_, frame) => frame).findLast(frame => begins(frame) <= sought + 1e-9)!;
      });
      assert.deepEqual(actual, expected, name);
      samples.push({ name, actual });
    }
    // Backwards at its own speed, a film ends on the frame it began on and shows what it showed forwards, last first.
    const ends = samples.find(row => row.name === "24-mp4-1r-48")!.actual;
    assert.deepEqual(ends, Array.from({ length: 18 }, (_, i) => 6 + 17 - i));
    report.clipSpeed = { outputFps: 24, cases: samples.length, samples: samples.filter(row => row.name.startsWith("30-mp4")) };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("picture and alpha delivery keep exact half-open frame boundaries after gaps and inside export windows", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("frame-boundaries"), samples = [];
  try {
    const still = Buffer.from(Array.from({ length: 4 }, () => [96, 96, 96, 255]).flat());
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-i", "pipe:0", "-frames:v", "1", join(dir, "still.png")], still);
    for (const fps of [24, 25, 30] as const) {
      // 3842/24 rounds above FFmpeg's 3842*(1/24); 29/25 and 123/30 expose
      // truncation when a decimal-second placement is divided back by the time base.
      const offset = fps === 24 ? 3842 : fps === 25 ? 29 : 123;
      // NUT preserves these exact frame timestamps; Matroska's millisecond time base would
      // turn this placement test into a source-frame resampling test as well.
      const values = [32, 96, 160, 224], source = `source-${fps}.nut`;
      const pixels = Buffer.concat(values.map(value => Buffer.from(Array.from({ length: 4 }, () => [value, value, value, 255]).flat())));
      await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", String(fps), "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", join(dir, source)], pixels);
      for (const startFrame of [0, 2 * fps]) for (const kind of ["still", "video", "scoped", "composition"] as const) {
        const from = startFrame + offset, to = from + values.length, frameCount = offset + values.length + 2;
        const plan: ExportPlan = { preset: "review-cut", frameRate: fps, items: [], overlays: [], audio: [], totalSec: frameCount / fps,
          effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: fps, startFrame,
            endFrame: startFrame + frameCount, effectLayers: [], issues: [], pictureLayers: kind === "composition" ? [] : [{
              clipId: "picture", trackId: "picture", order: 0, kind: "media", label: kind, path: kind === "video" ? source : "still.png", still: kind !== "video",
              startFrame: from, endFrame: to, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha" }] } };
        const alpha = kind === "scoped" || kind === "composition" ? [{ ...(kind === "scoped" ? { pictureClipId: "picture" } : {}), path: join(dir, source), startFrame: from, endFrame: to }] : [];
        const args = buildFfmpegArgs(plan, dir, "pipe:1", "unused.ttf", alpha);
        args[args.indexOf("-pix_fmt") + 1] = "rgba"; args.splice(args.length - 1, 0, "-c:v", "rawvideo", "-f", "rawvideo");
        const delivered = await processBytes(args);
        assert.equal(delivered.length, frameCount * 16);
        const actual = Array.from({ length: values.length + 4 }, (_, index) => delivered[(offset - 2 + index) * 16]!);
        const expected = [0, 0, ...(kind === "still" ? values.map(() => 96) : values), 0, 0];
        assert.ok(actual.every((value, index) => Math.abs(value - expected[index]!) <= 2),
          `${fps}fps ${kind} window ${startFrame}, placement ${from}: actual ${actual}; expected ${expected}`);
        samples.push({ fps, kind, startFrame, from, to, actual, expected });
      }
    }
    report.frameBoundaries = { samples, exactHalfOpenWindows: true };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("scoped animated alpha stays inside contain bounds and upper picture windows are half-open", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("contain");
  try {
    const lower = new Uint8ClampedArray(Array.from({ length: 4 }, () => [20, 80, 180, 255]).flat());
    const upper = new Uint8ClampedArray(Array.from({ length: 4 }, () => [20, 210, 80, 64]).flat());
    const effects = [0, 64, 128, 255].map(alpha => new Uint8ClampedArray(Array.from({ length: 4 }, () => [230, 30, 50, alpha]).flat()));
    await alphaFile(join(dir, "lower.mkv"), lower); await alphaFile(join(dir, "upper.mkv"), upper);
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", "24", "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", join(dir, "scoped.mkv")], Buffer.concat(effects.map(pixels => Buffer.from(pixels))));
    const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 4 / 24,
      effectRender: { rendererVersion: "software-rgba-v2", width: 4, height: 2, frameRate: 24, startFrame: 48, endFrame: 52, effectLayers: [], issues: [], pictureLayers:
        ["lower", "upper"].map((name, order) => ({ clipId: name, trackId: name, order, kind: "media", label: name, path: `${name}.mkv`, still: false,
          startFrame: order ? 49 : 48, endFrame: order ? 51 : 52, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha" })) } };
    const output = join(dir, "result.mkv"), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", [{ pictureClipId: "lower", path: join(dir, "scoped.mkv"), startFrame: 48, endFrame: 52 }]);
    args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1");
    await processBytes(args);
    const frames = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    assert.equal(frames.length, 4 * 4 * 2 * 4);
    let maximum = 0;
    for (let frame = 0; frame < 4; frame++) {
      const picture = compositeRgba(lower.slice(), effects[frame]!, "atop");
      if (frame >= 1 && frame < 3) compositeRgba(picture, upper);
      for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
        const expected = x === 0 || x === 3 ? [0, 0, 0, 255] : picture.subarray((y * 2 + x - 1) * 4, (y * 2 + x - 1) * 4 + 4);
        for (let channel = 0; channel < 4; channel++) maximum = Math.max(maximum, Math.abs(frames[frame * 32 + (y * 4 + x) * 4 + channel]! - expected[channel]!));
      }
    }
    assert.ok(maximum <= 2, `Animated scoped frame mismatch ${maximum}`);
    report.contain = { maxChannelError: maximum, width: 4, height: 2, sourceWidth: 2, sourceHeight: 2, frames: 4, upperHalfOpen: [49, 51] };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("open-edge fades with opacity over a lower track match the compositor, from before a fade and from inside one", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("edge-fade");
  try {
    const lower = new Uint8ClampedArray([30, 50, 80, 255, 100, 20, 90, 128, 0, 0, 0, 255, 80, 120, 50, 0]);
    const a = new Uint8ClampedArray([250, 80, 20, 255, 250, 80, 20, 128, 250, 80, 20, 0, 250, 80, 20, 64]);
    const b = new Uint8ClampedArray([20, 90, 240, 64, 20, 90, 240, 255, 20, 90, 240, 128, 20, 90, 240, 0]);
    const stills = { lower, a, b }, rect = { x: 0, y: 0, width: 2, height: 2 };
    for (const [name, pixels] of Object.entries(stills)) await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-i", "pipe:0", "-frames:v", "1", join(dir, `${name}.png`)], Buffer.from(pixels));
    const still = (clipId: keyof typeof stills, trackId: string, order: number, startFrame: number, endFrame: number): RenderPictureLayer => ({ clipId, trackId, order, kind: "media", label: clipId,
      path: `${clipId}.png`, still: true, startFrame, endFrame, sourceInSec: 0, sourceSize: { width: 2, height: 2 }, fit: "contain", matte: "source-alpha" });
    // The upper track comes up from the lower one, goes back to it, leaves a gap, and returns.
    const layers: RenderPictureLayer[] = [still("lower", "lower", 0, 40, 70),
      { ...still("a", "upper", 1, 48, 54), opacity: .5, fadeIn: { startFrame: 48, durationFrames: 4 }, fadeOut: { startFrame: 51, durationFrames: 3 } },
      { ...still("b", "upper", 2, 56, 64), fadeIn: { startFrame: 56, durationFrames: 3 }, fadeOut: { startFrame: 58, durationFrames: 6 } }];
    let maxError = 0;
    // The second window opens inside the first fade, where the weight is counted from the film's frame.
    for (const [startFrame, endFrame] of [[46, 62], [49, 60]] as const) {
      const count = endFrame - startFrame;
      const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
        effectRender: { rendererVersion: "software-rgba-v2", width: 2, height: 2, frameRate: 24, startFrame, endFrame, effectLayers: [], issues: [], pictureLayers: layers } };
      const output = join(dir, `fade-${startFrame}.mkv`), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", []);
      args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
      const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * 16);
      for (let frame = startFrame; frame < endFrame; frame++) {
        const expected = new Uint8ClampedArray(Array.from({ length: 4 }, () => [0, 0, 0, 255]).flat());
        for (const trackId of ["lower", "upper"]) {
          const track = new Float32Array(16);
          for (const layer of layers) if (layer.trackId === trackId && frame >= layer.startFrame && frame < layer.endFrame)
            addWeightedPicture(track, stills[layer.clipId as keyof typeof stills], pictureTransitionWeight(layer, frame), rect, 2, undefined, "normal", layer.opacity ?? 1);
          compositeWeightedTrack(expected, track);
        }
        for (let channel = 0; channel < 16; channel++) maxError = Math.max(maxError, Math.abs(pixels[(frame - startFrame) * 16 + channel]! - expected[channel]!));
      }
    }
    assert.ok(maxError <= 4, `edge fade channel error ${maxError}`); report["edge-fade"] = { maxChannelError: maxError, windows: [[46, 62], [49, 60]] };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("a moving still shows the window the preview reads at every frame, from inside the clip and under a fade", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("motion"), size = 16;
  try {
    // A white band four pixels wide, centred on the picture: where it sits says where the window is, and how wide it reads says how close.
    const band = new Uint8ClampedArray(Array.from({ length: size * size }, (_, at) => at % size >= 6 && at % size < 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]).flat());
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${size}x${size}`, "-i", "pipe:0", "-frames:v", "1", join(dir, "band.png")], Buffer.from(band));
    const worst: Record<string, number> = {};
    const runs = [{ kind: "drift-left", startFrame: 48, endFrame: 60 }, { kind: "drift-right", startFrame: 51, endFrame: 60 }, { kind: "push-in", startFrame: 48, endFrame: 60 },
      { kind: "pull-out", startFrame: 51, endFrame: 60, fadeOut: { startFrame: 56, durationFrames: 4 } }] as const;
    for (const run of runs) {
      const layer: RenderPictureLayer = { clipId: "band", trackId: "picture", order: 0, kind: "media", label: "Band", path: "band.png", still: true, startFrame: 48, endFrame: 60, sourceInSec: 0,
        sourceSize: { width: size, height: size }, fit: "contain", matte: "source-alpha", motion: { kind: run.kind, amount: .5 }, ...("fadeOut" in run ? { fadeOut: run.fadeOut } : {}) };
      const count = run.endFrame - run.startFrame;
      const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
        effectRender: { rendererVersion: "software-rgba-v2", width: size, height: size, frameRate: 24, startFrame: run.startFrame, endFrame: run.endFrame, effectLayers: [], issues: [], pictureLayers: [layer] } };
      const output = join(dir, `${run.kind}.mkv`), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", []);
      args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
      const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * size * size * 4);
      for (let frame = run.startFrame; frame < run.endFrame; frame++) {
        const window = pictureMotionWindow(pictureMotionAt(layer.motion!, pictureMotionProgress(layer, frame)), size, size), scale = size / window.width;
        let light = 0, moment = 0, peak = 0;
        for (let at = 0; at < size * size; at++) {
          const value = pixels[((frame - run.startFrame) * size * size + at) * 4]!;
          light += value; moment += value * (at % size + .5); peak = Math.max(peak, value);
        }
        // Under the fade the band dims; its place and its width are read against its own brightest pixel.
        assert.ok(peak >= 255 * pictureTransitionWeight(layer, frame) - 6 && peak > 32, `${run.kind} frame ${frame} peak ${peak}`);
        const centre = moment / light, width = light / peak / size;
        worst[run.kind] = Math.max(worst[run.kind] ?? 0, Math.abs(centre - (8 - window.x) * scale), Math.abs(width - 4 * scale));
      }
      // The export moves its window by half a source pixel, three quarters of a delivered one this close; past one is a different move.
      assert.ok(worst[run.kind]! <= 1, `${run.kind} is ${worst[run.kind]} pixels from the preview's window`);
    }
    report.motion = { worstPixels: worst, size, frames: 12, amount: .5 };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("a text clip's kept picture exports as the Viewer draws it: half-way through a fade, at half opacity, on Screen, with a composition effect in front", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("text"), width = 64, height = 36, count = 5;
  try {
    // The painted picture itself, kept where the plan names it (SPEC-065 R-20): its anti-aliased
    // edges are what a straight-alpha mistake or a resampled picture would change.
    const look: TextLook = { typeface: "geist", weight: "regular", italic: false, size: .4, tracking: 0, leading: 1.2, capitals: false,
      align: "center", x: .5, y: .5, room: .9, fill: { kind: "solid", color: "#e0a060" } };
    const ref = textPicturePath({ text: "ADE", look }, { width, height });
    if (!ref.ok) assert.fail(ref.reason);
    const paint = paintTextPicture({ text: "ADE", look, width, height });
    if (!paint.ok) assert.fail(paint.reason);
    assert.equal(paint.name, ref.name);
    await mkdir(join(dir, dirname(ref.path)), { recursive: true });
    await writeFile(join(dir, ref.path), textPicturePng(paint));
    const words = new Uint8ClampedArray(paint.rgba);
    assert.ok(words.some((value, at) => at % 4 === 3 && value > 0 && value < 255), "the picture has soft edges to compare");
    // An opaque ramp under it, so Screen lifts each pixel by a different amount.
    const lower = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [(at % width) * 4, Math.floor(at / width) * 7, 120, 255]).flat());
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", join(dir, "lower.png")], Buffer.from(lower));
    const composition = new Uint8ClampedArray(Array.from({ length: width * height }, () => [220, 220, 250, 32]).flat());
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", "24", "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", "-f", "matroska", join(dir, "composition.mkv")],
      Buffer.concat(Array.from({ length: count }, () => Buffer.from(composition))));
    const frame = { width, height }, rect = { x: 0, y: 0, width, height };
    // The layer the plan gives a text clip: its kept picture as a contained still at the frame's
    // size, with its own alpha, carrying the clip's fade, blend and opacity as any still's would.
    const layers: RenderPictureLayer[] = [
      { clipId: "cl_still", trackId: "tr_picture", order: 0, kind: "media", label: "Still", path: "lower.png", still: true, startFrame: 40, endFrame: 70, sourceInSec: 0,
        sourceSize: frame, fit: "contain", matte: "source-alpha" },
      { clipId: "cl_name", trackId: "tr_names", order: 1, kind: "media", label: "ADE", path: ref.path, still: true, startFrame: 48, endFrame: 72, sourceInSec: 0,
        sourceSize: frame, fit: "contain", matte: "source-alpha", blendMode: "screen", opacity: .5, fadeIn: { startFrame: 48, durationFrames: 4 } }];
    assert.equal(pictureTransitionWeight(layers[1]!, 50), .5, "the window holds the fade's half-way frame");
    const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
      effectRender: { rendererVersion: "software-rgba-v2", width, height, frameRate: 24, startFrame: 48, endFrame: 48 + count, effectLayers: [], issues: [], pictureLayers: layers } };
    const output = join(dir, "text.mkv"), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", [{ path: join(dir, "composition.mkv"), startFrame: 48, endFrame: 48 + count }]);
    args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
    const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * width * height * 4);
    const stills: Record<string, Uint8ClampedArray> = { cl_still: lower, cl_name: words };
    let maxError = 0;
    for (let at = 48; at < 48 + count; at++) {
      // As the Viewer's frame does it: each track's pictures weighted and blended over what is
      // already drawn, the tracks in order, then the composition's effect over everything.
      const expected = new Uint8ClampedArray(Array.from({ length: width * height }, () => [0, 0, 0, 255]).flat());
      for (const trackId of ["tr_picture", "tr_names"]) {
        const track = new Float32Array(width * height * 4);
        for (const layer of layers) if (layer.trackId === trackId && at >= layer.startFrame && at < layer.endFrame)
          addWeightedPicture(track, stills[layer.clipId]!, pictureTransitionWeight(layer, at), rect, width, expected, layer.blendMode ?? "normal", layer.opacity ?? 1);
        compositeWeightedTrack(expected, track);
      }
      compositeRgba(expected, composition);
      const offset = (at - 48) * width * height * 4;
      for (let channel = 0; channel < expected.length; channel++) maxError = Math.max(maxError, Math.abs(pixels[offset + channel]! - expected[channel]!));
    }
    assert.ok(maxError <= 4, `text channel error ${maxError}`); report.text = { maxChannelError: maxError, frames: count, width, height, halfWayFrame: 50 };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("text crossfades into text and from a still at the plan's weights, as the Viewer draws them, with no dip at the midpoint", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("text-crossfade"), width = 64, height = 36, startFrame = 52, endFrame = 61, count = endFrame - startFrame;
  try {
    // The record as an author makes it: placed and crossfaded by the reducer with the world's
    // sources, so each pair's keys, windows and weights are the planner's own (SPEC-065 R-17).
    const AT = "2026-11-12T10:00:00Z", PLATE = "ar_01J8G0000000000000000000A1";
    const production: ProductionBundle = {
      rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
      meta: { id: "the-names", format: "video", medium: "video", kind: "microdrama", title: "The Names", status: "in-progress", frameRate: 24, failureModes: [], created: AT, updated: AT },
      story: null, season: null, routing: null, treatment: null, chapters: [], scenes: [], sceneFiles: {}, episodes: [], episodeFiles: {},
      takes: [], reviews: [], selections: {}, spine: null, cut: { audio: [], overlays: [] }, editorRequests: [], takeMediaInfo: {},
    };
    const sources = { production, artifacts: [ArtifactSidecarSchema.parse({ id: PLATE, kind: "image", file: "plate.png", hash: `sha256:${"a".repeat(64)}`,
      origin: { by: "system", producedBy: "accepted-still" }, links: [], created: AT })] };
    // Each track's words on a row of their own: where three anti-aliased edges stack, 8-bit
    // rounding through three composites is what a comparison would measure, not the blends.
    const look = (y: number): TextLook => ({ typeface: "geist", weight: "regular", italic: false, size: .25, tracking: 0, leading: 1.2, capitals: false,
      align: "center", x: .5, y, room: .9, fill: { kind: "solid", color: "#e0a060" } });
    const text = (id: `cl_${string}`, at: number, frames: number, words: string, y: number): TimelineClip =>
      ({ id, startFrame: at, durationFrames: frames, sourceInFrames: 0, source: { kind: "text", label: textLabel(words), text: words, look: look(y) } });
    const pair = (trackId: `tr_${string}`, leftClipId: `cl_${string}`, rightClipId: `cl_${string}`) => ({ kind: "transition-set" as const, trackId, leftClipId, rightClipId, durationFrames: 8 });
    const record = applyTimelineCommands(seedEmptyPictureTimeline(production), [
      { kind: "place", trackId: "tr_picture", clip: { id: "cl_plate", startFrame: 0, durationFrames: 56, sourceInFrames: 0, source: { kind: "artifact", artifactId: PLATE, label: "Plate" } } },
      { kind: "place", trackId: "tr_picture", clip: text("cl_kemi", 56, 16, "KEMI", .5) },
      { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
      { kind: "place", trackId: "tr_names", clip: text("cl_ade", 40, 16, "ADE", .2) },
      { kind: "place", trackId: "tr_names", clip: text("cl_ife", 56, 16, "IFE", .2) },
      { kind: "add-track", trackId: "tr_split", trackKind: "picture", name: "Split" },
      { kind: "place", trackId: "tr_split", clip: text("cl_title", 40, 32, "ADE", .8) },
      { kind: "split", clipId: "cl_title", atFrame: 56, newClipId: "cl_title2" },
      pair("tr_picture", "cl_plate", "cl_kemi"), pair("tr_names", "cl_ade", "cl_ife"), pair("tr_split", "cl_title", "cl_title2"),
    ], { sources, effectAuthority: "human" });
    const built = buildRenderPlan({ production, artifacts: [{ id: PLATE, file: "plate.png", kind: "image" }], timeline: { status: "ready", timeline: record },
      scope: { kind: "production" }, preset: "review-cut" });
    if (!built.ok) assert.fail(built.reason);

    // Small pictures in the plan's places: each name painted at the export's frame, the plate an opaque ramp.
    const frame = { width, height }, rect = { x: 0, y: 0, width, height }, stills: Record<string, Uint8ClampedArray> = {}, paths: Record<string, string> = {};
    for (const clip of record.tracks.flatMap(track => track.clips)) {
      if (clip.source.kind !== "text") continue;
      const ref = textPicturePath(clip.source, frame);
      if (!ref.ok) assert.fail(ref.reason);
      const paint = paintTextPicture({ text: clip.source.text, look: clip.source.look, width, height });
      if (!paint.ok) assert.fail(paint.reason);
      await mkdir(join(dir, dirname(ref.path)), { recursive: true });
      await writeFile(join(dir, ref.path), textPicturePng(paint));
      stills[clip.id] = new Uint8ClampedArray(paint.rgba); paths[clip.id] = ref.path;
    }
    stills.cl_plate = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [(at % width) * 4, Math.floor(at / width) * 7, 120, 255]).flat()); paths.cl_plate = "plate.png";
    await processBytes(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", join(dir, "plate.png")], Buffer.from(stills.cl_plate));
    const layers = built.plan.effectRender!.pictureLayers.map(layer => ({ ...layer, path: paths[layer.clipId]!, sourceSize: frame }));
    for (const [left, right] of [["cl_plate", "cl_kemi"], ["cl_ade", "cl_ife"], ["cl_title", "cl_title2"]] as const) {
      const of = (clipId: string) => layers.find(layer => layer.clipId === clipId)!;
      assert.deepEqual([pictureTransitionWeight(of(left), 56), pictureTransitionWeight(of(right), 56)], [.5, .5], `${left} into ${right} is half-way at the cut`);
    }
    const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
      effectRender: { rendererVersion: "software-rgba-v2", width, height, frameRate: 24, startFrame, endFrame, effectLayers: [], issues: [], pictureLayers: layers } };
    const output = join(dir, "text-crossfade.mkv"), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", []);
    args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
    const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * width * height * 4);
    // As the Viewer's frame does it: each track's pictures weighted and summed, the tracks in order.
    const tracks = [...new Set(layers.map(layer => layer.trackId))];
    const viewer = (at: number, drawn: readonly RenderPictureLayer[] = layers) => {
      const expected = new Uint8ClampedArray(Array.from({ length: width * height }, () => [0, 0, 0, 255]).flat());
      for (const trackId of tracks) {
        const track = new Float32Array(width * height * 4);
        for (const layer of drawn) if (layer.trackId === trackId && at >= layer.startFrame && at < layer.endFrame)
          addWeightedPicture(track, stills[layer.clipId]!, pictureTransitionWeight(layer, at), rect, width, expected, layer.blendMode ?? "normal", layer.opacity ?? 1);
        compositeWeightedTrack(expected, track);
      }
      return expected;
    };
    const differs = (at: number, expected: Uint8ClampedArray) => {
      let most = 0;
      const offset = (at - startFrame) * width * height * 4;
      for (let channel = 0; channel < expected.length; channel++) most = Math.max(most, Math.abs(pixels[offset + channel]! - expected[channel]!));
      return most;
    };
    let maxError = 0;
    for (let at = startFrame; at < endFrame; at++) maxError = Math.max(maxError, differs(at, viewer(at)));
    // The split title's halves are one picture, so their blend is that picture whole: no dip half-way (SPEC-054 R-4).
    const whole = layers.filter(layer => layer.clipId !== "cl_title2").map(layer => layer.clipId === "cl_title"
      ? { ...layer, endFrame: 72, fadeOut: undefined } : layer);
    const midpoint = differs(56, viewer(56, whole));
    assert.ok(maxError <= 4, `text crossfade channel error ${maxError}`);
    assert.ok(midpoint <= 4, `the split title dips ${midpoint} at its cut`);
    report.textCrossfade = { maxChannelError: maxError, midpointAgainstWhole: midpoint, frames: count, width, height, midFrame: 56 };
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});

test("a push on a title reads its doubled picture and stays sharp beside one enlarged from the frame", { skip: !hasFfmpeg }, async () => {
  const dir = await fixtureDir("text-push"), width = 96, height = 54, startFrame = 48, endFrame = 60, count = endFrame - startFrame;
  try {
    const look: TextLook = { typeface: "geist", weight: "regular", italic: false, size: .25, tracking: 0, leading: 1.2, capitals: false,
      align: "center", x: .5, y: .5, room: .6, fill: { kind: "solid", color: "#ffffff" } };
    const motion = { kind: "push-in", amount: .5 } as const;
    const keep = async (size: { width: number; height: number }) => {
      const ref = textPicturePath({ text: "ADE", look }, size);
      if (!ref.ok) assert.fail(ref.reason);
      const paint = paintTextPicture({ text: "ADE", look, ...size });
      if (!paint.ok) assert.fail(paint.reason);
      await mkdir(join(dir, dirname(ref.path)), { recursive: true });
      await writeFile(join(dir, ref.path), textPicturePng(paint));
      return ref.path;
    };
    // Two exports that differ only in the picture they read: the one the plan names for a moving
    // title (twice the frame), and the frame's own, which the export must then enlarge.
    const exported = async (name: string, path: string, size: { width: number; height: number }) => {
      const layer: RenderPictureLayer = { clipId: "cl_name", trackId: "tr_names", order: 0, kind: "media", label: "ADE", path, still: true, startFrame, endFrame, sourceInSec: 0,
        sourceSize: size, fit: "contain", matte: "source-alpha", motion };
      const plan: ExportPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: count / 24,
        effectRender: { rendererVersion: "software-rgba-v2", width, height, frameRate: 24, startFrame, endFrame, effectLayers: [], issues: [], pictureLayers: [layer] } };
      const output = join(dir, `${name}.mkv`), args = buildFfmpegArgs(plan, dir, output, "unused.ttf", []);
      args[args.indexOf("-pix_fmt") + 1] = "bgra"; args.splice(args.length - 1, 0, "-c:v", "ffv1"); await processBytes(args);
      const pixels = await processBytes(["-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]); assert.equal(pixels.length, count * width * height * 4);
      return { layer, pixels };
    };
    const doubled = await exported("doubled", await keep({ width: 2 * width, height: 2 * height }), { width: 2 * width, height: 2 * height });
    const enlarged = await exported("enlarged", await keep({ width, height }), { width, height });
    // The truth: a centred push is a scale about the centre, and the layout is linear in the em, so
    // each frame is the words painted at the frame with the size and room times the zoom. White
    // over black, so the export's red is the truth's alpha. Both exports step their window on the
    // same whole pixels of a picture twice the frame, up to half a delivered pixel off an exact
    // scale; against that shift a softer picture scores better pixel by pixel, because blur hedges
    // it. Edge energy, the summed squared step between neighbours, barely moves with the shift and
    // is what an enlargement loses, so sharpness is read as each export's share of the truth's.
    const energy = (read: (pixel: number) => number) => {
      let sum = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const here = read(y * width + x);
        if (x + 1 < width) sum += (read(y * width + x + 1) - here) ** 2;
        if (y + 1 < height) sum += (read((y + 1) * width + x) - here) ** 2;
      }
      return sum;
    };
    const meanError: Record<"doubled" | "enlarged", number[]> = { doubled: [], enlarged: [] }, edges: Record<"doubled" | "enlarged", number[]> = { doubled: [], enlarged: [] };
    for (let at = startFrame; at < endFrame; at++) {
      const zoom = pictureMotionAt(motion, pictureMotionProgress(doubled.layer, at)).zoom;
      const truth = paintTextPicture({ text: "ADE", look: { ...look, size: look.size * zoom, room: look.room * zoom }, width, height });
      if (!truth.ok) assert.fail(truth.reason);
      const truthEnergy = energy(pixel => truth.rgba[pixel * 4 + 3]!), offset = (at - startFrame) * width * height * 4;
      for (const [name, { pixels }] of [["doubled", doubled], ["enlarged", enlarged]] as const) {
        let sum = 0;
        for (let pixel = 0; pixel < width * height; pixel++) sum += Math.abs(pixels[offset + pixel * 4]! - truth.rgba[pixel * 4 + 3]!);
        meanError[name].push(sum / (width * height));
        edges[name].push(energy(pixel => pixels[offset + pixel * 4]!) / truthEnergy);
      }
    }
    report.textMotion = { edgeEnergyOfTruth: edges, meanChannelError: meanError, width, height, frames: count, amount: motion.amount };
    // Measured with the app's FFmpeg on Windows: the doubled picture keeps 0.86 to 1.28 of the
    // truth's edges, the enlarged one 0.45 to 0.67, at least 1.8 times less on every frame.
    for (let index = Math.ceil(count / 4); index < count; index++) {
      assert.ok(edges.doubled[index]! >= 1.3 * edges.enlarged[index]!, `frame ${startFrame + index}: doubled keeps ${edges.doubled[index]} of the edges, enlarged ${edges.enlarged[index]}`);
    }
    const last = count - 1, off = (name: "doubled" | "enlarged") => Math.abs(1 - edges[name][last]!);
    assert.ok(off("doubled") <= off("enlarged") * 2 / 3, `closest, the doubled picture is ${off("doubled")} off the truth's edges and the enlarged ${off("enlarged")}`);
    // At zoom 1 the doubled picture read down to the frame is the frame's own paint.
    assert.ok(meanError.doubled[0]! <= 2 && Math.abs(1 - edges.doubled[0]!) <= .2, `frame ${startFrame}: ${meanError.doubled[0]} from the frame's paint, ${edges.doubled[0]} of its edges`);
  } finally { if (!evidence) await rm(dir, { recursive: true, force: true }); await evidenceReport(); }
});
