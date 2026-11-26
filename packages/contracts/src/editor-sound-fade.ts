import { z } from "zod";
import type { TimelineClip, TimelineClipId, TimelineTrack } from "./timeline.js";

const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineClipId>, fadeFrames = z.number().int().max(108000);
/** The tracks whose clips are sound. Spelled here rather than read from the timeline, which reads this module. */
const SOUND_TRACK_KINDS: ReadonlySet<string> = new Set(["audio", "dialogue", "ambience", "music"]);

/**
 * A sound clip's fades, in frames from its own edges: up from silence over its first frames and
 * back down over its last (SPEC-038 R-37). Not the picture's `fade`: a build from before this
 * refuses that field off a Picture track, and the world's floor is read from the field's name.
 *
 * `power` draws both fades as a quarter of a sine instead of a straight line (R-54). Two sounds
 * crossing under one another then keep one loudness between them. Two straight lines dip 3 dB at
 * the middle, and a room laid from pieces that cross every few seconds breathes with it.
 */
export const SoundFadeSchema = z.object({ inFrames: fadeFrames.min(1).optional(), outFrames: fadeFrames.min(1).optional(), power: z.literal(true).optional() }).strict()
  .refine(value => value.inFrames !== undefined || value.outFrames !== undefined, "choose a fade");
export type SoundFade = z.infer<typeof SoundFadeSchema>;
// A patch, as picture-fade is: an edge or the shape left out keeps what it has, and 0 removes a fade (R-40).
export const SoundFadeCommandSchema = z.object({ kind: z.literal("sound-fade"), clipId, inFrames: fadeFrames.min(0).optional(), outFrames: fadeFrames.min(0).optional(),
  power: z.boolean().optional() }).strict();
export type SoundFadeCommand = z.infer<typeof SoundFadeCommandSchema>;
export const isSoundFadeCommand = (value: { kind: string }): value is SoundFadeCommand => value.kind === "sound-fade";

export function applySoundFadeCommand(tracks: readonly TimelineTrack[], command: SoundFadeCommand): TimelineTrack[] {
  const track = tracks.find(row => row.clips.some(clip => clip.id === command.clipId)), clip = track?.clips.find(row => row.id === command.clipId);
  // A video's kept sound has no fade, as it has no gain: Detach audio makes it a clip that does (R-39).
  if (!track || !clip || !SOUND_TRACK_KINDS.has(track.kind)) throw new Error("Choose a clip on an audio track");
  const inFrames = command.inFrames ?? clip.soundFade?.inFrames ?? 0, outFrames = command.outFrames ?? clip.soundFade?.outFrames ?? 0;
  // A shape is the shape of a fade: with no fade left there is nothing for it to draw, and it goes with them.
  const power = (inFrames > 0 || outFrames > 0) && (command.power ?? clip.soundFade?.power === true);
  if (inFrames === (clip.soundFade?.inFrames ?? 0) && outFrames === (clip.soundFade?.outFrames ?? 0) && power === (clip.soundFade?.power === true)) return [...tracks];
  const { soundFade: _was, ...rest } = clip;
  const next: TimelineClip = inFrames || outFrames ? { ...rest, soundFade: { ...(inFrames ? { inFrames } : {}), ...(outFrames ? { outFrames } : {}), ...(power ? { power: true as const } : {}) } } : rest;
  return tracks.map(row => row.id !== track.id ? row : { ...row, clips: row.clips.map(value => value.id !== clip.id ? value : next) });
}

/** A split keeps each fade at the edge it was made for, in the shape it had: the cut between the halves is hard (R-41). */
export function splitSoundFade(left: TimelineClip, right: TimelineClip): [TimelineClip, TimelineClip] {
  const edge = (clip: TimelineClip, key: "inFrames" | "outFrames"): TimelineClip => {
    const { soundFade, ...rest } = clip, frames = soundFade?.[key], power = soundFade?.power ? { power: true as const } : {};
    return frames ? { ...rest, soundFade: key === "inFrames" ? { inFrames: frames, ...power } : { outFrames: frames, ...power } } : rest;
  };
  return [edge(left, "inFrames"), edge(right, "outFrames")];
}

/** One edge of a fade on the production clock, in seconds. The start can lie before a delivery window that opens inside it. */
export interface SoundFadeWindow { startSec: number; durationSec: number; power?: true }

/**
 * A fade's share of a sound's level at one moment, 0 through 1 (R-37): a straight line of
 * amplitude up across `fadeIn` and down across `fadeOut`, or a quarter of a sine where the fade is
 * an even-power one (R-54), the two multiplied where they overlap. The browser calls this and the
 * export spells the same two curves into its graph (R-42).
 */
export function soundFadeAt(item: { fadeIn?: SoundFadeWindow; fadeOut?: SoundFadeWindow }, sec: number): number {
  const line = (value: number) => Math.max(0, Math.min(1, value));
  const curve = (window: SoundFadeWindow, value: number) => window.power ? Math.sin(line(value) * Math.PI / 2) : line(value);
  return (item.fadeIn ? curve(item.fadeIn, (sec - item.fadeIn.startSec) / item.fadeIn.durationSec) : 1)
    * (item.fadeOut ? curve(item.fadeOut, (item.fadeOut.startSec + item.fadeOut.durationSec - sec) / item.fadeOut.durationSec) : 1);
}
