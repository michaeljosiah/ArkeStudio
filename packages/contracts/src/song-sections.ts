import { z } from "zod";
import { ArtifactIdSchema } from "./ids.js";
import type { EffectFeatureData } from "./editor-effect-analysis.js";

/**
 * Where a song changes (issue 3099, SPEC-041 R-68).
 *
 * A music video's scenes follow its song's sections, and nothing in the Studio could say where
 * they are: Arke asked the author for "where each verse, chorus and bridge starts and ends", and
 * the author timed the song in another program. This reads the effects analysis the Studio
 * already makes (SPEC-053 R-14: energy and bass per frame) and finds the places where the sound
 * changes, for a person to accept or move.
 *
 * It finds boundaries, never names. What it can hear is level and low end: a band coming in, a
 * break, a drop, a fade. A verse that turns into a chorus over the same instruments at the same
 * level does not move either measure, and is not found; nothing here says "verse" or "chorus",
 * because nothing here knows.
 */
export const SONG_SECTION_PROFILE = Object.freeze({
  /** The analyzer's finest clock: 33 ms bins. */
  frameRate: 30 as const,
  /** A song's sections are rarely shorter; two changes closer than this are one. */
  minSectionSec: 8,
  /** A stretch longer than this is looked into again for a quieter change. */
  longSectionSec: 40,
  maxSections: 24,
  tempoMinBpm: 70,
  tempoMaxBpm: 180,
  /** How far a pulse must stand above none at all before it is called a tempo. */
  tempoMinStrength: 0.1,
  /** Levels are compared within this many dB of the song's usual level, so a silence or a fade cannot outweigh every change in the music. */
  levelSpanDb: 12,
  /** Seconds of music weighed on each side of a moment. */
  windowSec: 5,
  /**
   * A change this many times the song's usual movement is a boundary on its own; a quieter one is
   * taken only to divide a long stretch. Set on a real song against a map of it made by ear: its
   * boundaries stood at 6.7 times and over, a building intro's swells at 4.7 and under, and the
   * two quieter changes the map also had at 2.6 and 3.2 over a floor of 2.2.
   */
  strongChange: 5.5,
  weakChange: 2.25,
  /** In dB: under this a change is the music moving, however still the rest of the song is. */
  minChangeDb: 0.25,
});

export interface SongSectionsFound {
  /** Beats per minute where the song keeps a steady pulse, else null. */
  tempoBpm: number | null;
  /** Section starts in seconds, ascending. The first is always 0: a song has at least one section. */
  startsSec: number[];
}

/** Samples of `values` at a fractional index, between its two neighbours. */
function between(values: Float64Array, index: number): number {
  const low = Math.floor(index);
  if (low < 0 || low + 1 >= values.length) return 0;
  const part = index - low;
  return values[low]! * (1 - part) + values[low + 1]! * part;
}

/**
 * The song's pulse, from how its rises in level repeat.
 *
 * A comb over sixteen beats rather than the nearest peak: one beat's lag is known to a third of a
 * frame at best, and an error that small is a beat out of place within a verse. Sixteen beats on,
 * the same error is five frames, which the comb can tell apart.
 */
function findPulse(rise: Float64Array, frameRate: number): { periodFrames: number; phaseFrames: number } | null {
  const profile = SONG_SECTION_PROFILE;
  const frames = rise.length;
  const shortest = 60 * frameRate / profile.tempoMaxBpm, longest = 60 * frameRate / profile.tempoMinBpm;
  const beats = 16;
  const lags = Math.ceil(longest * beats) + 2;
  if (frames < lags * 2) return null;
  const repeat = new Float64Array(lags + 1);
  for (let lag = 0; lag <= lags; lag++) {
    let sum = 0;
    for (let index = 0; index + lag < frames; index++) sum += rise[index]! * rise[index + lag]!;
    repeat[lag] = sum / (frames - lag);
  }
  if (!(repeat[0]! > 0)) return null;
  const comb = (period: number, count: number) => {
    let sum = 0;
    for (let beat = 1; beat <= count; beat++) sum += between(repeat, period * beat);
    return sum / count;
  };
  let period = shortest, best = -Infinity;
  for (let candidate = shortest; candidate <= longest; candidate += 0.05) {
    const score = comb(candidate, 4);
    if (score > best) { best = score; period = candidate; }
  }
  if (best / repeat[0]! < profile.tempoMinStrength) return null;
  const coarse = period;
  best = -Infinity;
  for (let candidate = coarse - 0.6; candidate <= coarse + 0.6; candidate += 0.005) {
    const score = comb(candidate, beats);
    if (score > best) { best = score; period = candidate; }
  }
  let phase = 0;
  best = -Infinity;
  for (let candidate = 0; candidate < period; candidate += 0.25) {
    let sum = 0;
    for (let at = candidate; Math.round(at) < frames; at += period) sum += rise[Math.round(at)]!;
    if (sum > best) { best = sum; phase = candidate; }
  }
  return { periodFrames: period, phaseFrames: phase };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Find where a song changes, from the effects analysis of it.
 *
 * Deterministic and bounded: one pass over the frames for the pulse, then work that grows with
 * the song's beats and never with their square, so thirty minutes costs what its length does.
 * The song is measured in beats where it has a pulse and half-seconds where it has none, so a
 * boundary lands on a beat without a second step that could move it off one.
 */
export function findSongSections(data: Pick<EffectFeatureData, "features" | "silent">, frameRate: number): SongSectionsFound {
  const profile = SONG_SECTION_PROFILE;
  const { energy, bass } = data.features;
  const frames = energy.length;
  const durationSec = frames / frameRate;
  if (data.silent || durationSec < profile.minSectionSec * 2) return { tempoBpm: null, startsSec: [0] };

  const rise = new Float64Array(frames);
  let mean = 0;
  for (let index = 1; index < frames; index++) {
    rise[index] = Math.max(0, energy[index]! - energy[index - 1]!) + Math.max(0, bass[index]! - bass[index - 1]!);
    mean += rise[index]!;
  }
  mean /= frames;
  for (let index = 0; index < frames; index++) rise[index]! -= mean;
  const pulse = findPulse(rise, frameRate);

  // The units the song is weighed in: beats, or half-seconds. A sliver at either end joins its neighbour.
  const unitFrames = pulse?.periodFrames ?? frameRate / 2;
  const edges = [0];
  for (let at = pulse?.phaseFrames ?? unitFrames; Math.round(at) < frames; at += unitFrames) {
    if (Math.round(at) - edges[edges.length - 1]! >= unitFrames / 2) edges.push(Math.round(at));
  }
  if (edges.length > 1 && frames - edges[edges.length - 1]! < unitFrames / 2) edges.pop();
  edges.push(frames);
  const units = edges.length - 1;
  const unitSec = unitFrames / frameRate;

  // Each unit's level and low end in dB about the song's usual, held within the span.
  const level = (values: readonly number[]) => {
    const db: number[] = [];
    for (let unit = 0; unit < units; unit++) {
      let sum = 0;
      for (let index = edges[unit]!; index < edges[unit + 1]!; index++) sum += values[index]!;
      db.push(20 * Math.log10(Math.max(sum / (edges[unit + 1]! - edges[unit]!), 0.0001)));
    }
    const usual = median(db);
    const held = db.map((value) => Math.max(-profile.levelSpanDb, Math.min(profile.levelSpanDb, value - usual)));
    // With a beat either side, so a kick and a snare taking turns is not a change.
    const at = (unit: number) => held[Math.max(0, Math.min(units - 1, unit))]!;
    return held.map((_, unit) => (at(unit - 1) + 2 * at(unit) + at(unit + 1)) / 4);
  };
  const loud = level(energy), low = level(bass);

  /*
   * How unlike the music after a moment is to the music before it, less how unlike each side is
   * to itself: high where two steady stretches meet, low inside either, and low where the song is
   * simply restless. Nearer units weigh more. Units past either end count as the end repeated.
   */
  const reach = pulse === null
    ? Math.max(4, Math.round(profile.windowSec / unitSec))
    : Math.max(4, Math.round(profile.windowSec / unitSec / 4) * 4);
  const weight: number[] = [];
  for (let offset = -reach; offset < reach; offset++) weight.push(Math.exp(-0.5 * ((offset + 0.5) / (reach / 2)) ** 2));
  let weightSum = 0;
  for (const a of weight) for (const b of weight) weightSum += a * b;
  const clamp = (unit: number) => Math.max(0, Math.min(units - 1, unit));
  const change = new Float64Array(units + 1);
  const step = new Float64Array(units + 1);
  for (let edge = 1; edge < units; edge++) {
    let sum = 0, before = 0, after = 0;
    for (let a = -reach; a < reach; a++) {
      const one = clamp(edge + a);
      if (a < 0) before += loud[one]! + low[one]!; else after += loud[one]! + low[one]!;
      for (let b = a + 1; b < reach; b++) {
        const other = clamp(edge + b);
        const apart = Math.hypot(loud[one]! - loud[other]!, low[one]! - low[other]!);
        sum += (a < 0 && b >= 0 ? 2 : -2) * weight[a + reach]! * weight[b + reach]! * apart;
      }
    }
    change[edge] = Math.max(0, sum / weightSum);
    step[edge] = (after - before) / reach;
  }

  const usual = median(Array.from(change.subarray(1, units)));
  const strong = Math.max(profile.strongChange * usual, profile.minChangeDb);
  const weak = Math.max(profile.weakChange * usual, profile.minChangeDb);
  const secondsAt = (edge: number) => edges[edge]! / frameRate;
  let peaks: number[] = [];
  for (let edge = 1; edge < units; edge++) {
    if (change[edge]! < weak || change[edge]! < change[edge - 1]! || change[edge]! <= change[edge + 1]!) continue;
    if (secondsAt(edge) < profile.minSectionSec || durationSec - secondsAt(edge) < profile.minSectionSec) continue;
    peaks.push(edge);
  }
  /*
   * A break is one boundary, not two. The music drops out for a bar or two and comes back, and
   * both edges of the gap are changes; the section starts where the music comes back, so of a
   * fall and a rise closer than a section can be, the rise is kept.
   */
  peaks = peaks.filter((edge, index) => {
    const next = peaks[index + 1];
    return !(next !== undefined && secondsAt(next) - secondsAt(edge) < profile.minSectionSec &&
      change[edge]! >= strong && change[next]! >= strong && step[edge]! < 0 && step[next]! > 0);
  });
  const byStrength = [...peaks].sort((a, b) => change[b]! - change[a]! || a - b);
  const chosen: number[] = [];
  const clear = (edge: number) => chosen.every((other) => Math.abs(secondsAt(other) - secondsAt(edge)) >= profile.minSectionSec);
  for (const edge of byStrength) {
    if (chosen.length >= profile.maxSections - 1) break;
    if (change[edge]! >= strong && clear(edge)) chosen.push(edge);
  }
  // A long stretch with no strong change is given its clearest quieter one, until none is long or none is left.
  for (let added = true; added && chosen.length < profile.maxSections - 1;) {
    added = false;
    const bounds = [0, ...chosen.map(secondsAt).sort((a, b) => a - b), durationSec];
    for (const edge of byStrength) {
      if (chosen.includes(edge) || !clear(edge)) continue;
      const at = secondsAt(edge);
      const end = bounds.findIndex((bound) => bound > at);
      if (bounds[end]! - bounds[end - 1]! <= profile.longSectionSec) continue;
      chosen.push(edge);
      added = true;
      break;
    }
  }

  return {
    tempoBpm: pulse === null ? null : Math.round(600 * frameRate / pulse.periodFrames) / 10,
    startsSec: [0, ...chosen.map((edge) => Math.round(secondsAt(edge) * 1000) / 1000).sort((a, b) => a - b)],
  };
}

/** A proposed section's name. Its place in the song is all that is known of it. */
export function proposedSectionLabel(index: number): string {
  return `Section ${index + 1}`;
}

/**
 * What the Studio measured of a song, as the Cut and Arke read it: its length, its tempo where it
 * has one, and where it changes. Proposals only; a section exists once a person marks it on the spine.
 */
export const SongSectionsSchema = z
  .object({
    trackArtifactId: ArtifactIdSchema,
    durationSec: z.number().positive(),
    tempoBpm: z.number().positive().nullable(),
    startsSec: z.array(z.number().min(0)).min(1).max(SONG_SECTION_PROFILE.maxSections),
  })
  .strict();
export type SongSections = z.infer<typeof SongSectionsSchema>;

export const SongSectionsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("measured"), song: SongSectionsSchema }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1).max(300) }).strict(),
]);
export type SongSectionsResult = z.infer<typeof SongSectionsResultSchema>;
