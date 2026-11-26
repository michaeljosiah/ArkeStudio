/*
 * Where a voice is likely in an interval of film sound, for `transcribe_audio` and `review_audio_content`.
 *
 * The measured word reader ends a read's last word at the end of what it was given, and refuses
 * the whole read when a word then spans more than 2.5 s. It only trims a word at quiet under about
 * -70 dBFS, and a room is never that quiet: a 15-second clip with one pause in it came back "a word
 * has no usable timing or an unresolved pause", and Arke reviewed a scene deaf. Read a stretch at a
 * time, with the pauses between lines left out, each read ends close to its own last word.
 *
 * The level a voice has to pass hangs from the interval's own quiet, not from its loud end or a
 * fixed number. The song map's `voiceIntervals` was made for a clean vocal stem and cuts 30 dB
 * under the loud level; room tone at -45 dBFS sits above that, so it hears one run from start to
 * end. Level cannot tell a line from a bed as loud as the line: an interval like that comes back
 * whole, as it was always read, and the caller's plainer reader takes what the measured one refuses.
 */
import { AGENT_TRANSCRIPT_LIMITS } from "@arke-studio/contracts";
import { stepLevels } from "./song-map.js";

export const SPEECH_STRETCH_PROFILE = Object.freeze({
  /** Short enough to find a quarter-second word, long enough to level a vowel's own ripple. */
  stepSec: .05,
  /** The interval's quiet is the level a tenth of its steps sit at or under; a voice is this far over it. */
  quietFraction: .1, overQuietDb: 10,
  /** Never looked for under this, or the hiss of an empty track would count as a voice. */
  floorDbfs: -55,
  /** A shorter gap is a breath inside a line: a word and the pause after it then stay under the reader's 2.5 s. */
  mergeSec: 1,
  /** A shorter run is a click, not a word. */
  minSec: .2,
  /** Kept either side of a run, so a soft onset and the tail of a last word are inside the stretch. */
  padSec: .3,
  /** The reader's own window is 28 s and wants a silent pause to cut at, so a longer stretch is cut here first. */
  maxSec: 24,
  /** With nothing over the quiet: an interval whose loud level, which 19 steps in 20 sit at or under, is this or less holds nothing to read. */
  loudFraction: .95, silentDbfs: -50,
  /** As many as a transcript may hold; more are joined across their shortest pauses. */
  maxStretches: AGENT_TRANSCRIPT_LIMITS.stretches,
});

/**
 * The stretches of `samples` where a voice is likely, in order and apart, in seconds from its
 * start on whole samples, and the level they were cut at (null for less than one step of sound).
 * None means nothing audible. Sound with nothing standing over its own quiet gives the whole
 * interval: a steady bed, a room, a tone, and talk that leaves under a tenth of the interval
 * quiet, which has no quiet to be measured against.
 */
export function voicedStretches(samples: Float32Array, rate: number): { stretches: Array<{ startSec: number; endSec: number }>; thresholdDbfs: number | null } {
  const profile = SPEECH_STRETCH_PROFILE, size = Math.max(1, Math.round(rate * profile.stepSec));
  const levels = stepLevels(samples, rate, profile.stepSec), steps = levels.length;
  // Under one step there is nothing to judge by: it is read whole, as it always was.
  if (!steps) return { stretches: samples.length ? [{ startSec: 0, endSec: samples.length / rate }] : [], thresholdDbfs: null };
  const sorted = Float64Array.from(levels).sort(), level = (fraction: number) => sorted[Math.min(steps - 1, Math.floor(steps * fraction))]!;
  const threshold = Math.max(level(profile.quietFraction) + profile.overQuietDb, profile.floorDbfs), thresholdDbfs = Math.round(threshold * 10) / 10;
  const count = (seconds: number) => Math.round(seconds * rate / size), merge = count(profile.mergeSec), runs: Array<[number, number]> = [];
  for (let s = 0; s < steps; s++) {
    if (levels[s]! <= threshold) continue;
    const previous = runs[runs.length - 1];
    if (previous && s - previous[1] < merge) previous[1] = s + 1; else runs.push([s, s + 1]);
  }
  const voiced = runs.filter(([a, b]) => b - a >= count(profile.minSec));
  if (!voiced.length) {
    if (level(profile.loudFraction) <= profile.silentDbfs) return { stretches: [], thresholdDbfs };
    // Nothing to leave out, so it is one run from end to end. It is still cut below when long: whole, the reader refuses any film sound over its 28 s.
    voiced.push([0, steps]);
  }
  // Each side takes the pad or half the quiet to its neighbour, whichever is less, so no two stretches share a sample.
  const pad = count(profile.padSec), max = Math.max(1, count(profile.maxSec));
  const waiting = voiced.map(([a, b], i): [number, number] => [Math.max(a - pad, i ? Math.ceil((voiced[i - 1]![1] + a) / 2) : 0),
    Math.min(b + pad, i + 1 < voiced.length ? Math.floor((b + voiced[i + 1]![0]) / 2) : steps)]).reverse();
  const pieces: Array<[number, number]> = [];
  while (waiting.length) {
    const [a, b] = waiting.pop()!;
    if (b - a <= max) { pieces.push([a, b]); continue; }
    // As a grouped read is cut for whisper (voice/word-times.ts): at the quietest step between a third and two thirds.
    let cut = a + Math.ceil((b - a) / 3);
    for (let s = cut; s < a + (b - a) * 2 / 3; s++) if (levels[s]! < levels[cut]!) cut = s;
    waiting.push([cut, b], [a, cut]);
  }
  // Too many to read in one call: the two with the least quiet between them become one, pause and all, while that stays short enough to read.
  const gap = (i: number) => pieces[i + 1]![0] - pieces[i]![1], fits = (i: number) => pieces[i + 1]![1] - pieces[i]![0] <= max;
  while (pieces.length > profile.maxStretches) {
    let at = 0;
    for (let i = 1; i + 1 < pieces.length; i++) if (fits(i) === fits(at) ? gap(i) < gap(at) : fits(i)) at = i;
    pieces.splice(at, 2, [pieces[at]![0], pieces[at + 1]![1]]);
  }
  // The last step's end is the interval's: the samples past it, less than a step, are not left off.
  return { thresholdDbfs, stretches: pieces.map(([a, b]) => ({ startSec: a * size / rate, endSec: b === steps ? samples.length / rate : b * size / rate })) };
}
