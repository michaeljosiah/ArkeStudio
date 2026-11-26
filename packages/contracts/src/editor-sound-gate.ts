import { z } from "zod";
import { isLayRoomCommand, roomNeedsMeasure } from "./editor-room.js";
import type { TimelineClip, TimelineClipId, TimelineTrack } from "./timeline.js";

const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineClipId>;
/** The tracks whose clips are sound. Spelled here rather than read from the timeline, which reads this module. */
const SOUND_TRACK_KINDS: ReadonlySet<string> = new Set(["audio", "dialogue", "ambience", "music"]);

/**
 * A gate on a sound clip (SPEC-038 R-57, R-58).
 *
 * Every generated take makes its own room, and the room jumps at every cut. The film's first
 * scene kept each take's voice and its clear hits, cut the room under them by 15 dB, and ran one
 * laid room beneath the whole scene. That is a gate, and the Cut had none, so the scene was mixed
 * by a script outside the Studio.
 *
 * A gate here is not a filter that listens while it plays. The sound is measured once, and the
 * stretches where it stands over its own floor are kept on the clip, in seconds of its source.
 * Playing it is then the same kind of arithmetic a fade is: a level read from windows, by one
 * function the browser calls and the export spells into its graph, so the two cannot differ. It
 * also lets the gate open just before a word instead of just after it, which a live gate cannot.
 */
export const SOUND_GATE = Object.freeze({
  /** Outside its kept stretches a gated sound plays this far down. Not silence: a room cut to nothing sounds like a dropout. */
  floorDb: -15,
  /** The level rises over this long before a kept stretch begins, and falls over this long after it ends. */
  attackSec: .01, releaseSec: .15,
  /** The sound is measured in steps this long. */
  stepSec: .01,
  /**
   * The sound's own floor is the level a fifth of its steps sit at or under: its room when nobody
   * speaks. The script that mixed the scene took the middle step, which is the room only while
   * less than half the take is voice; a take that talked for most of its length had its floor in
   * the middle of the talking, and its words were cut. A fifth has the same limit further out:
   * a sound with under a fifth of its length at its room has no room here to find.
   */
  floorFraction: .2,
  /** Kept where it stands this far over that floor, and never asked to stand over -6 dBFS or kept under -60. */
  overFloorDb: 8, maxThresholdDb: -6, minThresholdDb: -60,
  /** A quiet shorter than this inside kept sound stays open: the gap between two words, the stop inside one. */
  holdSec: .15,
  /** A burst shorter than this, alone, is a click and not a sound to keep. */
  minOpenSec: .03,
  /** As many kept stretches as a clip holds; more are joined across their shortest quiets. */
  maxRegions: 400,
  /** A source longer than this is not measured for a gate: a take is seconds long, and a bed is not gated. */
  maxSourceSec: 600,
});

const second = z.number().finite().min(0).max(86_400);
export const SoundGateSchema = z.object({
  /** The level the sound was kept over, as it was measured. What plays is `open`; this is for whoever reads the record. */
  thresholdDb: z.number().finite().min(-120).max(0),
  /** Where the sound is kept, as [from, to) in seconds of its source file, in order and apart. Empty: nothing stood over its floor. */
  open: z.array(z.tuple([second, second])).max(SOUND_GATE.maxRegions),
}).strict().superRefine((gate, ctx) => {
  let end = -1;
  for (const [from, to] of gate.open) {
    if (to <= from || from < end) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A gate's kept stretches are in order, apart and each longer than nothing" }); return; }
    end = to;
  }
});
export type SoundGate = z.infer<typeof SoundGateSchema>;

/**
 * On, with what was measured; or off. A command that says on without a measurement is how a
 * person or Arke asks for one: the coordinator measures the clip's sound and fills it in before
 * the command is applied or a request is stored, so neither a record nor a request ever holds a
 * gate that was not measured (R-58).
 */
export const SoundGateCommandSchema = z.object({ kind: z.literal("sound-gate"), clipId, on: z.boolean(), gate: SoundGateSchema.optional() }).strict();
export type SoundGateCommand = z.infer<typeof SoundGateCommandSchema>;
export const isSoundGateCommand = (value: { kind: string }): value is SoundGateCommand => value.kind === "sound-gate";

/**
 * A clip set to a loudness (R-59). It is never stored: the coordinator measures the clip's sound
 * over the stretch the clip plays, and what is applied is the gain that brings it to this figure.
 */
export const MatchLoudnessCommandSchema = z.object({ kind: z.literal("match-loudness"), clipId, lufs: z.number().finite().min(-50).max(-5) }).strict();
export type MatchLoudnessCommand = z.infer<typeof MatchLoudnessCommandSchema>;
export const isMatchLoudnessCommand = (value: { kind: string }): value is MatchLoudnessCommand => value.kind === "match-loudness";

/** A command the coordinator has to measure sound for before anything pure can apply it. */
export const needsSoundMeasure = (command: { kind: string }): boolean =>
  isMatchLoudnessCommand(command) || isSoundGateCommand(command) && command.on && command.gate === undefined || isLayRoomCommand(command) && roomNeedsMeasure(command);

/** Why a clip cannot be gated, or null when it can: a sound clip, of a file a gate can be measured from. */
export function soundGateProblem(trackKind: string, clip: Pick<TimelineClip, "source">): string | null {
  if (!SOUND_TRACK_KINDS.has(trackKind)) return "Choose a clip on an audio track";
  // A reviewed performance is one voice recorded clean, placed by its own timing: it has no room to gate.
  if (clip.source.kind !== "artifact" && clip.source.kind !== "take") return "A gate is for a take's or a file's own sound";
  return null;
}

export function applySoundGateCommand(tracks: readonly TimelineTrack[], command: SoundGateCommand): TimelineTrack[] {
  const track = tracks.find(row => row.clips.some(clip => clip.id === command.clipId)), clip = track?.clips.find(row => row.id === command.clipId);
  // A video's kept sound has no gate, as it has no gain or fade: Detach audio makes it a clip that does (R-39).
  const problem = !track || !clip ? "Choose a clip on an audio track" : soundGateProblem(track.kind, clip);
  if (!track || !clip || problem !== null) throw new Error(problem ?? "Choose a clip on an audio track");
  if (command.on && command.gate === undefined) throw new Error("A gate is measured from the clip's sound before it is set");
  const { soundGate: was, ...rest } = clip;
  if (!command.on) return was === undefined ? [...tracks] : tracks.map(row => row.id !== track.id ? row : { ...row, clips: row.clips.map(value => value.id !== clip.id ? value : rest) });
  const gate = command.gate!;
  // A gate measured again from the same sound is the gate it was, and writes no revision.
  if (was !== undefined && was.thresholdDb === gate.thresholdDb && was.open.length === gate.open.length && was.open.every((region, i) => region[0] === gate.open[i]![0] && region[1] === gate.open[i]![1])) return [...tracks];
  return tracks.map(row => row.id !== track.id ? row : { ...row, clips: row.clips.map(value => value.id !== clip.id ? value : { ...rest, soundGate: gate }) });
}

/**
 * Where a sound stands over its own floor, from its level in dBFS one step at a time (R-58).
 * Pure, so the measurement the coordinator makes from decoded samples is this one and no other.
 */
export function soundGateFromLevels(levels: ArrayLike<number>, stepSec: number = SOUND_GATE.stepSec): SoundGate {
  const steps = levels.length, profile = SOUND_GATE;
  if (!steps) return { thresholdDb: profile.maxThresholdDb, open: [] };
  const sorted = Float64Array.from(levels).sort();
  const floor = sorted[Math.min(steps - 1, Math.floor(steps * profile.floorFraction))]!;
  const threshold = Math.round(Math.max(profile.minThresholdDb, Math.min(profile.maxThresholdDb, floor + profile.overFloorDb)) * 10) / 10;
  const hold = Math.round(profile.holdSec / stepSec), least = Math.max(1, Math.round(profile.minOpenSec / stepSec));
  const runs: Array<[number, number]> = [];
  for (let s = 0; s < steps; s++) {
    if (!(levels[s]! > threshold)) continue;
    const last = runs[runs.length - 1];
    if (last && s - last[1] <= hold) last[1] = s + 1; else runs.push([s, s + 1]);
  }
  const kept = runs.filter(([from, to]) => to - from >= least);
  // More than a clip holds: the two with the least quiet between them become one, quiet and all.
  while (kept.length > profile.maxRegions) {
    let at = 0;
    for (let i = 1; i + 1 < kept.length; i++) if (kept[i + 1]![0] - kept[i]![1] < kept[at + 1]![0] - kept[at]![1]) at = i;
    kept.splice(at, 2, [kept[at]![0], kept[at + 1]![1]]);
  }
  const milli = (steps_: number) => Math.round(steps_ * stepSec * 1000) / 1000;
  return { thresholdDb: threshold, open: kept.map(([from, to]) => [milli(from), milli(to)]) };
}

/** One kept stretch on the production clock, in seconds. It can begin before a delivery window that opens inside it. */
export interface SoundGateWindow { startSec: number; endSec: number }

/**
 * A gate's share of a sound's level at one moment (R-57): whole inside a kept stretch, down to the
 * gate's floor outside one, rising in a straight line over the attack before a stretch and
 * falling over the release after it. Overlapping slopes take the higher. The browser calls this
 * and the export spells the same lines into its graph (R-42).
 */
export function soundGateAt(item: { gate?: readonly SoundGateWindow[] }, sec: number): number {
  if (item.gate === undefined) return 1;
  const floor = Math.pow(10, SOUND_GATE.floorDb / 20), { attackSec, releaseSec } = SOUND_GATE;
  let open = 0;
  for (const window of item.gate) {
    if (sec >= window.startSec && sec < window.endSec) return 1;
    if (sec < window.startSec && sec > window.startSec - attackSec) open = Math.max(open, 1 - (window.startSec - sec) / attackSec);
    else if (sec >= window.endSec && sec < window.endSec + releaseSec) open = Math.max(open, 1 - (sec - window.endSec) / releaseSec);
  }
  return floor + (1 - floor) * open;
}

/**
 * A clip's kept stretches as windows on the production clock (R-57): those the item can hear,
 * moved from seconds of the source to seconds of the film. `startSec` is where the item starts
 * on the film and `sourceInSec` where it starts in its file.
 */
export function soundGateWindows(clip: Pick<TimelineClip, "soundGate">, item: { startSec: number; endSec: number; sourceInSec: number }): { gate?: SoundGateWindow[] } {
  if (clip.soundGate === undefined) return {};
  const { attackSec, releaseSec } = SOUND_GATE, shift = item.startSec - item.sourceInSec;
  const milli = (value: number) => Math.round(value * 1000) / 1000;
  return { gate: clip.soundGate.open.map(([from, to]) => ({ startSec: milli(from + shift), endSec: milli(to + shift) }))
    .filter(window => window.endSec + releaseSec > item.startSec && window.startSec - attackSec < item.endSec) };
}
