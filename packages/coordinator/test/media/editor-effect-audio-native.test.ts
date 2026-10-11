import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCanonicalAudioGraph, type ExportPlan, type EffectAudioNativeDescriptor } from "@arke-studio/contracts";
import { createNodeEffectAudioAnalysisHost, type FrozenAudioInput } from "../../src/media/node-effect-audio.js";
import { createNodeMediaProcessRunner, hashMediaFile } from "../../src/media/node-media-host.js";

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const host = createNodeEffectAudioAnalysisHost({ ffmpeg });
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;
if (process.env["ARKE_EFFECT_NATIVE_REQUIRED"] === "1") assert.ok(available, "Native effect audio acceptance requires FFmpeg");
const evidence = process.env["ARKE_EFFECT_EVIDENCE_DIR"];
if (evidence) await mkdir(resolve(evidence), { recursive: true });
const report: Record<string, unknown> = { platform: process.platform, ffmpegVersion: new TextDecoder().decode(version.stdout).split("\n")[0], cases: [] };
async function run(args: string[]): Promise<Uint8Array> {
  const result = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    signal: signal(), timeoutMs: 30000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}
async function source(dir: string, name: string, rate: number, channels: number, amplitude = 1.75) {
  const path = join(dir, name);
  const expression = Array.from({ length: channels }, (_, ch) => `${amplitude * (ch ? -.6 : 1)}*sin(2*PI*71*t)`).join("|");
  await run(["-y", "-f", "lavfi", "-i", `aevalsrc=${expression}:s=${rate}:d=2`, "-c:a", "pcm_f64le", path]);
  return path;
}
const planFor = (paths: string[]): ExportPlan => ({ preset: "review-cut", frameRate: 24, items: [], overlays: [], totalSec: 2,
  audio: paths.map(path => ({ path, startSec: 0, endSec: 2, gainDb: 0, role: "music", sourceInSec: 0 })),
  mix: { speechFirst: false, duckingDb: -12, lookAheadMs: 100, releaseMs: 300, limiterCeilingDb: -1 } });
const floats = (bytes: Uint8Array) => new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
async function render(plan: ExportPlan, inputs: FrozenAudioInput[], descriptor: EffectAudioNativeDescriptor, selectedClipIds: string[] | null) {
  const buffers: Buffer[] = [];
  const result = await host.renderAudiblePcm({ plan, inputs, descriptor, selectedClipIds, signal: signal(), onPcm: pcm => { buffers.push(Buffer.from(pcm.buffer)); } });
  assert.equal(result.sampleFrames, 96000);
  return floats(Buffer.concat(buffers));
}

test("native audible analysis preserves canonical mono/stereo, ordered mixed-rate negotiation and shared limiter contribution", { skip: !available }, async () => {
  const dir = await mkdtemp(join(evidence ? resolve(evidence) : tmpdir(), "arke-effect-audio-test-"));
  try {
    const cases = [
      { name: "mono", rates: [48000], channels: [1], amplitudes: [1.75] },
      { name: "song-video", rates: [48000, 32000], channels: [2, 2], amplitudes: [1.75, .5] },
      { name: "video-song", rates: [32000, 48000], channels: [2, 2], amplitudes: [1.75, .5] },
      { name: "mono-first", rates: [44100, 48000], channels: [1, 2], amplitudes: [1.75, .5] },
      { name: "stereo-first", rates: [48000, 44100], channels: [2, 1], amplitudes: [1.75, .5] },
      { name: "nonstandard-rate", rates: [44150, 48000], channels: [1, 2], amplitudes: [1.75, .5] },
      { name: "opposed-phase", rates: [48000, 48000], channels: [2, 2], amplitudes: [1.75, -1.75] },
    ];
    for (const fixture of cases) {
      const started = performance.now(), paths: string[] = [];
      for (let i = 0; i < fixture.rates.length; i++) paths.push(await source(dir, `${fixture.name}-${i}.wav`, fixture.rates[i]!, fixture.channels[i]!, fixture.amplitudes[i]!));
      const plan = planFor(paths);
      const inputs: FrozenAudioInput[] = await Promise.all(paths.map(async (absolutePath, audioIndex) => ({ audioIndex, absolutePath, clipId: `clip-${audioIndex}`, sourceHash: await hashMediaFile(absolutePath, signal()) })));
      const descriptor = await host.describe({ plan, inputs, signal: signal() });
      assert.equal(descriptor.canonical.sampleRate, fixture.rates[0]); assert.equal(descriptor.canonical.channels, fixture.channels[0]);
      const graph = buildCanonicalAudioGraph(plan, paths);
      const mono = descriptor.canonical.channels === 1 ? ",pan=stereo|c0=c0|c1=c0" : "";
      graph.filters[graph.filters.length - 1] = `${graph.preLimiter},${graph.limiter}${mono},aresample=48000:resampler=swr:filter_size=32:phase_shift=10:linear_interp=1:exact_rational=1[aout]`;
      const baseline = floats(await run([...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]));
      const composition = await render(plan, inputs, descriptor, null);
      assert.deepEqual(composition, baseline, `${fixture.name}: composition differs from canonical graph`);
      const parts: Float32Array[] = [];
      for (const input of inputs) parts.push(await render(plan, inputs, descriptor, [input.clipId!]));
      let maxSumError = 0, selectedPeak = 0;
      for (let sample = 0; sample < composition.length; sample++) {
        maxSumError = Math.max(maxSumError, Math.abs(parts.reduce((sum, part) => sum + part[sample]!, 0) - composition[sample]!));
        selectedPeak = Math.max(selectedPeak, Math.abs(parts[0]![sample]!));
      }
      assert.ok(maxSumError <= 0.000002, `${fixture.name}: selected contribution sum error ${maxSumError}`);
      if (fixture.name === "opposed-phase") { assert.ok(composition.every(value => value === 0)); assert.ok(selectedPeak > 1.5); }
      const muted = await render(plan, inputs, descriptor, []); assert.ok(muted.every(value => value === 0));
      (report["cases"] as unknown[]).push({ name: fixture.name, descriptor, maxSumError, selectedPeak, exactComposition: true, sampleFrames: 96000, milliseconds: performance.now() - started });
    }
  } finally {
    if (evidence) await writeFile(join(resolve(evidence), "native-effect-audio.json"), JSON.stringify(report, null, 2));
    else await rm(dir, { recursive: true, force: true });
  }
});

test("native audio analysis keeps trims, placement and ducking, refuses changed identities and stops on cancellation", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-effect-audio-boundaries-"));
  try {
    const path = await source(dir, "song.wav", 48000, 2, .3), plan = planFor([path]);
    plan.audio[0] = { ...plan.audio[0]!, sourceInSec: .1, startSec: .5, endSec: 1.5 };
    plan.mix!.speechFirst = true; plan.speech = [{ startSec: .75, endSec: 1.25 }];
    const inputs = [{ audioIndex: 0, absolutePath: path, clipId: "clip-0", sourceHash: await hashMediaFile(path, signal()) }];
    const descriptor = await host.describe({ plan, inputs, signal: signal() });
    const selected = await render(plan, inputs, descriptor, ["clip-0"]), full = await render(plan, inputs, descriptor, null);
    assert.deepEqual(selected, full); assert.ok(selected.slice(0, 48000).every(value => value === 0));
    const rms = (from: number, to: number) => Math.sqrt(selected.slice(from * 96000, to * 96000).reduce((sum, value) => sum + value * value, 0) / ((to - from) * 96000));
    assert.ok(rms(.9, 1.1) < rms(.51, .59) * .3, "speech-first ducking must reach selected source analysis");
    await assert.rejects(host.renderAudiblePcm({ plan, inputs, descriptor: { ...descriptor, decoder: { ...descriptor.decoder, executableHash: "d".repeat(64) } },
      selectedClipIds: null, signal: signal(), onPcm() {} }), /decoder changed/);
    const cancel = new AbortController(); let callbacks = 0;
    await assert.rejects(host.renderAudiblePcm({ plan, inputs, descriptor, selectedClipIds: null, signal: cancel.signal,
      onPcm: () => { callbacks++; cancel.abort(); } }), /cancel|abort/i);
    assert.equal(callbacks, 1);
    const pendingConsumer = new AbortController();
    await assert.rejects(host.renderAudiblePcm({ plan, inputs, descriptor, selectedClipIds: null, signal: pendingConsumer.signal,
      onPcm: () => { setTimeout(() => pendingConsumer.abort(), 10); return new Promise<void>(() => {}); } }), /cancel|abort/i);
    const surround = await source(dir, "surround.wav", 48000, 6, .1);
    await assert.rejects(host.describe({ plan: planFor([surround]), inputs: [{ audioIndex: 0, absolutePath: surround, sourceHash: await hashMediaFile(surround, signal()) }], signal: signal() }), /mono or stereo/);
    const late = planFor([path]); late.totalSec = 1800; late.audio[0] = { ...late.audio[0]!, startSec: 1799, endSec: 1800 };
    const lateStarted = performance.now();
    const lateDescriptor = await host.describe({ plan: late, inputs, signal: signal() });
    assert.equal(lateDescriptor.canonical.sampleRate, 48000);
    report["latePlacement"] = { startSec: 1799, totalSec: 1800, describeMs: performance.now() - lateStarted, fullPcmNotRendered: true };
    await writeFile(path, "replaced");
    await assert.rejects(host.renderAudiblePcm({ plan, inputs, descriptor, selectedClipIds: null, signal: signal(), onPcm() {} }), /source changed/i);
    const silentPlan = planFor([]), silentDescriptor = await host.describe({ plan: silentPlan, inputs: [], signal: signal() });
    assert.ok((await render(silentPlan, [], silentDescriptor, null)).every(value => value === 0));
    report["boundaries"] = { trim: true, placement: true, ducking: true, cancellationCallbacks: callbacks, changedSourceRefused: true, emptyMixSilent: true };
    if (evidence) await writeFile(join(resolve(evidence), "native-effect-audio.json"), JSON.stringify(report, null, 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
