import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { defaultEffectClip, type EffectClip } from "../packages/contracts/src/editor-effects.js";
import { EFFECT_PRESET_CATALOGUE, EFFECT_RENDER_PROFILE } from "../packages/contracts/src/editor-effect-catalogue.js";
import { EFFECT_ANALYSIS_PROFILE, effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial, type EffectFeatureManifest,
  type EffectFeatureData, type EffectAudioSourceDescriptor } from "../packages/contracts/src/editor-effect-analysis.js";
import { createEffectPcmAnalyzer } from "../packages/contracts/src/editor-effect-audio-features.js";
import { prepareEffectReaction, prepareEffectReactions } from "../packages/contracts/src/editor-effect-reaction.js";
import { evaluateEffectFrame } from "../packages/contracts/src/editor-effect-evaluator.js";
import { compositeEffectFrames, rasterizeEffectFrame } from "../packages/contracts/src/editor-effect-raster.js";

// SPEC-053 R-14/R-20: pure post-decode PCM and worst supported response preparation/rendering.
// Native canonical decode, browser transfer and cancellation have separate acceptance fixtures.
function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} needs a value`);
  return process.argv[index + 1];
}
const outputPath = resolve(argument("--output", ".dev/effects-053/t3-benchmark.json")!);
const expectedDigest = argument("--expect-fixtures-sha256");
if (expectedDigest && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("--expect-fixtures-sha256 needs a lowercase SHA-256 digest");
const loadContext = argument("--load-context", "Uncontrolled host load; other processes were not isolated or sampled.");
const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
collectGarbage?.();
const baselineMemory = process.memoryUsage(), sampledPeakMemory = { ...baselineMemory };
function sampleMemory() {
  const current = process.memoryUsage();
  for (const key of Object.keys(current) as Array<keyof typeof current>) sampledPeakMemory[key] = Math.max(sampledPeakMemory[key], current[key]);
}
const hash = (value: string | Uint8ClampedArray) => createHash("sha256").update(value).digest("hex");
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]!;
  return { count: values.length, min: sorted[0]!, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1)!, mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}
const fixtures: Array<Record<string, unknown>> = [], cases: Array<Record<string, unknown>> = [];
function analyse(seconds: number, frameRate: 24 | 25 | 30) {
  const endFrame = Math.ceil(seconds * frameRate), expected = endFrame * 48000 / frameRate;
  const analyzer = createEffectPcmAnalyzer({ frameRate, startFrame: 0, endFrame });
  const chunk = new Float32Array(8192 * 2);
  let pushMs = 0;
  for (let offset = 0; offset < expected; offset += chunk.length / 2) {
    const count = Math.min(chunk.length / 2, expected - offset);
    for (let index = 0; index < count; index++) {
      const at = offset + index, amplitude = at % 24000 < 7200 ? 0.25 : at % 480000 < 96000 ? 0 : 0.05;
      const value = (Math.floor(at / 480) % 2 ? 1 : -1) * amplitude;
      chunk[index * 2] = value; chunk[index * 2 + 1] = -value * 0.75;
    }
    const started = performance.now(); analyzer.push(chunk.subarray(0, count * 2)); pushMs += performance.now() - started;
  }
  const started = performance.now(), data = analyzer.finish(), finishMs = performance.now() - started;
  sampleMemory();
  fixtures.push({ id: `pcm/${seconds}s/${frameRate}`, frames: endFrame, sha256: hash(JSON.stringify(data)) });
  cases.push({ kind: "incremental-pcm", requestedSeconds: seconds, frames: endFrame, frameRate, stereoSampleFrames: expected,
    peakChunkBytes: chunk.byteLength, pushMs, finishMs, totalDspMs: pushMs + finishMs, likelyBeats: data.likelyBeats.length });
  return data;
}
function manifest(data: EffectFeatureData, frameRate: 24 | 25 | 30): EffectFeatureManifest {
  const endSec = data.features.endFrame / frameRate;
  const descriptor: EffectAudioSourceDescriptor = { profileId: "audible-pcm-v1", binding: { kind: "composition-mix" }, frameRate,
    startFrame: 0, endFrame: data.features.endFrame, selectedClipIds: ["cl_sound"], placedWindows: [{ startSec: 0, endSec }], audibleWindows: [{ startSec: 0, endSec }],
    contributions: [{ path: "artifacts/synthetic.wav", clipId: "cl_sound", trackId: "tr_sound", startSec: 0, endSec, sourceInSec: 0, gainDb: 0, role: "music" }],
    sources: [{ path: "artifacts/synthetic.wav", sha256: "1".repeat(64) }], mix: { speechFirst: false, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 }, speech: [],
    native: { profileId: "audible-pcm-v1", decoder: { versionConfigHash: "2".repeat(64), executableHash: "3".repeat(64) },
      canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
        limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: 0.891251 } },
      analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } } };
  const result: EffectFeatureManifest = { ...data, schemaVersion: 1, profileId: "audible-pcm-v1", descriptor,
    sourceFingerprint: hash(effectAudioSourceFingerprintMaterial(descriptor)), pcmHash: "4".repeat(64), manifestKey: "0".repeat(64) };
  result.manifestKey = hash(effectManifestFingerprintMaterial(result));
  return result;
}
function effect(preset: EffectClip["preset"]["id"], frameRate: number, index = 0): EffectClip {
  const length = EFFECT_ANALYSIS_PROFILE.maxSeconds * frameRate;
  const value = defaultEffectClip({ id: `cl_benchmark${index}`, lineageId: `ef_benchmark${index}`, seed: (3735928559 + index * 7919) >>> 0, startFrame: 0, durationFrames: length, preset });
  value.audioInput = { kind: "composition-mix" };
  value.appearance = { ...value.appearance, amount: 1, size: 1, opacity: 1 };
  value.reaction = { enabled: true, preset: "custom", version: 1, strength: 1, beat: 1, bass: 1, energy: 1, property: "speed", limit: 1, smoothingFrames: 300 };
  value.cueOverrides = Array.from({ length: 2000 }, (_, at) => ({ id: `ec_${at}`, frame: Math.floor(at * (length - 300) / 2000), durationFrames: 300, strength: (at % 10 + 1) / 10, kind: at % 2 ? "accent" : "suppress" }));
  value.reactionCurve = { points: Array.from({ length: 2000 }, (_, at) => ({ id: `ep_r${at}`, offsetFrames: Math.floor(at * (length - 1) / 1999), value: (at % 10 + 1) / 10, interpolation: "smooth" })) };
  value.intensityCurve = { points: Array.from({ length: 2000 }, (_, at) => ({ id: `ep_i${at}`, offsetFrames: Math.floor(at * (length - 1) / 1999), value: (at % 10 + 1) / 10, interpolation: "linear" })) };
  return value;
}
const manifests: Partial<Record<number, EffectFeatureManifest>> = {};
for (const frameRate of [24, 25, 30] as const) {
  analyse(218.8, frameRate);
  manifests[frameRate] = manifest(analyse(1800, frameRate), frameRate);
  collectGarbage?.();
}
for (const preset of EFFECT_PRESET_CATALOGUE) for (const frameRate of [24, 25, 30] as const) {
  const data = manifests[frameRate]!, value = effect(preset.id, frameRate);
  for (const property of ["brightness", "emission", "size", "speed"] as const) {
    value.reaction.property = property;
    const began = performance.now(), prepared = prepareEffectReaction(value, data), preparationMs = performance.now() - began;
    const evaluateMs: number[] = [], rasterMs: number[] = [], populations: number[] = [];
    for (const [width, height] of [[1280, 720], [1080, 1920]] as const) {
      for (const absoluteFrame of [frameRate * 1799 + 7, 1, frameRate * 777 + 3, frameRate + 1]) {
        const started = performance.now(), frame = evaluateEffectFrame({ effect: value, absoluteFrame, frameRate, targetAspectRatio: width / height, preparedReaction: prepared });
        const evaluated = performance.now(), pixels = rasterizeEffectFrame(frame, width, height), rendered = performance.now();
        evaluateMs.push(evaluated - started); rasterMs.push(rendered - evaluated); populations.push(frame.particles.length); sampleMemory();
        fixtures.push({ id: `${preset.id}/${property}/${frameRate}/${width}x${height}/${absoluteFrame}`, particles: frame.particles.length, sha256: hash(pixels) });
      }
    }
    cases.push({ kind: "reactive-preset", preset: preset.id, property, frameRate, preparationMs, preparedFrames: prepared.values.length,
      evaluateMs: stats(evaluateMs), rasterMs: stats(rasterMs), particles: stats(populations) });
    collectGarbage?.();
  }
}
const data = manifests[30]!, smoke = Array.from({ length: 8 }, (_, index) => effect("smoke", 30, index));
const started = performance.now();
const prepared = prepareEffectReactions(smoke, { [data.manifestKey]: data }, Object.fromEntries(smoke.map(value => [value.id, data.manifestKey])), data.features);
const stackPreparationMs = performance.now() - started;
const evaluateMs: number[] = [], rasterMs: number[] = [], populations: number[] = [];
for (let index = 0; index < 24; index++) {
  const absoluteFrame = index === 0 ? 0 : index === 1 ? 53999 : (Math.imul(index, 2654435761) >>> 0) % 54000;
  const began = performance.now(), frames = smoke.map(value => evaluateEffectFrame({ effect: value, absoluteFrame, frameRate: 30, targetAspectRatio: 16 / 9, preparedReaction: prepared[value.id] }));
  const evaluated = performance.now(), pixels = compositeEffectFrames(frames, 1920, 1080), rendered = performance.now();
  const population = frames.reduce((sum, frame) => sum + frame.particles.length, 0);
  evaluateMs.push(evaluated - began); rasterMs.push(rendered - evaluated); populations.push(population); sampleMemory();
  fixtures.push({ id: `smoke-max8/30/1920x1080/${absoluteFrame}`, particles: population, sha256: hash(pixels) });
}
cases.push({ kind: "maximum-reactive-smoke-stack", effects: smoke.length, frameRate: 30, width: 1920, height: 1080, preparationMs: stackPreparationMs,
  preparedFrames: Object.values(prepared).reduce((sum, value) => sum + value.values.length, 0), evaluateMs: stats(evaluateMs), rasterAndCompositeMs: stats(rasterMs), particles: stats(populations) });
const fixturesSha256 = hash(JSON.stringify(fixtures));
collectGarbage?.();
const report = { format: "editor-effect-analysis-benchmark-v1", generatedAt: new Date().toISOString(),
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, explicitGc: Boolean(collectGarbage) },
  hardware: { logicalCpus: cpus().length, cpuModels: [...new Set(cpus().map(cpu => cpu.model))], totalMemoryBytes: totalmem() },
  renderProfile: EFFECT_RENDER_PROFILE, analysisProfile: EFFECT_ANALYSIS_PROFILE,
  methodology: { loadContext, timingUnit: "milliseconds", memoryUnit: "bytes", percentile: "nearest rank", timingExcludesDigest: true,
    authoredStress: "2000 cues with 300-frame pulses, 2000 points in each curve, smoothing300, strength/weights/limit1; maximum8 smoke stack",
    source: "Deterministic synthetic 48k stereo PCM, opposed polarity with unequal channel amplitudes; bounded8192-pair chunks; native decoding measured separately",
    retention: "Three normalized 30-minute manifests and eight prepared responses remain; pixel surfaces are not retained across samples",
    memorySampling: "After DSP/raster; process RSS high-water included. Sampling cannot prove instantaneous allocation peak.",
    interpretation: "Observed costs under stated load, without real-time or end-to-end claims." },
  memory: { baseline: baselineMemory, sampledPeak: sampledPeakMemory, finalAfterGc: process.memoryUsage(), processMaxRssKiB: process.resourceUsage().maxRSS }, cases, fixtures, fixturesSha256 };
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, cases: cases.length, fixtures: fixtures.length, fixturesSha256, maximumSmoke: cases.at(-1), sampledPeakMemory })}\n`);
if (expectedDigest && fixturesSha256 !== expectedDigest) throw new Error(`Effect analysis fixtures differ: expected ${expectedDigest}, received ${fixturesSha256}`);
