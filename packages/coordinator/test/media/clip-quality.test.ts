import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentClipCadenceSchema, AgentClipQualitySchema } from "@arke-studio/contracts";
import { droppedFromSteps, measureCadence, measureDetail } from "../../src/media/clip-quality.js";
import { createAgentMediaTools, parseLoudness, parseStreamRate } from "../../src/media/agent-media-tools.js";
import { percentChange } from "../../src/world-chat/media-measure.js";

const W = 64, H = 36;
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A textured picture panned `shift` pixels a frame: real motion, detail that moves with it. */
const texture = (() => { const next = random(5), wide = new Uint8Array((W + 400) * H); for (let i = 0; i < wide.length; i++) wide[i] = 60 + Math.round(next() * 120); return wide; })();
const pan = (at: number) => { const frame = new Uint8Array(W * H), x0 = Math.round(at); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame[y * W + x] = texture[y * (W + 400) + x + x0]!; return frame; };

test("30 fps motion steps evenly with no repeats; 24 fps motion carried at 30 repeats every fifth frame", () => {
  const smooth = Array.from({ length: 60 }, (_, i) => pan(i * 2));
  const even = measureCadence(smooth, 30);
  assert.equal(even.repeatedFrames, 0); assert.equal(even.repeatPeriod, null); assert.equal(even.motionFps, 30); assert.equal(even.still, false);
  // The Cut's fps conform: frame k of 30 shows source frame floor(k * 24 / 30).
  const conformed = Array.from({ length: 60 }, (_, k) => pan(Math.floor(k * 24 / 30) * 2.5));
  const stutter = measureCadence(conformed, 30);
  assert.equal(stutter.repeatPeriod, 5); assert.equal(stutter.repeatedFrames, 12); assert.equal(stutter.motionFps, 23.9);
  assert.ok(stutter.unevenness! > even.unevenness! + .3, `${stutter.unevenness} against ${even.unevenness}`);
  assert.equal(AgentClipCadenceSchema.safeParse(stutter).success, true);
});

test("24 fps motion carried at 60 repeats most frames and still reads as moving at 24", () => {
  const frames = Array.from({ length: 120 }, (_, k) => pan(Math.floor(k * 24 / 60) * 2));
  const cadence = measureCadence(frames, 60);
  assert.equal(cadence.still, false); assert.ok(cadence.repeatedFrames! > 60, String(cadence.repeatedFrames));
  assert.ok(Math.abs(cadence.motionFps! - 24) < .5, String(cadence.motionFps));
  assert.ok(cadence.medianStep > 1, String(cadence.medianStep));
  assert.equal(percentChange(0, 2), null); assert.equal(percentChange(2, 3), 50); assert.equal(percentChange(2, 2), 0);
});

test("a still picture has no cadence to read rather than every frame a repeat", () => {
  const still = measureCadence(Array.from({ length: 30 }, () => pan(0)), 30);
  assert.equal(still.still, true); assert.equal(still.repeatedFrames, null); assert.equal(still.motionFps, null);
  assert.equal(AgentClipCadenceSchema.safeParse({ ...still, repeatedFrames: 3 }).success, false);
  assert.equal(parseStreamRate("30000/1001")! .toFixed(3), "29.970"); assert.equal(parseStreamRate("0/0"), null); assert.equal(parseStreamRate(undefined), null);
});

test("a softened copy loses sharpness; added real detail raises sharpness, not shimmer; flicker on a still picture is all shimmer", () => {
  const frames = Array.from({ length: 20 }, (_, i) => pan(i));
  const blur = (frame: Uint8Array) => frame.map((_, i) => { const x = i % W; return Math.round(((frame[i - 1] ?? frame[i]!) + frame[i]! + (x < W - 1 ? frame[i + 1]! : frame[i]!)) / 3); });
  const sharp = measureDetail(frames, W, H), soft = measureDetail(frames.map(blur), W, H);
  assert.ok(soft.sharpness < sharp.sharpness * .8, `${soft.sharpness} against ${sharp.sharpness}`);
  // The same pan with its detail strengthened, as a good upscale gives: sharper, and the detail moves with the picture.
  const stronger = measureDetail(frames.map(frame => frame.map(value => Math.round(150 + (value - 120) * 1.5))), W, H);
  assert.ok(stronger.sharpness > sharp.sharpness * 1.4, `${stronger.sharpness} against ${sharp.sharpness}`);
  assert.ok(Math.abs(stronger.shimmer / sharp.shimmer - 1) < .05, `${stronger.shimmer} against ${sharp.shimmer}`);
  const held = measureDetail(Array.from({ length: 20 }, () => pan(3)), W, H);
  assert.equal(held.shimmer, 0); assert.equal(held.motion, 0);
  const next = random(8), flicker = measureDetail(Array.from({ length: 20 }, () => pan(3).map(value => value + Math.round((next() - .5) * 30))), W, H);
  assert.ok(flicker.shimmer > .3, String(flicker.shimmer));
});

test("every native frame of a variable-rate interval is taken, though it holds more than the file's average rate", async () => {
  const fake = createAgentMediaTools({ run: async () => ({ code: 0, stdout: Buffer.alloc(60 * 16 * 16), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false }) });
  const stream = { index: 0, kind: "video" as const, codec: "h264", width: 16, height: 16, frameRate: "30/1", durationSec: 10, startTimeSec: 0 };
  const read = await fake.grayFrames!("clip", stream, 2, 3, { fps: null, edge: 16 }, new AbortController().signal);
  assert.equal(read.frames.length, 60); assert.equal(read.fps, 30);
});

test("a 30 fps take played at 24 steps twice as far every fourth frame; a strobe every 24 frames and a whip pan are not drops", () => {
  const conformed = Array.from({ length: 80 }, (_, i) => i % 4 === 3 ? 6 : 3);
  assert.deepEqual(droppedFromSteps(conformed), { jumps: 20, jumpPeriod: 4 });
  assert.equal(droppedFromSteps(Array.from({ length: 96 }, (_, i) => i % 24 === 23 ? 7 : 3)).jumpPeriod, null);
  assert.equal(droppedFromSteps(Array.from({ length: 60 }, (_, i) => i === 30 ? 12 : 3)).jumpPeriod, null);
  assert.deepEqual(droppedFromSteps([0, 0, 0]), { jumps: null, jumpPeriod: null });
});

test("FFmpeg's ebur128 log reads as integrated loudness, range, true peak and the loudest short-term second", () => {
  const log = "[Parsed_ebur128_0 @ 0] t: 0.1 TARGET:-23 LUFS M:-120.7 S:-120.7 I: -70.0 LUFS LRA: 0.0 LU\n[Parsed_ebur128_0 @ 0] t: 3.1 TARGET:-23 LUFS M: -14.2 S: -12.4 I: -13.9 LUFS LRA: 2.0 LU\n"
    + "[Parsed_ebur128_0 @ 0] t: 3.2 TARGET:-23 LUFS M: -13.0 S: -10.3 I: -13.7 LUFS LRA: 2.1 LU\n"
    + "[Parsed_ebur128_0 @ 0] Summary:\n\n  Integrated loudness:\n    I:         -13.6 LUFS\n    Threshold: -23.7 LUFS\n\n  Loudness range:\n    LRA:         4.2 LU\n\n  True peak:\n    Peak:       -1.2 dBFS\n";
  assert.deepEqual(parseLoudness(log), { integratedLufs: -13.6, rangeLu: 4.2, truePeakDbtp: -1.2, shortTermMaxLufs: -10.3 });
  assert.deepEqual(parseLoudness("Summary:\n I: -inf LUFS\n LRA: 0.0 LU\n Peak: -inf dBFS\n"), { integratedLufs: null, rangeLu: 0, truePeakDbtp: null, shortTermMaxLufs: null });
  assert.throws(() => parseLoudness("no summary"));
});

test("the quality schema meets two clips at one size", () => {
  const cadence = { frameRate: 30, framesDecoded: 60, medianStep: 3, unevenness: .2, still: false, repeatedFrames: 0, repeatPeriod: null, motionFps: 30 };
  const detail = { width: 960, height: 540, frames: 60, sharpness: 5, sharpnessLow: 4, sharpnessHigh: 6, shimmer: 1, motion: 5 };
  const base = { streamIndex: 0, cadence, detail, compare: null };
  assert.equal(AgentClipQualitySchema.safeParse(base).success, true);
  const compare = { streamIndex: 0, cadence, detail, source: { kind: "artifact", id: "ar_b" }, sourceHash: `sha256:${"c".repeat(64)}`, range: { startSec: 0, endSec: 2 }, sharpnessChangePct: 16.6, shimmerChangePct: .3 };
  assert.equal(AgentClipQualitySchema.safeParse({ ...base, compare }).success, true);
  assert.equal(AgentClipQualitySchema.safeParse({ ...base, compare: { ...compare, detail: { ...detail, width: 1920 } } }).success, false);
});
