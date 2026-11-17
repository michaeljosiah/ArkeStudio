import { AGENT_SYNC_LIMITS } from "@arke-studio/contracts";

/*
 * Lip sync as a lag between two signals (#3205). The method is the one that found the music
 * video's drift: RMS envelopes in 10 ms steps, Pearson correlation at every lag in a window, the
 * best lag kept. It is signal measurement: a high correlation says the take's sound rises and
 * falls with the reference, not that the words are the same.
 */

export interface SyncResult {
  stepSec: number; lagSec: number | null; correlation: number | null; zeroLagCorrelation: number | null;
  follows: boolean; sourceShiftSec: number | null; takeActiveFraction: number | null; referenceActiveFraction: number;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** RMS of a mono signal in steps of `stepSec`; a partial last step is dropped. */
export function rmsEnvelope(samples: Float32Array, rate: number, stepSec: number): Float64Array {
  const hop = Math.max(1, Math.round(rate * stepSec)), steps = Math.floor(samples.length / hop), envelope = new Float64Array(steps);
  for (let step = 0; step < steps; step++) {
    let sum = 0;
    for (let i = step * hop; i < (step + 1) * hop; i++) sum += samples[i]! * samples[i]!;
    envelope[step] = Math.sqrt(sum / hop);
  }
  return envelope;
}

/** Share of steps louder than `dbfs`. */
export function activeFraction(envelope: ArrayLike<number>, dbfs: number): number {
  if (!envelope.length) return 0;
  const floor = 10 ** (dbfs / 20); let active = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i]! > floor) active++;
  return active / envelope.length;
}

/** Pearson correlation of take[i + lag] with reference[i] over their overlap; null when either side is flat there. */
function correlationAt(take: ArrayLike<number>, reference: ArrayLike<number>, lag: number, minOverlap: number): number | null {
  const start = Math.max(0, -lag), end = Math.min(reference.length, take.length - lag), count = end - start;
  if (count < minOverlap) return null;
  let sumA = 0, sumB = 0;
  for (let i = start; i < end; i++) { sumA += take[i + lag]!; sumB += reference[i]!; }
  const meanA = sumA / count, meanB = sumB / count;
  let cross = 0, varA = 0, varB = 0;
  for (let i = start; i < end; i++) {
    const a = take[i + lag]! - meanA, b = reference[i]! - meanB;
    cross += a * b; varA += a * a; varB += b * b;
  }
  return varA > 1e-18 && varB > 1e-18 ? cross / Math.sqrt(varA * varB) : null;
}

/** The lag (in steps) with the highest correlation; a tie goes to the smaller lag. */
export function bestLag(take: ArrayLike<number>, reference: ArrayLike<number>, maxLagSteps: number, minOverlap: number):
  { lag: number; correlation: number; zeroLag: number | null } | null {
  let best: { lag: number; correlation: number } | null = null;
  for (let lag = -maxLagSteps; lag <= maxLagSteps; lag++) {
    const value = correlationAt(take, reference, lag, minOverlap);
    if (value === null) continue;
    if (!best || value > best.correlation + 1e-12 || Math.abs(value - best.correlation) <= 1e-12 && Math.abs(lag) < Math.abs(best.lag)) best = { lag, correlation: value };
  }
  return best && { ...best, zeroLag: correlationAt(take, reference, 0, minOverlap) };
}

function result(found: ReturnType<typeof bestLag>, stepSec: number, takeActiveFraction: number | null, referenceActiveFraction: number): SyncResult {
  const correlation = found ? round(Math.max(-1, Math.min(1, found.correlation)), 4) : null;
  const lagSec = found ? round(found.lag * stepSec, 3) : null;
  const follows = correlation !== null && correlation >= AGENT_SYNC_LIMITS.follows;
  return { stepSec, lagSec, correlation, zeroLagCorrelation: found?.zeroLag === null || !found ? null : round(Math.max(-1, Math.min(1, found.zeroLag)), 4),
    follows, sourceShiftSec: follows ? lagSec : null, takeActiveFraction: takeActiveFraction === null ? null : round(takeActiveFraction, 4),
    referenceActiveFraction: round(referenceActiveFraction, 4) };
}

/** A take's own soundtrack against the reference it was given; both mono at `rate`. */
export function measureSoundtrackSync(take: Float32Array, reference: Float32Array, rate: number, maxLagSec: number): SyncResult {
  const step = AGENT_SYNC_LIMITS.hopSec, a = rmsEnvelope(take, rate, step), b = rmsEnvelope(reference, rate, step);
  const takeActive = activeFraction(a, AGENT_SYNC_LIMITS.activeDbfs), referenceActive = activeFraction(b, AGENT_SYNC_LIMITS.activeDbfs);
  // A silent side has no shape to line up: say so rather than report the best of noise.
  const found = takeActive < .02 || referenceActive < .02 ? null
    : bestLag(a, b, Math.round(maxLagSec / step), Math.ceil(AGENT_SYNC_LIMITS.minOverlapSec / step));
  return result(found, step, takeActive, referenceActive);
}

/** Mean absolute change between consecutive greyscale frames; entry i is the change into frame i + 1. */
export function frameMotion(frames: readonly Uint8Array[]): Float64Array {
  const motion = new Float64Array(Math.max(0, frames.length - 1));
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!, b = frames[i]!; let sum = 0;
    for (let p = 0; p < b.length; p++) sum += Math.abs(b[p]! - a[p]!);
    motion[i - 1] = sum / b.length;
  }
  return motion;
}

/** The reference's loudness in frame-length steps, then how much it changes into each next step. */
export function loudnessChange(envelope: Float64Array, hopsPerStep: number): Float64Array {
  const steps = Math.floor(envelope.length / hopsPerStep), level = new Float64Array(steps);
  for (let s = 0; s < steps; s++) { let sum = 0; for (let i = 0; i < hopsPerStep; i++) sum += envelope[s * hopsPerStep + i]!; level[s] = sum / hopsPerStep; }
  const change = new Float64Array(Math.max(0, steps - 1));
  for (let s = 1; s < steps; s++) change[s - 1] = Math.abs(level[s]! - level[s - 1]!);
  return change;
}

/**
 * A mouth's motion against the reference. Lips move most when the voice starts and stops, so the
 * motion inside the box is set against how much the loudness changes, frame by frame. Head and
 * camera movement inside the box count as mouth movement: a coarse proxy, reported as such.
 */
export function measureMouthSync(frames: readonly Uint8Array[], fps: number, reference: Float32Array, rate: number, maxLagSec: number): SyncResult {
  const step = 1 / fps, hopsPerStep = Math.max(1, Math.round(step / AGENT_SYNC_LIMITS.hopSec));
  const envelope = rmsEnvelope(reference, rate, AGENT_SYNC_LIMITS.hopSec), referenceActive = activeFraction(envelope, AGENT_SYNC_LIMITS.activeDbfs);
  const found = referenceActive < .02 ? null
    : bestLag(frameMotion(frames), loudnessChange(envelope, hopsPerStep), Math.round(maxLagSec / step), Math.ceil(AGENT_SYNC_LIMITS.minOverlapSec / step));
  return result(found, round(step, 6), null, referenceActive);
}
