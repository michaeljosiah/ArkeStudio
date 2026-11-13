import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { defaultEffectClip, type EffectClip } from "../packages/contracts/src/editor-effects.js";
import { EFFECT_PRESET_CATALOGUE, EFFECT_RENDER_PROFILE } from "../packages/contracts/src/editor-effect-catalogue.js";
import { evaluateEffectFrame } from "../packages/contracts/src/editor-effect-evaluator.js";
import { compositeEffectFrames, rasterizeEffectFrame } from "../packages/contracts/src/editor-effect-raster.js";

// SPEC-053 R-20: measure the same bounded implementation on both supported OSes.
// Digests are stable fixtures; timings describe this run, not a real-time guarantee.
const outputFlag = process.argv.indexOf("--output");
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) throw new Error("--output needs a JSON path");
const outputPath = resolve(outputFlag >= 0 ? process.argv[outputFlag + 1]! : ".dev/effects-053/t2-benchmark.json");
const expectedFlag = process.argv.indexOf("--expect-pixels-sha256");
const expectedDigest = expectedFlag >= 0 ? process.argv[expectedFlag + 1] : undefined;
if (expectedFlag >= 0 && !/^[a-f0-9]{64}$/.test(expectedDigest ?? "")) throw new Error("--expect-pixels-sha256 needs a lowercase SHA-256 digest");
const loadFlag = process.argv.indexOf("--load-context");
if (loadFlag >= 0 && !process.argv[loadFlag + 1]) throw new Error("--load-context needs a description");
const loadContext = loadFlag >= 0 ? process.argv[loadFlag + 1]! : "Uncontrolled host load; other processes were not isolated or sampled.";
const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
collectGarbage?.();
const baselineMemory = process.memoryUsage();
const peakMemory = { ...baselineMemory };
const sampleMemory = () => {
  const current = process.memoryUsage();
  for (const key of Object.keys(peakMemory) as Array<keyof typeof peakMemory>) peakMemory[key] = Math.max(peakMemory[key], current[key]);
};
const digest = (rgba: Uint8ClampedArray) => createHash("sha256").update(rgba).digest("hex");
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (quantile: number) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
  return { count: values.length, min: sorted[0]!, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1)!, mean: values.reduce((sum, value) => sum + value, 0) / values.length };
};

function fixture(preset: EffectClip["preset"]["id"], fps: number, index = 0): EffectClip {
  const effect = defaultEffectClip({ id: `cl_benchmark${index}`, lineageId: `ef_benchmark${index}`, seed: (3735928559 + index * 7919) >>> 0,
    startFrame: 0, durationFrames: EFFECT_RENDER_PROFILE.maxDurationSeconds * fps, preset });
  effect.appearance = { ...effect.appearance, amount: 1, size: 0.8, opacity: 0.9 };
  return effect;
}

const samples: Array<{ id: string; frame: number; particles: number; sha256: string }> = [];
const cases: Array<Record<string, unknown>> = [];
for (const preset of EFFECT_PRESET_CATALOGUE) for (const fps of [24, 25, 30]) for (const [width, height] of [[1280, 720], [1080, 1920]] as const) {
  const effect = fixture(preset.id, fps);
  const last = effect.durationFrames - 1;
  // Intentionally unordered seeks include opening, distant middle and the 30-minute boundary.
  const frames = [0, last, fps + 7, fps * 1200 + 13, 1, last - fps, fps * 60 + 5, fps - 1, last - 2, fps * 900 + 11, 2, last - 7];
  const evaluateMs: number[] = [], rasterMs: number[] = [], populations: number[] = [];
  for (const at of [0, fps]) rasterizeEffectFrame(evaluateEffectFrame({ effect, absoluteFrame: at, frameRate: fps, targetAspectRatio: width / height }), width, height);
  sampleMemory();
  collectGarbage?.();
  for (const absoluteFrame of frames) {
    const started = performance.now();
    const frame = evaluateEffectFrame({ effect, absoluteFrame, frameRate: fps, targetAspectRatio: width / height });
    const evaluated = performance.now();
    const rgba = rasterizeEffectFrame(frame, width, height);
    const rasterized = performance.now();
    evaluateMs.push(evaluated - started);
    rasterMs.push(rasterized - evaluated);
    populations.push(frame.particles.length);
    sampleMemory();
    samples.push({ id: `${preset.id}/${fps}/${width}x${height}/${absoluteFrame}`, frame: absoluteFrame, particles: frame.particles.length, sha256: digest(rgba) });
  }
  cases.push({ kind: "single-preset", preset: effect.preset, frameRate: fps, width, height, authoredAppearance: effect.appearance,
    evaluateMs: stats(evaluateMs), rasterMs: stats(rasterMs), particles: stats(populations) });
  collectGarbage?.();
}

const smoke = Array.from({ length: EFFECT_RENDER_PROFILE.maxEffects }, (_, index) => {
  const effect = fixture("smoke", 30, index);
  effect.appearance = { ...effect.appearance, amount: 1, size: 1, opacity: 1 };
  return effect;
});
const worstEvaluateMs: number[] = [], worstRasterMs: number[] = [], worstPopulations: number[] = [];
const smokeFrames = Array.from({ length: 24 }, (_, index) => index === 0 ? 0 : index === 1 ? 53999 : (Math.imul(index, 2654435761) >>> 0) % 54000);
for (const absoluteFrame of [0, 30]) compositeEffectFrames(smoke.map(effect => evaluateEffectFrame({ effect, absoluteFrame, frameRate: 30, targetAspectRatio: 16 / 9 })), 1920, 1080);
sampleMemory();
collectGarbage?.();
for (const absoluteFrame of smokeFrames) {
  const started = performance.now();
  const frames = smoke.map(effect => evaluateEffectFrame({ effect, absoluteFrame, frameRate: 30, targetAspectRatio: 16 / 9 }));
  const evaluated = performance.now();
  const rgba = compositeEffectFrames(frames, 1920, 1080);
  const rasterized = performance.now();
  const particles = frames.reduce((count, frame) => count + frame.particles.length, 0);
  worstEvaluateMs.push(evaluated - started);
  worstRasterMs.push(rasterized - evaluated);
  worstPopulations.push(particles);
  sampleMemory();
  samples.push({ id: `smoke-max8/30/1920x1080/${absoluteFrame}`, frame: absoluteFrame, particles, sha256: digest(rgba) });
}
cases.push({ kind: "maximum-smoke-stack", effects: smoke.length, frameRate: 30, width: 1920, height: 1080, authoredAppearance: smoke[0]!.appearance,
  evaluateMs: stats(worstEvaluateMs), rasterAndCompositeMs: stats(worstRasterMs), particles: stats(worstPopulations) });
collectGarbage?.();
const samplesSha256 = createHash("sha256").update(JSON.stringify(samples)).digest("hex");
const report = {
  format: "editor-effects-benchmark-v1", generatedAt: new Date().toISOString(), rendererVersion: EFFECT_RENDER_PROFILE.id,
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, explicitGc: Boolean(collectGarbage) },
  hardware: { logicalCpus: cpus().length, cpuModels: [...new Set(cpus().map(cpu => cpu.model))], totalMemoryBytes: totalmem() },
  profile: EFFECT_RENDER_PROFILE, catalogue: EFFECT_PRESET_CATALOGUE,
  methodology: { timingUnit: "milliseconds", memoryUnit: "bytes", perCaseWarmupFrames: 2, retainedPixelSurfaces: "No samples retained between iterations; digests and numeric observations only",
    percentile: "nearest rank", timingExcludesDigest: true, sourceDecodingAndWorkerTransferIncluded: false, loadContext,
    memorySampling: "After each raster; process-wide RSS high-water is also reported. Sampling cannot prove an exact instantaneous allocation peak.",
    interpretation: "Observed software renderer costs on this machine, without real-time playback claims; native export and browser frame checks are separate fixtures." },
  memory: { baseline: baselineMemory, sampledPeak: peakMemory, finalAfterGc: process.memoryUsage(), processMaxRssKiB: process.resourceUsage().maxRSS },
  cases, samples, samplesSha256,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, cases: cases.length, pixelFixtures: samples.length, samplesSha256, maximumSmoke: cases.at(-1), sampledPeakMemoryBytes: peakMemory })}\n`);
if (expectedDigest && samplesSha256 !== expectedDigest) throw new Error(`Effect pixel fixtures differ: expected ${expectedDigest}, received ${samplesSha256}`);
