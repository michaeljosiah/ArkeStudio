import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { AudioArrangementSchema, AudioStudioProposalSchema, type AudioArrangementState, type AudioArrangementTrack, type AudioSource } from "./audio-arrangement-schema.js";
import { audioPassageId, audioSamples, newAudioClip, validateAudioArrangement, type AudioScript } from "./audio-arrangement.js";
import { DRAMA_NARRATOR, dramaLineHash, type EpisodeScriptBlock, type EpisodeTakes } from "./audio-drama.js";

/**
 * An audio drama episode in Audio Studio (SPEC-057 R-67..R-70, design turn 230o): one arrangement
 * an episode, on the same arrangement, mixer and proposals as a chapter's. The script's spoken
 * blocks are its passages, by block id; the rest is placed around them.
 */

/** `productions/<id>/drama-mix/episode-NNN.json`: the episode's arrangement once it is edited, and Arke's proposals. */
export const DramaMixRecordSchema = z.object({
  version: z.literal(1),
  episode: z.number().int().min(1).max(200),
  arrangement: AudioArrangementSchema.optional(),
  audioStudioProposals: z.array(AudioStudioProposalSchema).max(100).optional(),
  updatedAt: IsoDateTimeSchema.optional(),
}).strict();
export type DramaMixRecord = z.infer<typeof DramaMixRecordSchema>;

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
const spoken = (block: EpisodeScriptBlock): block is Spoken => block.kind === "dialogue" || block.kind === "narration";

/** The episode as Audio Studio reads it: each spoken line a passage, keyed by its block id. */
export function episodeAudioScript(scriptHash: string, blocks: readonly EpisodeScriptBlock[]): AudioScript {
  return { hash: scriptHash, passages: blocks.filter(spoken).map((block) => ({ key: block.id, textHash: dramaLineHash(block) })) };
}

/** A scene change, heard as a short breath of nothing. */
export const DRAMA_SCENE_GAP_SEC = 0.8;
/** How early a line that cuts in starts, under the one it breaks (R-18). */
export const DRAMA_CUT_IN_SEC = 0.4;

/**
 * The episode's first arrangement, before anyone edits it (R-67, R-68):
 * - each line follows the reading sequence, after any silence, scene change or sound before it;
 * - a line that cuts in starts under the one it breaks: a sequence placement with a negative offset;
 * - a sound is anchored where it sits, and the next line waits for it;
 * - an ambience loops under its range, to its `until` or its scene's end; music plays from its cue.
 * A line with no current kept take has no clip, and Audio Studio says so.
 */
export function deriveEpisodeArrangement(
  script: AudioScript,
  blocks: readonly EpisodeScriptBlock[],
  takes: EpisodeTakes | undefined,
  soundFile: (artifactId: string) => string | undefined,
  sources: ReadonlyMap<string, AudioSource>,
  name: (speaker: string) => string,
): AudioArrangementState {
  const passages = script.passages.map((passage) => ({ ...passage, id: audioPassageId(passage.key, passage.textHash) }));
  const passageOf = new Map(passages.map((passage) => [passage.key, passage.id]));
  const state: AudioArrangementState = { manuscriptHash: script.hash, passages, tracks: [], clips: [], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } };
  const track = (id: string, label: string): AudioArrangementTrack => {
    let held = state.tracks.find((entry) => entry.id === id);
    if (!held) { held = { id, name: label, gainDb: 0, muted: false }; state.tracks.push(held); }
    return held;
  };
  let gap = 0;
  let last: string | null = null;
  blocks.forEach((block) => {
    if (block.kind === "heading") { if (last !== null) gap += audioSamples(DRAMA_SCENE_GAP_SEC); return; }
    if (block.kind === "silence") { gap += audioSamples(block.seconds); return; }
    if (block.kind === "note" || block.kind === "ambience" || block.kind === "music") return;
    if (block.kind === "sound") {
      const file = block.soundArtifact ? soundFile(block.soundArtifact) : undefined;
      const source = file === undefined ? undefined : sources.get(file);
      if (!source) return;
      const clip = newAudioClip(`sound:${block.id}`, track("sounds", "Sound").id, source, source.samples);
      clip.label = block.heard.slice(0, 200);
      clip.placement = last === null ? { kind: "fixed", at: gap } : { kind: "passage", anchor: { passageId: last, edge: "end", offset: gap } };
      state.clips.push(clip);
      gap += source.samples;
      return;
    }
    if (!spoken(block)) return;
    const kept = takes?.lines[block.id]?.kept;
    const source = kept && kept.textHash === dramaLineHash(block) ? sources.get(kept.file) : undefined;
    const passageId = passageOf.get(block.id)!;
    if (!source) return;
    const speaker = block.kind === "dialogue" ? block.speaker : DRAMA_NARRATOR;
    const lane = track(`voice:${speaker}`, block.kind === "dialogue" ? name(block.speaker) : "Narrator");
    const clip = newAudioClip(`line:${block.id}`, lane.id, source, source.samples);
    clip.label = block.words.slice(0, 200); clip.role = "speech"; clip.passageId = passageId;
    const cutIn = block.kind === "dialogue" && block.overlapsPrevious && last !== null ? -audioSamples(DRAMA_CUT_IN_SEC) : 0;
    clip.placement = { kind: "sequence", offset: gap + cutIn };
    state.clips.push(clip);
    last = passageId;
    gap = 0;
  });

  // Beds run under the lines from their cue: to the block named in `until`, else the scene's end.
  blocks.forEach((block, index) => {
    if (block.kind !== "ambience" && block.kind !== "music") return;
    const file = block.soundArtifact ? soundFile(block.soundArtifact) : undefined;
    const source = file === undefined ? undefined : sources.get(file);
    if (!source) return;
    const sceneEnd = blocks.findIndex((candidate, at) => at > index && candidate.kind === "heading");
    const stop = block.until ? blocks.findIndex((candidate) => candidate.id === block.until) : -1;
    const end = stop > index ? stop : sceneEnd > index ? sceneEnd : blocks.length;
    const under = blocks.slice(index + 1, end).filter(spoken).map((line) => passageOf.get(line.id)!);
    if (under.length === 0) return;
    const lane = block.kind === "ambience" ? track("ambience", "Ambience") : track("music", "Music");
    const clip = newAudioClip(`bed:${block.id}`, lane.id, source, source.samples);
    clip.label = block.heard.slice(0, 200); clip.role = "music"; clip.duckDb = 6;
    clip.gainDb = block.kind === "ambience" ? -12 : -10;
    if (block.kind === "ambience") {
      clip.loop = true;
      clip.placement = { kind: "range", from: { passageId: under[0]!, edge: "start", offset: 0 }, to: { passageId: under.at(-1)!, edge: "end", offset: 0 } };
    } else {
      clip.placement = { kind: "passage", anchor: { passageId: under[0]!, edge: "start", offset: 0 } };
    }
    state.clips.push(clip);
  });
  if (state.tracks.length === 0) track(`voice:${DRAMA_NARRATOR}`, "Narrator");
  return validateAudioArrangement(state);
}
