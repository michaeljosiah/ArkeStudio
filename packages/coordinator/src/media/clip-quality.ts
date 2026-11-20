import { AGENT_QUALITY_LIMITS } from "@arke-studio/contracts";
import { frameMotion } from "./measure-sync.js";

/*
 * The quality of a generated clip (epic #3070, #3076), as the music video's clips were judged.
 * Cadence: whether frames step evenly, and whether some repeat (a 30 fps file carrying 24 fps
 * motion repeats one frame in five). Detail: how sharp the picture is, and whether that detail
 * holds still or shimmers from frame to frame, which is what separates a good upscale from one
 * that invents texture.
 */

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const percentile = (values: readonly number[], share: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]! : 0;
};

export function measureCadence(frames: readonly Uint8Array[], frameRate: number | null) {
  return cadenceFromSteps(Array.from(frameMotion(frames)), frameRate, frames.length);
}

/** Cadence from frame-to-frame steps already measured (a long film is read in pieces and keeps only its steps). */
export function cadenceFromSteps(steps: readonly number[], frameRate: number | null, framesDecoded: number) {
  /*
   * The baseline is the steps that move. 24 fps footage carried at 60 repeats more than half its
   * frames, so the median of every step is nought though the picture moves: judged by that median
   * it read as a still picture with no repeats at all.
   */
  const moving = steps.filter(step => step >= AGENT_QUALITY_LIMITS.stillStep / 3), median = percentile(moving, .5);
  const still = moving.length < 2 || median < AGENT_QUALITY_LIMITS.stillStep;
  let unevenness: number | null = null;
  if (steps.length >= 2) {
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const deviation = Math.sqrt(steps.reduce((sum, step) => sum + (step - mean) ** 2, 0) / steps.length);
    unevenness = mean > 0 ? round(deviation / mean) : null;
  }
  if (still) return { frameRate: frameRate && round(frameRate), framesDecoded, medianStep: round(median), unevenness, still: true,
    repeatedFrames: null, repeatPeriod: null, motionFps: null };
  const repeats = steps.flatMap((step, i) => step < AGENT_QUALITY_LIMITS.repeatShare * median ? [i] : []);
  /*
   * A repeat pattern is a regular spacing. FFmpeg's fps filter, taking 24 to 30, spaces its
   * repeats 4, 5, 6, 4, 5, 6 frames apart; scattered holds vary far more. So the period is the
   * mean spacing, given only when the spacings stay within a frame of it.
   */
  const gaps = repeats.slice(1).map((at, i) => at - repeats[i]!), meanGap = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const regular = gaps.length >= 2 && Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gaps.length) <= 1 && Math.round(meanGap) >= 2;
  return { frameRate: frameRate && round(frameRate), framesDecoded, medianStep: round(median), unevenness, still: false,
    repeatedFrames: repeats.length, repeatPeriod: regular ? Math.round(meanGap) : null,
    motionFps: frameRate ? round(frameRate * (1 - repeats.length / steps.length), 2) : null };
}

/**
 * Dropped frames: steps about twice the usual one, at a regular spacing. A 30 fps take played in a
 * 24 fps cut loses one frame in five, so every fourth step jumps twice as far; that, not a repeat,
 * was the music video's "choppy". Scattered big steps (a whip pan, a flash) are not a pattern.
 */
export function droppedFromSteps(steps: readonly number[]) {
  const moving = steps.filter(step => step >= AGENT_QUALITY_LIMITS.stillStep / 3), median = percentile(moving, .5);
  if (moving.length < 8 || median < AGENT_QUALITY_LIMITS.stillStep) return { jumps: null, jumpPeriod: null };
  const jumps = steps.flatMap((step, i) => step >= 1.6 * median ? [i] : []);
  const gaps = jumps.slice(1).map((at, i) => at - jumps[i]!), meanGap = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  /*
   * Rate conversions drop a frame every 3 to 6 (30 to 24 every 4, 30 to 25 every 5). Measured on the music video's two exports,
   * other regular spacings were not drops: a strobe every 24 frames, an animated logo's alternate frames.
   */
  const regular = gaps.length >= 3 && Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gaps.length) <= 1 && Math.round(meanGap) >= 3 && Math.round(meanGap) <= 6;
  return { jumps: jumps.length, jumpPeriod: regular ? Math.round(meanGap) : null };
}

/** Absolute 4-neighbour Laplacian of a greyscale frame's interior. */
function laplacian(frame: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(Math.max(0, (width - 2) * (height - 2)));
  let k = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++, k++) {
    const i = y * width + x;
    out[k] = 4 * frame[i]! - frame[i - 1]! - frame[i + 1]! - frame[i - width]! - frame[i + width]!;
  }
  return out;
}

/** The frame averaged in 4x4 blocks: what moves, without its fine detail. */
function blocks(frame: Uint8Array, width: number, height: number): Float32Array {
  const w = Math.floor(width / 4), h = Math.floor(height / 4), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) sum += frame[(y * 4 + dy) * width + x * 4 + dx]!;
    out[y * w + x] = sum / 16;
  }
  return out;
}

export function measureDetail(frames: readonly Uint8Array[], width: number, height: number) {
  const sharpness: number[] = [];
  let change = 0, moved = 0, previous: Float32Array | null = null, previousBlocks: Float32Array | null = null;
  for (const frame of frames) {
    const lap = laplacian(frame, width, height), coarse = blocks(frame, width, height);
    let sum = 0;
    for (const value of lap) sum += Math.abs(value);
    sharpness.push(sum / Math.max(1, lap.length));
    if (previous) {
      let delta = 0; for (let i = 0; i < lap.length; i++) delta += Math.abs(lap[i]! - previous[i]!); change += delta / Math.max(1, lap.length);
      let motion = 0; for (let i = 0; i < coarse.length; i++) motion += Math.abs(coarse[i]! - previousBlocks![i]!); moved += motion / Math.max(1, coarse.length);
    }
    previous = lap; previousBlocks = coarse;
  }
  const pairs = Math.max(1, frames.length - 1), mean = sharpness.reduce((a, b) => a + b, 0) / Math.max(1, sharpness.length);
  return { width, height, frames: frames.length, sharpness: round(percentile(sharpness, .5)), sharpnessLow: round(percentile(sharpness, .1)),
    sharpnessHigh: round(percentile(sharpness, .9)), shimmer: round(mean > 0 ? change / pairs / mean : 0, 4), motion: round(moved / pairs) };
}
