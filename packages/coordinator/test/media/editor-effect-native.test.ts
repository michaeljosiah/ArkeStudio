import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildFfmpegArgs, compositeRgba, addWeightedPicture, compositeWeightedTrack, defaultEffectClip, EFFECT_PRESET_CATALOGUE, prepareEffectReactions, renderEffectLayersRgba, type ExportPlan } from "@arke-studio/contracts";
import { analysisFixture } from "./effect-analysis-fixture.js";
import { createNodeEffectRasterHost } from "../../src/media/node-effect-renderer.js";
import { createNodeMediaProcessRunner, createNodeFfmpegRunner } from "../../src/media/node-media-host.js";

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
      effectRender: { rendererVersion: "software-rgba-v1", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 53, effectLayers: [], issues: [], pictureLayers: [
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
      effectRender: { rendererVersion: "software-rgba-v1", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 52, effectLayers: [], issues: [], pictureLayers:
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
        effectRender: { rendererVersion: "software-rgba-v1", width: 2, height: 2, frameRate: 24, startFrame: 48, endFrame: 56, effectLayers: [], issues: [], pictureLayers: [{
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
          effectRender: { rendererVersion: "software-rgba-v1", width: 2, height: 2, frameRate: fps, startFrame,
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
      effectRender: { rendererVersion: "software-rgba-v1", width: 4, height: 2, frameRate: 24, startFrame: 48, endFrame: 52, effectLayers: [], issues: [], pictureLayers:
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
