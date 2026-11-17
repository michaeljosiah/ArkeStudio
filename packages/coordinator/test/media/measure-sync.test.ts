import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSyncMeasurementSchema, MeasureSyncArgsSchema } from "@arke-studio/contracts";
import { activeFraction, bestLag, frameMotion, loudnessChange, measureMouthSync, measureSoundtrackSync, rmsEnvelope } from "../../src/media/measure-sync.js";
import { regionGeometry } from "../../src/media/agent-media-tools.js";

const RATE = 16000;

/** Syllables of noise: random lengths, levels and gaps, the shape a sung line has to an envelope. */
function syllables(seconds: number, seed: number) {
  let state = seed >>> 0;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const envelope = new Float32Array(Math.round(seconds * RATE));
  for (let at = 0; at < envelope.length;) {
    const length = Math.round((.08 + random() * .22) * RATE), level = .1 + random() * .7;
    for (let i = at; i < Math.min(envelope.length, at + length); i++) envelope[i] = level;
    at += length + Math.round((.04 + random() * .16) * RATE);
  }
  const samples = new Float32Array(envelope.length);
  for (let i = 0; i < samples.length; i++) samples[i] = envelope[i]! * (random() * 2 - 1);
  return { samples, envelope };
}
/** The same sound, `lateSec` later (negative: earlier), as a take that sings off the beat would carry it. */
const shifted = (samples: Float32Array, lateSec: number) => {
  const out = new Float32Array(samples.length), by = Math.round(lateSec * RATE);
  for (let i = 0; i < out.length; i++) { const from = i - by; out[i] = from >= 0 && from < samples.length ? samples[from]! : 0; }
  return out;
};

test("a take that sings 120 ms late is found 120 ms late, follows, and is told to start 120 ms later", () => {
  const song = syllables(4, 7).samples, result = measureSoundtrackSync(shifted(song, .12), song, RATE, .6);
  assert.equal(result.lagSec, .12); assert.ok(result.correlation! > .9, String(result.correlation));
  assert.equal(result.follows, true); assert.equal(result.sourceShiftSec, .12);
  assert.ok(result.zeroLagCorrelation! < result.correlation!);
});

test("an early take gets a negative lag", () => {
  const song = syllables(4, 11).samples, result = measureSoundtrackSync(shifted(song, -.08), song, RATE, .6);
  assert.equal(result.lagSec, -.08); assert.equal(result.sourceShiftSec, -.08);
});

test("a take that sings words of its own does not follow, and gets no shift", () => {
  const result = measureSoundtrackSync(syllables(4, 21).samples, syllables(4, 99).samples, RATE, .6);
  assert.ok(result.correlation! < .5, String(result.correlation)); assert.equal(result.follows, false); assert.equal(result.sourceShiftSec, null);
});

test("a silent take has nothing to line up: no lag, no correlation", () => {
  const result = measureSoundtrackSync(new Float32Array(4 * RATE), syllables(4, 3).samples, RATE, .6);
  assert.equal(result.lagSec, null); assert.equal(result.correlation, null); assert.equal(result.follows, false); assert.equal(result.takeActiveFraction, 0);
});

test("a lag outside the window is not reported as found", () => {
  const song = syllables(4, 5).samples, result = measureSoundtrackSync(shifted(song, .9), song, RATE, .6);
  assert.ok(result.lagSec === null || Math.abs(result.lagSec - .9) > .05);
  assert.ok(Math.abs(result.lagSec ?? 0) <= .6);
});

test("envelope, activity and the lag search behave at their edges", () => {
  assert.deepEqual(Array.from(rmsEnvelope(new Float32Array([1, -1, 1, -1, 0]), 2, 1)), [1, 1]);
  assert.equal(activeFraction([0, .1, .2, 0], -45), .5);
  assert.equal(bestLag([1, 2, 3], [1, 2, 3], 5, 10), null);
  // A tie goes to the smaller lag: a constant-step ramp correlates perfectly at every overlap.
  assert.equal(bestLag([0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7], 2, 4)!.lag, 0);
});

test("a mouth that moves when the voice starts and stops, two frames late, is found 80 ms late", () => {
  const { samples, envelope } = syllables(6, 13), fps = 25, frames: Uint8Array[] = [];
  // A frame shows its whole exposure, so each one averages the mouth's opening over its own 40 ms.
  for (let k = 0; k < 6 * fps; k++) {
    const from = Math.round((k / fps - .08) * RATE), to = Math.round(((k + 1) / fps - .08) * RATE); let sum = 0;
    for (let i = from; i < to; i++) sum += i >= 0 && i < envelope.length ? envelope[i]! : 0;
    frames.push(new Uint8Array(64).fill(Math.round(40 + 200 * sum / (to - from))));
  }
  const result = measureMouthSync(frames, fps, samples, RATE, .6);
  assert.equal(result.stepSec, .04); assert.equal(result.lagSec, .08); assert.equal(result.follows, true); assert.equal(result.takeActiveFraction, null);
  assert.equal(frameMotion([new Uint8Array([0, 10]), new Uint8Array([4, 4])])[0], 5);
  assert.deepEqual(Array.from(loudnessChange(new Float64Array([1, 1, 3, 3]), 2)), [2]);
});

test("a window that is not whole steps is searched only inside itself (0.1 s of 40 ms steps is two)", () => {
  const { samples, envelope } = syllables(6, 13), fps = 25, frames: Uint8Array[] = [];
  for (let k = 0; k < 6 * fps; k++) {
    const from = Math.round((k / fps - .12) * RATE), to = Math.round(((k + 1) / fps - .12) * RATE); let sum = 0;
    for (let i = from; i < to; i++) sum += i >= 0 && i < envelope.length ? envelope[i]! : 0;
    frames.push(new Uint8Array(64).fill(Math.round(40 + 200 * sum / (to - from))));
  }
  const result = measureMouthSync(frames, fps, samples, RATE, .1);
  assert.ok(Math.abs(result.lagSec!) <= .1, String(result.lagSec));
  const sound = measureSoundtrackSync(shifted(samples, .09), samples, RATE, .066);
  assert.ok(Math.abs(sound.lagSec!) <= .066, String(sound.lagSec));
  const reference = { source: { kind: "artifact", id: "ar_song" }, sourceHash: `sha256:${"a".repeat(64)}`, streamIndex: 0, startSec: 0, endSec: 6 };
  assert.equal(AgentSyncMeasurementSchema.safeParse({ method: "mouth", streamIndex: 0, region: { x: .4, y: .5, width: .2, height: .15 }, reference, maxLagSec: .1, threshold: .5, ...result }).success, true);
});

test("the measurement schema holds a found lag to its window and a shift to a take that follows", () => {
  const base = { method: "soundtrack", streamIndex: 1, reference: { source: { kind: "artifact", id: "ar_song" }, sourceHash: `sha256:${"a".repeat(64)}`, streamIndex: 0, startSec: 2, endSec: 5 },
    stepSec: .01, maxLagSec: .6, lagSec: .12, correlation: .93, zeroLagCorrelation: .2, threshold: .5, follows: true, sourceShiftSec: .12, takeActiveFraction: .8, referenceActiveFraction: .8 };
  assert.equal(AgentSyncMeasurementSchema.safeParse(base).success, true);
  assert.equal(AgentSyncMeasurementSchema.safeParse({ ...base, lagSec: .9, sourceShiftSec: .9 }).success, false);
  assert.equal(AgentSyncMeasurementSchema.safeParse({ ...base, follows: false }).success, false);
  assert.equal(AgentSyncMeasurementSchema.safeParse({ ...base, correlation: .3 }).success, false);
  assert.equal(AgentSyncMeasurementSchema.safeParse({ ...base, method: "mouth" }).success, false);
  const args = { source: { kind: "artifact", id: "ar_take" }, range: { startSec: 0, endSec: 3 }, reference: { source: { kind: "artifact", id: "ar_song" }, startSec: 2 } };
  assert.equal(MeasureSyncArgsSchema.parse(args).maxLagSec, .6);
  assert.equal(MeasureSyncArgsSchema.safeParse({ ...args, method: "mouth" }).success, false);
  assert.equal(MeasureSyncArgsSchema.safeParse({ ...args, method: "mouth", region: { x: .4, y: .5, width: .2, height: .15 } }).success, true);
  assert.equal(MeasureSyncArgsSchema.safeParse({ ...args, method: "mouth", region: { x: .9, y: .5, width: .2, height: .15 } }).success, false);
});

test("a region crops inside the picture at even sizes, its longer side at most the edge", () => {
  assert.deepEqual(regionGeometry(1280, 720, { x: .4, y: .5, width: .2, height: .15 }, 96), { cropWidth: 256, cropHeight: 108, x: 512, y: 360, outWidth: 96, outHeight: 40 });
  const whole = regionGeometry(1920, 1080, undefined, 1280);
  assert.equal(whole.cropWidth, 1920); assert.equal(whole.outWidth, 1280); assert.equal(whole.outHeight, 720);
  const edge = regionGeometry(101, 51, { x: .99, y: .98, width: .01 + .01, height: .02 }, 96);
  assert.ok(edge.x + edge.cropWidth <= 101 && edge.y + edge.cropHeight <= 51);
});
