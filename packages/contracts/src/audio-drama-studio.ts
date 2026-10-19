import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { AudioArrangementSchema, AudioStudioProposalSchema, type AudioArrangementState, type AudioArrangementTrack, type AudioSource } from "./audio-arrangement-schema.js";
import { audioPassageId, audioSamples, newAudioClip, validateAudioArrangement, type AudioScript } from "./audio-arrangement.js";
import { DRAMA_NARRATOR, dramaLineHash, dramaTakePlays, type EpisodeScriptBlock, type EpisodeTakes } from "./audio-drama.js";

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

type Voice = { provider: string; voiceId: string; model?: string | undefined };
/** Where a block falls: from the episode's start before any line is heard, else after the last line. */
type Cue = { at: number } | { passageId: string; edge: "end"; offset: number };

/**
 * The episode's first arrangement, before anyone edits it (R-67, R-68):
 * - each line follows the reading sequence, after any silence, scene change or sound before it;
 * - a line that cuts in starts under the one it breaks: a sequence placement with a negative offset;
 * - a sound is anchored where it sits, and the next line waits for it;
 * - an ambience loops from its cue to its `until` or its scene's end; music plays from its cue.
 * A line with no kept take in the role's voice now has no clip, and Audio Studio says so; one whose
 * words were edited since keeps its take until it is retaken (R-36).
 */
export function deriveEpisodeArrangement(
  script: AudioScript,
  blocks: readonly EpisodeScriptBlock[],
  takes: EpisodeTakes | undefined,
  soundFile: (artifactId: string) => string | undefined,
  sources: ReadonlyMap<string, AudioSource>,
  name: (speaker: string) => string,
  /** The role's voice now (codex on PR 1879): a take in another voice is left out; one for older words plays (R-36). */
  voice: (block: Spoken) => Voice | undefined = () => undefined,
): AudioArrangementState {
  const passages = script.passages.map((passage) => ({ ...passage, id: audioPassageId(passage.key, passage.textHash) }));
  const passageOf = new Map(passages.map((passage) => [passage.key, passage.id]));
  const state: AudioArrangementState = { manuscriptHash: script.hash, passages, tracks: [], clips: [], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } };
  const track = (id: string, label: string): AudioArrangementTrack => {
    let held = state.tracks.find((entry) => entry.id === id);
    if (!held) { held = { id, name: label, gainDb: 0, muted: false }; state.tracks.push(held); }
    return held;
  };
  const sourceOf = (artifactId: string | undefined) => {
    const file = artifactId ? soundFile(artifactId) : undefined;
    return file === undefined ? undefined : sources.get(file);
  };
  // `gap` is what has passed since the last line ended; `clock` is the episode's time, in samples.
  let gap = 0, clock = 0;
  let last: { id: string; samples: number } | null = null, first: { id: string; at: number } | null = null;
  // A cut-in breaks the line just before it, and only when that line was performed (codex on PR 1879).
  let previousPerformed = false;
  // A scene change is heard after anything at all, a sound-only cold open too (codex on PR 1879).
  let begun = false;
  const cues: Cue[] = [], times: number[] = [];
  const here = (): Cue => last === null ? { at: gap } : { passageId: last.id, edge: "end", offset: gap };
  const pass = (samples: number) => { gap += samples; clock += samples; };
  blocks.forEach((block, index) => {
    cues[index] = here(); times[index] = clock;
    if (block.kind === "heading") { if (begun) pass(audioSamples(DRAMA_SCENE_GAP_SEC)); return; }
    if (block.kind === "silence") { begun = true; pass(audioSamples(block.seconds)); return; }
    if (block.kind === "note" || block.kind === "ambience" || block.kind === "music") return;
    if (block.kind === "sound") {
      const source = sourceOf(block.soundArtifact);
      if (!source) return;
      const clip = newAudioClip(`sound:${block.id}`, track("sounds", "Sound").id, source, source.samples);
      clip.label = block.heard.slice(0, 200);
      const at = here();
      clip.placement = "at" in at ? { kind: "fixed", at: at.at } : { kind: "passage", anchor: at };
      state.clips.push(clip);
      begun = true;
      pass(source.samples);
      return;
    }
    if (!spoken(block)) return;
    begun = true;
    const kept = takes?.lines[block.id]?.kept;
    const source = kept && dramaTakePlays(block, kept, voice(block)) ? sources.get(kept.file) : undefined;
    const passageId = passageOf.get(block.id)!;
    if (!source) { previousPerformed = false; return; }
    const speaker = block.kind === "dialogue" ? block.speaker : DRAMA_NARRATOR;
    const lane = track(`voice:${speaker}`, block.kind === "dialogue" ? name(block.speaker) : "Narrator");
    const clip = newAudioClip(`line:${block.id}`, lane.id, source, source.samples);
    clip.label = block.words.slice(0, 200); clip.role = "speech"; clip.passageId = passageId;
    // Never before the broken line's own start (codex on PR 1879): a short take is cut in on less.
    const cutIn = block.kind === "dialogue" && block.overlapsPrevious && previousPerformed && gap === 0 && last !== null
      ? Math.min(audioSamples(DRAMA_CUT_IN_SEC), last.samples) : 0;
    clip.placement = { kind: "sequence", offset: gap - cutIn };
    state.clips.push(clip);
    if (first === null) first = { id: passageId, at: gap };
    clock += source.samples - cutIn;
    last = { id: passageId, samples: source.samples };
    previousPerformed = true;
    gap = 0;
  });
  cues[blocks.length] = here(); times[blocks.length] = clock;

  // A bed starts at its cue, wherever that falls, and an ambience runs to the block it stops before
  // or its scene's end (codex on PR 1879). A cue before the first line is placed from that line.
  const boundary = (cue: Cue) => "at" in cue
    ? first === null ? null : { passageId: first.id, edge: "start" as const, offset: cue.at - first.at }
    : cue;
  blocks.forEach((block, index) => {
    if (block.kind !== "ambience" && block.kind !== "music") return;
    const source = sourceOf(block.soundArtifact);
    if (!source) return;
    const ambience = block.kind === "ambience";
    // Either bed ends at the block it stops before, or its scene's end (codex on PR 1879).
    const sceneEnd = blocks.findIndex((candidate, at) => at > index && candidate.kind === "heading");
    const stop = block.until ? blocks.findIndex((candidate) => candidate.id === block.until) : -1;
    const end = stop > index ? stop : sceneEnd > index ? sceneEnd : blocks.length;
    const length = times[end]! - times[index]!;
    if (ambience && length <= 0) return;
    const cue = cues[index]!;
    const at = "at" in cue ? cue.at : 0;
    // Both boundaries are a line's, or neither is: before any line is performed, every cue is a time.
    const from = boundary(cue), to = boundary(cues[end]!);
    const lane = ambience ? track("ambience", "Ambience") : track("music", "Music");
    const clip = newAudioClip(`bed:${block.id}`, lane.id, source, source.samples);
    clip.label = block.heard.slice(0, 200); clip.role = "music"; clip.duckDb = 6;
    clip.gainDb = ambience ? -12 : -10;
    clip.loop = ambience;
    if (ambience || (length > 0 && source.samples > length)) {
      // Held to its range: an ambience looped through it, music cut at its end.
      if (from && to) clip.placement = { kind: "range", from, to };
      else {
        // No line to anchor to yet, a sound-only scene included (codex on PR 1879): its times hold it.
        clip.placement = { kind: "fixed", at };
        if (ambience) clip.loopDuration = length;
        else clip.sourceOut = length;
      }
    } else {
      clip.placement = from ? { kind: "passage", anchor: from } : { kind: "fixed", at };
    }
    state.clips.push(clip);
  });
  if (state.tracks.length === 0) track(`voice:${DRAMA_NARRATOR}`, "Narrator");
  return validateAudioArrangement(state);
}
