import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defaultEffectClip, type EffectClip } from "../src/editor-effects.js";
import { EFFECT_ANALYSIS_PROFILE, EffectFeatureManifestSchema, EffectAudioSourceDescriptorSchema, EffectAnalysisProjectionSchema,
  effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial, type EffectFeatureManifest, type EffectAudioSourceDescriptor } from "../src/editor-effect-analysis.js";
import { createEffectPcmAnalyzer } from "../src/editor-effect-audio-features.js";
import { effectReactionPresetPatch, prepareEffectReaction, prepareEffectReactions, preparedEffectModulationAt, preparedEffectExtraSpeedSeconds } from "../src/editor-effect-reaction.js";
import { evaluateEffectFrame } from "../src/editor-effect-evaluator.js";
import { rasterizeEffectFrame, renderEffectLayersRgba } from "../src/editor-effect-raster.js";

const hash = (input: string | Uint8ClampedArray) => createHash("sha256").update(input).digest("hex");
const native: EffectAudioSourceDescriptor["native"] = { profileId: "audible-pcm-v1", decoder: { versionConfigHash: "1".repeat(64), executableHash: "2".repeat(64) },
  canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
    limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: 0.891251 } },
  analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } };
function manifest(length = 500, fps: 24 | 25 | 30 = 25, level = 0.5): EffectFeatureManifest {
  const descriptor: EffectAudioSourceDescriptor = { profileId: "audible-pcm-v1", binding: { kind: "composition-mix" }, frameRate: fps,
    startFrame: 0, endFrame: length, selectedClipIds: ["cl_sound"], placedWindows: [{ startSec: 0, endSec: length / fps }], audibleWindows: [{ startSec: 0, endSec: length / fps }],
    contributions: [{ path: "artifacts/song.mp3", clipId: "cl_sound", trackId: "tr_sound", startSec: 0, endSec: length / fps, sourceInSec: 0, gainDb: 0, role: "music" }],
    sources: [{ path: "artifacts/song.mp3", sha256: "3".repeat(64) }], mix: { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 }, speech: [], native };
  const value: EffectFeatureManifest = { schemaVersion: 1, profileId: "audible-pcm-v1", manifestKey: "0".repeat(64), sourceFingerprint: hash(effectAudioSourceFingerprintMaterial(descriptor)),
    descriptor, pcmHash: "4".repeat(64), features: { startFrame: 0, endFrame: length, beat: Array(length).fill(level), bass: Array(length).fill(level), energy: Array(length).fill(level) }, likelyBeats: [], silent: level === 0 };
  value.manifestKey = hash(effectManifestFingerprintMaterial(value));
  return value;
}
function effect(): EffectClip {
  const value = defaultEffectClip({ id: "cl_effect", lineageId: "ef_effect", seed: 3735928559, startFrame: 0, durationFrames: 10000 });
  value.audioInput = { kind: "composition-mix" };
  value.reaction = { enabled: true, preset: "custom", version: 1, strength: 1, beat: 0.5, bass: 0.25, energy: 0.25, property: "speed", limit: 0.8, smoothingFrames: 17 };
  return value;
}
function pulsePcm(seconds = 4): Float32Array {
  const samples = new Float32Array(seconds * 48000 * 2);
  for (let sample = 0; sample < samples.length / 2; sample++) {
    const amplitude = sample % 24000 < 4800 ? 0.2 : 0;
    const value = (Math.floor(sample / 480) % 2 ? 1 : -1) * amplitude;
    samples[sample * 2] = value; samples[sample * 2 + 1] = -value * 0.75;
  }
  return samples;
}

test("strict manifests freeze source/mix/tool identity and complete normalized frame arrays", () => {
  const value = manifest();
  assert.deepEqual(EffectFeatureManifestSchema.parse(value), value);
  assert.equal(EffectFeatureManifestSchema.safeParse({ ...value, future: true }).success, false);
  assert.equal(EffectFeatureManifestSchema.safeParse({ ...value, profileId: "future" }).success, false);
  assert.equal(EffectFeatureManifestSchema.safeParse({ ...value, features: { ...value.features, beat: [1] } }).success, false);
  assert.equal(EffectFeatureManifestSchema.safeParse({ ...value, features: { ...value.features, startFrame: 1 } }).success, false);
  assert.equal(EffectFeatureManifestSchema.safeParse({ ...value, silent: true }).success, false);
  assert.equal(EffectAudioSourceDescriptorSchema.safeParse({ ...value.descriptor, sources: [] }).success, false);
  assert.equal(EffectAudioSourceDescriptorSchema.safeParse({ ...value.descriptor, native: { ...native, canonical: { ...native.canonical, limiterDelaySamples: 240 } } }).success, false);
  assert.equal(EffectAudioSourceDescriptorSchema.safeParse({ ...value.descriptor, sources: [{ path: "../outside.mp3", sha256: "3".repeat(64) }] }).success, false);
  assert.equal(EffectAnalysisProjectionSchema.parse({ worldId: "world", productionId: "film", byEffectId: {} }).canPrepare, false);
  assert.equal(EffectAnalysisProjectionSchema.safeParse({ worldId: "world", productionId: "film", byEffectId: { cl_effect: { status: "ready", requestFingerprint: "x", sourceFingerprint: value.sourceFingerprint, manifestKey: value.manifestKey, silent: false, cueConflicts: [] } } }).success, true);
});

test("canonical hash material ignores object insertion order and detects other-bus limiter dependencies", () => {
  const value = manifest(), reversed = Object.fromEntries(Object.entries(value.descriptor).reverse()) as EffectAudioSourceDescriptor;
  assert.equal(effectAudioSourceFingerprintMaterial(reversed), effectAudioSourceFingerprintMaterial(value.descriptor));
  assert.equal(effectManifestFingerprintMaterial({ ...value, manifestKey: "a".repeat(64) }), effectManifestFingerprintMaterial(value));
  const changed = structuredClone(value.descriptor);
  changed.sources.push({ path: "artifacts/other.mp3", sha256: "5".repeat(64) });
  assert.notEqual(effectAudioSourceFingerprintMaterial(changed), effectAudioSourceFingerprintMaterial(value.descriptor));
  changed.mix.duckingDb = -12;
  assert.notEqual(effectAudioSourceFingerprintMaterial(changed), effectAudioSourceFingerprintMaterial(value.descriptor));
});

test("incremental features are chunk-invariant at 24/25/30 fps and keep stereo power", () => {
  const pcm = pulsePcm();
  const expectedHashes: Record<number, string> = {
    24: "c1dafdb6845248fd44a96e94bde5ab225b9cbb5b99de6c6854008f2ae6a7f167",
    25: "c622086ff2a94521317afcc9f05ddb62c1635da71b6b12681ec445b50631ce63",
    30: "727ecc11570e01a8e9c016e972cd4433f44a28fc37a488494d6e172f74d0a059",
  };
  for (const fps of [24, 25, 30]) {
    const whole = createEffectPcmAnalyzer({ frameRate: fps, startFrame: 0, endFrame: 4 * fps }); whole.push(pcm);
    const expected = whole.finish();
    assert.equal(hash(JSON.stringify(expected)), expectedHashes[fps]);
    const chunked = createEffectPcmAnalyzer({ frameRate: fps, startFrame: 0, endFrame: 4 * fps });
    for (let offset = 0; offset < pcm.length; offset += 2062) chunked.push(pcm.subarray(offset, Math.min(pcm.length, offset + 2062)));
    assert.deepEqual(chunked.finish(), expected);
    assert.ok(expected.likelyBeats.length >= 7 && expected.likelyBeats.length <= 9);
    assert.ok(expected.features.bass.some(level => level > 0.1));
    assert.equal(expected.silent, false);
    assert.equal(expected.features.energy.length, fps * 4);
  }
  const opposing = new Float32Array(48000 * 2);
  for (let offset = 0; offset < opposing.length; offset += 2) { opposing[offset] = 0.25; opposing[offset + 1] = -0.25; }
  const analyser = createEffectPcmAnalyzer({ frameRate: 25, startFrame: 0, endFrame: 25 }); analyser.push(opposing);
  assert.equal(analyser.finish().features.energy[10], 0.5);
});

test("analysis preserves gain, rejects incomplete PCM and makes physical silence exactly zero", () => {
  const pcm = pulsePcm(1);
  const analyse = (samples: Float32Array) => { const value = createEffectPcmAnalyzer({ frameRate: 25, startFrame: 0, endFrame: 25 }); value.push(samples); return value.finish(); };
  const loud = analyse(pcm), quiet = analyse(pcm.map(value => value / 2));
  assert.ok(Math.abs(quiet.features.energy[0]! * 2 - loud.features.energy[0]!) <= EFFECT_ANALYSIS_PROFILE.featureQuantum);
  for (const index of [5, 6, 7, 8, 9]) assert.deepEqual([loud.features.energy[index], loud.features.bass[index], loud.features.beat[index]], [0, 0, 0]);
  const silence = analyse(new Float32Array(96000));
  assert.equal(silence.silent, true); assert.deepEqual(silence.likelyBeats, []);
  const short = createEffectPcmAnalyzer({ frameRate: 25, startFrame: 0, endFrame: 1 });
  assert.throws(() => short.finish(), /does not cover/);
  assert.throws(() => short.push(new Float32Array(1)), /stereo/);
  assert.throws(() => short.push(new Float32Array(10000)), /beyond/);
  assert.throws(() => short.push(new Float32Array([NaN, 0])), /unsupported samples/);
});

test("prepared cues cannot bypass silence, mute or physical windows and conflicts retain authored positions", () => {
  const value = effect(), data = manifest();
  value.reaction = { ...value.reaction, beat: 1, bass: 0, energy: 0, smoothingFrames: 300 };
  value.cueOverrides = [{ id: "ec_accent", frame: 200, durationFrames: 30, strength: 1, kind: "accent" }];
  const original = structuredClone(value.cueOverrides);
  const muted = structuredClone(data); muted.descriptor.audibleWindows = [];
  assert.ok(prepareEffectReaction(value, muted).values.every(level => level === 0));
  const silent = manifest(500, 25, 0);
  assert.equal(preparedEffectModulationAt(prepareEffectReaction(value, silent), 205), 0);
  data.descriptor.placedWindows = [{ startSec: 0, endSec: 4 }]; data.descriptor.audibleWindows = [{ startSec: 0, endSec: 4 }];
  const prepared = prepareEffectReaction(value, data);
  assert.equal(preparedEffectModulationAt(prepared, 100), 0);
  assert.equal(prepared.cueConflicts[0]!.cueId, "ec_accent");
  assert.deepEqual(value.cueOverrides, original);
});

test("response presets retain independent controls and zero response matches reaction Off", () => {
  const patch = effectReactionPresetPatch("gentle-shimmer");
  assert.equal("enabled" in patch, false); assert.equal("strength" in patch, false);
  assert.equal(patch.energy, 0.3); assert.equal(effectReactionPresetPatch("beat-pulse").beat, 1);
  const value = effect(), data = manifest();
  value.reaction.strength = 0;
  const prepared = prepareEffectReaction(value, data);
  const on = evaluateEffectFrame({ effect: value, absoluteFrame: 200, frameRate: 25, targetAspectRatio: 16 / 9, preparedReaction: prepared });
  const off = evaluateEffectFrame({ effect: { ...value, reaction: { ...value.reaction, enabled: false } }, absoluteFrame: 200, frameRate: 25, targetAspectRatio: 16 / 9 });
  assert.deepEqual(on.particles, off.particles);
  value.reaction.strength = 1; value.reaction.beat = value.reaction.bass = value.reaction.energy = 0;
  assert.ok(prepareEffectReaction(value, data).values.every(level => level === 0));
});

test("scoped preparation, split and random seeks retain exact reactive particles and pixels", () => {
  const value = effect(), data = manifest(10000);
  value.reactionCurve = { points: [{ id: "ep_a", offsetFrames: 0, value: 0.15, interpolation: "smooth" }, { id: "ep_b", offsetFrames: 9999, value: 0.85, interpolation: "hold" }] };
  value.reaction.smoothingFrames = 300;
  for (let at = 0; at < 10000; at++) data.features.energy[at] = (at % 37) / 40;
  const full = prepareEffectReaction(value, data);
  const right = { ...value, id: "cl_split", startFrame: 4900, durationFrames: 5100 };
  const scoped = prepareEffectReaction(right, data, { startFrame: 5000, endFrame: 5100 });
  for (const absoluteFrame of [5099, 5000, 5025, 5001, 5025]) {
    assert.equal(preparedEffectModulationAt(full, absoluteFrame), preparedEffectModulationAt(scoped, absoluteFrame));
    const one = evaluateEffectFrame({ effect: value, absoluteFrame, frameRate: 25, targetAspectRatio: 16 / 9, preparedReaction: full });
    const two = evaluateEffectFrame({ effect: right, absoluteFrame, frameRate: 25, targetAspectRatio: 16 / 9, preparedReaction: scoped });
    assert.deepEqual(one.particles, two.particles);
    assert.equal(hash(rasterizeEffectFrame(one, 160, 90)), hash(rasterizeEffectFrame(two, 160, 90)));
  }
  assert.throws(() => evaluateEffectFrame({ effect: right, absoluteFrame: 5100, frameRate: 25, targetAspectRatio: 1, preparedReaction: scoped }), /does not cover/);
});

test("speed integrates past response while final zero visibility remains absolute", () => {
  const value = effect(), data = manifest();
  data.features.energy.fill(0, 250);
  const prepared = prepareEffectReaction(value, data);
  assert.equal(preparedEffectModulationAt(prepared, 251), 0);
  assert.ok(preparedEffectExtraSpeedSeconds(prepared, 200, 250) > 0);
  assert.equal(preparedEffectExtraSpeedSeconds(prepared, 200, 250), preparedEffectExtraSpeedSeconds(prepared, 200, 251));
  const hidden = [
    { ...value, appearance: { ...value.appearance, opacity: 0 } },
    { ...value, intensityCurve: { points: [{ id: "ep_zero", offsetFrames: 0, value: 0, interpolation: "hold" as const }] } },
    { ...value, fades: { startFrame: 200, endFrame: 500, inFrames: 40, outFrames: 0 } },
  ];
  for (const clip of hidden) for (const property of ["brightness", "emission", "size", "speed"] as const) {
    clip.reaction = { ...clip.reaction, property, beat: 1, bass: 1, energy: 1, limit: 1, strength: 1 };
    const frame = evaluateEffectFrame({ effect: clip, absoluteFrame: 200, frameRate: 25, targetAspectRatio: 1, preparedReaction: prepareEffectReaction(clip, data) });
    assert.equal(frame.particles.length, 0);
    assert.ok(rasterizeEffectFrame(frame, 160, 90).every(channel => channel === 0));
  }
});

test("overlapping effects resolve their own manifests; unmapped analysis is base-only", () => {
  const first = effect(), second = { ...effect(), id: "cl_second", audioInput: { kind: "audio-clip" as const, clipId: "cl_sound" } };
  first.appearance.amount = second.appearance.amount = 0;
  first.reaction.property = second.reaction.property = "emission";
  const a = manifest(500, 25, 0), b = manifest(500, 25, 1);
  b.descriptor.binding = second.audioInput; b.manifestKey = hash(effectManifestFingerprintMaterial(b));
  const keys = { [first.id]: a.manifestKey, [second.id]: b.manifestKey };
  const bank = prepareEffectReactions([first, second], { [a.manifestKey]: a, [b.manifestKey]: b }, keys, { startFrame: 0, endFrame: 500 });
  const both = renderEffectLayersRgba([first, second], 200, 25, 160, 90, bank);
  assert.ok(both.some((value, index) => index % 4 === 3 && value > 0));
  assert.deepEqual(both, renderEffectLayersRgba([second], 200, 25, 160, 90, bank));
  assert.deepEqual(prepareEffectReactions([first], {}, {}, { startFrame: 0, endFrame: 500 }), {});
  assert.throws(() => prepareEffectReactions([first], {}, keys, { startFrame: 0, endFrame: 500 }), /missing or changed/);
});

test("maximum cue count and smoothing are prepared once with bounded finite values", () => {
  const value = effect(), data = manifest(10000);
  value.reaction.smoothingFrames = 300;
  value.cueOverrides = Array.from({ length: 2000 }, (_, index) => ({ id: `ec_${index}`, frame: index * 3, strength: (index % 10) / 10, durationFrames: 300, kind: index % 2 ? "accent" as const : "suppress" as const }));
  value.reactionCurve = { points: Array.from({ length: 2000 }, (_, index) => ({ id: `ep_${index}`, offsetFrames: index * 5, value: (index % 10) / 10, interpolation: "smooth" as const })) };
  const prepared = prepareEffectReaction(value, data);
  assert.equal(prepared.values.length, 10000);
  assert.ok(prepared.values.every(level => Number.isFinite(level) && level >= 0 && level <= value.reaction.limit));
  for (const at of [0, 9999, 5123, 1, 5123]) assert.equal(preparedEffectModulationAt(prepared, at), prepared.values[at]);
});
