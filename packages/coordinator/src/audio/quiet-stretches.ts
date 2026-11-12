import { Resampler } from "@arke-studio/voice";

/**
 * Where a reading goes quiet and breathy (SPEC-047 R-196): a whisper, measured from the audio
 * rather than taken from the direction. Gemini's whisper ran on past the words it was set on —
 * fourteen seconds of narration after a whispered text message, a farewell the prose says is in
 * the speaker's ordinary voice — and nothing in the split check could see it, because the words
 * were all there (Na Love or Juju, 2026-11-10).
 *
 * Gemini's whisper is not unvoiced: it is a soft, breathy reading about eight dB under the
 * narrator's usual level with roughly half the voicing. Ordinary narration in that book sat at
 * −13…−18 dB with two thirds of its speech frames voiced; whispered stretches at −22…−28 dB with
 * under 0.45. Either measure alone mistakes a quiet line or a run of sibilants for a whisper, so a
 * stretch needs both, against the chapter's own level rather than a fixed one, for at least three
 * seconds.
 */

/** Voicing is judged at 8 kHz: a pitch between 65 and 400 Hz needs nothing above it. */
const RATE = 8_000;
const FRAME = 320; // 40 ms
const HOP = 160; // 20 ms
const MIN_LAG = Math.floor(RATE / 400);
const MAX_LAG = Math.ceil(RATE / 65);
/** A frame is voiced when its normalized autocorrelation finds a pitch this clearly. */
const VOICED = 0.45;
/** The windows a stretch is judged in: three seconds, every half second. */
const WINDOW_HOPS = 25;
const WINDOW_HALF = 75;
const MIN_SPEECH_FRAMES = 30;
/**
 * Work between yields, so a long take does not hold the coordinator: about a tenth of a second
 * of resampling, and about half a second of frames.
 */
const SAMPLES_PER_YIELD = 80_000;
const FRAMES_PER_YIELD = 3_000;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The take at 8 kHz, band-limited (see wav.ts), a slice at a time. */
async function atRate(samples: Float32Array, rate: number, signal?: AbortSignal): Promise<Float32Array> {
  if (rate === RATE) return samples;
  const resampler = new Resampler(samples, rate, RATE);
  const out = new Float32Array(resampler.outputLength);
  for (let from = 0; from < out.length; from += SAMPLES_PER_YIELD) {
    resampler.run(out, from, Math.min(out.length, from + SAMPLES_PER_YIELD));
    if (from + SAMPLES_PER_YIELD < out.length) { await turn(); signal?.throwIfAborted(); }
  }
  return out;
}
/** How far under the chapter's usual level, and how little voiced, a whisper is. */
const QUIET_DB = 5;
const QUIET_VOICED = 0.45;
const MIN_STRETCH_SEC = 3;

export interface ReadingWindow {
  /** The window's centre, in seconds. */
  readonly atSec: number;
  /** The 90th percentile of its speech frames' level, dBFS; null where it holds too little speech. */
  readonly levelDb: number | null;
  /** The share of its speech frames that are voiced; null where it holds too little speech. */
  readonly voiced: number | null;
}
export interface ReadingProfile {
  readonly seconds: number;
  readonly windows: readonly ReadingWindow[];
}
export interface QuietStretch {
  readonly fromSec: number;
  readonly toSec: number;
  /** The stretch's quietest-typical level and voicing, for the reader to weigh. */
  readonly levelDb: number;
  readonly voiced: number;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

/** One take's level and voicing over time, mono samples in −1..1 at any rate. */
export async function readingProfile(samples: Float32Array, rate: number, signal?: AbortSignal): Promise<ReadingProfile> {
  const x = await atRate(samples, rate, signal);
  const seconds = samples.length / rate;
  const count = x.length < FRAME ? 0 : 1 + Math.floor((x.length - FRAME) / HOP);
  const db = new Float32Array(count), voiced = new Uint8Array(count);
  const frame = new Float32Array(FRAME), squares = new Float64Array(FRAME + 1);
  for (let f = 0; f < count; f++) {
    if (f > 0 && f % FRAMES_PER_YIELD === 0) { await turn(); signal?.throwIfAborted(); }
    const at = f * HOP;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += x[at + i]!;
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) { const v = x[at + i]! - mean; frame[i] = v; squares[i + 1] = squares[i]! + v * v; }
    const energy = squares[FRAME]!;
    db[f] = 10 * Math.log10(energy / FRAME + 1e-18);
    if (energy <= 1e-12) continue;
    // The normalized cross-correlation of the frame with itself at each lag, each side's energy
    // over the samples it actually shares, so a long lag is not penalised for overlapping less.
    let best = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let cross = 0;
      for (let i = 0; i + lag < FRAME; i++) cross += frame[i]! * frame[i + lag]!;
      const head = squares[FRAME - lag]!, tail = energy - squares[lag]!;
      const r = cross / Math.sqrt(head * tail + 1e-18);
      if (r > best) best = r;
    }
    voiced[f] = best > VOICED ? 1 : 0;
  }
  // Speech is what stands within thirty dB of the take's loud level: a whispered take is quieter
  // throughout, and a fixed floor would count its whisper as silence.
  const loud = count > 0 ? percentile(Array.from(db), 0.95) : -120;
  const gate = Math.min(-40, Math.max(-60, loud - 30));
  const windows: ReadingWindow[] = [];
  for (let c = 0; c < count; c += WINDOW_HOPS) {
    const levels: number[] = [];
    let voicedCount = 0;
    for (let f = Math.max(0, c - WINDOW_HALF); f < Math.min(count, c + WINDOW_HALF); f++) {
      if (db[f]! <= gate) continue;
      levels.push(db[f]!);
      voicedCount += voiced[f]!;
    }
    const atSec = Math.round((c * HOP / RATE) * 100) / 100;
    windows.push(levels.length < MIN_SPEECH_FRAMES ? { atSec, levelDb: null, voiced: null }
      : { atSec, levelDb: Math.round(percentile(levels, 0.9) * 10) / 10, voiced: Math.round((voicedCount / levels.length) * 100) / 100 });
  }
  return { seconds, windows };
}

/** The usual level of a chapter's reading: the median of its takes' windows. Null without speech. */
export function readingLevel(profiles: readonly ReadingProfile[]): number | null {
  const levels = profiles.flatMap((profile) => profile.windows.flatMap((window) => (window.levelDb === null ? [] : [window.levelDb])));
  return levels.length === 0 ? null : percentile(levels, 0.5);
}

/** Where one take goes quiet and breathy against its chapter's usual level, three seconds or more. */
export function quietStretches(profile: ReadingProfile, level: number): QuietStretch[] {
  const quiet = profile.windows.map((window) => window.levelDb !== null && window.voiced !== null && window.levelDb < level - QUIET_DB && window.voiced < QUIET_VOICED);
  const runs: Array<[number, number]> = [];
  quiet.forEach((on, index) => {
    if (!on) return;
    const last = runs.at(-1);
    // Windows a second apart are one stretch: a pause inside a whisper is still the whisper.
    if (last !== undefined && index - last[1] <= 2) last[1] = index; else runs.push([index, index]);
  });
  const half = WINDOW_HALF * HOP / RATE;
  // A stretch reaches a second short of its windows' edges either side: the window is three
  // seconds wide, and a quiet one can hold a second of louder reading at each end.
  const spans = runs.map(([first, last]) => ({ first, last,
    fromSec: Math.max(0, profile.windows[first]!.atSec - half + 0.5), toSec: Math.min(profile.seconds, profile.windows[last]!.atSec + half - 0.5) }));
  const joined: typeof spans = [];
  for (const span of spans) {
    const last = joined.at(-1);
    if (last !== undefined && span.fromSec - last.toSec <= 1) { last.last = span.last; last.toSec = span.toSec; } else joined.push({ ...span });
  }
  return joined.flatMap(({ first, last, fromSec, toSec }) => {
    if (toSec - fromSec < MIN_STRETCH_SEC) return [];
    const inside = profile.windows.slice(first, last + 1).filter((_window, offset) => quiet[first + offset]);
    return [{ fromSec: Math.round(fromSec * 10) / 10, toSec: Math.round(toSec * 10) / 10,
      levelDb: percentile(inside.map((window) => window.levelDb!), 0.5), voiced: percentile(inside.map((window) => window.voiced!), 0.5) }];
  });
}
