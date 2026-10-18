import { z } from "zod";
import { SlugSchema, UlidSchema } from "./ids.js";

/**
 * The audio drama (SPEC-057, design turn 230): a Story production of its own kind, adapted for the
 * ear. Its episodes are scripts, not video seasons, so nothing here touches `season.json`, Series
 * or scene records; what setup decides lives in `productions/<id>/audio-drama.json`.
 */
export const AUDIO_DRAMA_KIND = "audio-drama";

/**
 * Whether a narrator guides the listener (SPEC-057 R-6, D-3) — the one question setup asks. It is
 * the default for each new scene's Heard as; `a-recording` is only ever set per scene.
 */
export const AudioDramaNarratorSchema = z.enum(["narrated", "in-the-room"]);
export type AudioDramaNarrator = z.infer<typeof AudioDramaNarratorSchema>;

/** A fact the drama must not give away before an episode (SPEC-057 R-8). */
export const KeptFromListenerSchema = z.object({
  fact: z.string().trim().min(1).max(240),
  revealEpisode: z.number().int().min(1).max(200),
}).strict();
export type KeptFromListener = z.infer<typeof KeptFromListenerSchema>;

/** The scene written first, before every episode is planned (SPEC-057 R-9, D-4). */
export const AudioDramaPilotSchema = z.object({
  title: z.string().trim().min(1).max(160),
  /** The source chapters, by number, the pilot is adapted from. */
  // Each chapter once: a repeat would have later pilot work read the same chapter twice.
  chapters: z.array(z.number().int().min(1).max(2000)).max(20)
    .refine(chapters => new Set(chapters).size === chapters.length, { message: "A pilot names each chapter once." }).default([]),
}).strict();
export type AudioDramaPilot = z.infer<typeof AudioDramaPilotSchema>;

/**
 * Setup's one plan (SPEC-057 R-7): proposed by Arke after reading the source and accepted or
 * changed whole. Episodes and minutes are targets, never limits (D-2).
 */
export const AudioDramaPlanSchema = z.object({
  episodes: z.number().int().min(1).max(200),
  minutes: z.number().int().min(1).max(180),
  narrator: AudioDramaNarratorSchema.optional(),
  keptFromListener: z.array(KeptFromListenerSchema).max(50).default([]),
  pilot: AudioDramaPilotSchema.optional(),
}).strict().superRefine((plan, ctx) => {
  // A fact withheld until an episode the plan does not have is never revealed (codex on PR 1866),
  // so lowering the count past a reveal is refused rather than silently dropping the secret.
  plan.keptFromListener.forEach((kept, index) => {
    if (kept.revealEpisode > plan.episodes) ctx.addIssue({
      code: "custom", path: ["keptFromListener", index, "revealEpisode"],
      message: `“${kept.fact}” is revealed in episode ${kept.revealEpisode}, but the plan has ${plan.episodes}. Reveal it in one of them, or plan more episodes.`,
    });
  });
});
export type AudioDramaPlan = z.infer<typeof AudioDramaPlanSchema>;

/** Where the plan starts before Arke has read anything, or with nothing to read (D-2). */
export const DEFAULT_AUDIO_DRAMA_PLAN: AudioDramaPlan = { episodes: 6, minutes: 25, keptFromListener: [] };

/** `productions/<id>/audio-drama.json`: the plan, and the story it adapts when it adapts one. */
export const AudioDramaRecordSchema = z.object({
  version: z.literal(1),
  plan: AudioDramaPlanSchema,
  source: z.object({ productionId: SlugSchema }).strict().optional(),
}).strict();
export type AudioDramaRecord = z.infer<typeof AudioDramaRecordSchema>;

// ---------------------------------------------------------------------------
// The episode script (SPEC-057 R-11..R-24, design turn 230d–f): one versioned document per
// episode, `productions/<id>/scripts/episode-<NN>.json`. Scenes are headings inside it, so a bed or
// a sting can run across a scene change without a second document to cross.
// ---------------------------------------------------------------------------

/** How a scene reaches the listener (D-3): set per scene; the plan's narrator is the default. */
export const HeardAsSchema = z.enum(["narrated", "in-the-room", "recording"]);
export type HeardAs = z.infer<typeof HeardAsSchema>;

/** Where a voice is heard from, under the speaker's name (230e): never a line of its words. */
export const ScriptChannelSchema = z.enum(["off-mic", "radio", "recording"]);
export type ScriptChannel = z.infer<typeof ScriptChannelSchema>;

const Words = z.string().max(4_000);
const Direction = z.string().trim().max(240).optional();
/** Source paragraphs, by their number in the pinned chapter version (1-based), never by text. */
const Paragraphs = z.array(z.number().int().min(1).max(100_000)).max(200).optional();

/** A scene's heading: what it adapts is pinned to one version of one chapter (R-20, R-84). */
export const ScriptHeadingSchema = z.object({
  id: UlidSchema, kind: z.literal("heading"),
  place: z.string().trim().min(1).max(160),
  time: z.string().trim().max(80).optional(),
  heardAs: HeardAsSchema.optional(),
  source: z.object({
    story: SlugSchema,
    chapter: z.string().min(1).max(200),
    version: z.number().int().min(1),
    paragraphs: Paragraphs,
  }).strict().optional(),
  estimateSec: z.number().int().min(0).max(36_000).optional(),
}).strict();

/**
 * A line someone says. `direction` is how, never what: it sits above the words and is never part of
 * them (R-13). `cut` marks a line broken off by the next one, which must say `overlapsPrevious`: an
 * interruption is a stored relation, not a dash in the text (R-18).
 */
export const ScriptDialogueSchema = z.object({
  id: UlidSchema, kind: z.literal("dialogue"),
  speaker: SlugSchema,
  words: Words,
  direction: Direction,
  channel: ScriptChannelSchema.optional(),
  cut: z.boolean().optional(),
  overlapsPrevious: z.boolean().optional(),
  paragraphs: Paragraphs,
}).strict();

export const ScriptNarrationSchema = z.object({
  id: UlidSchema, kind: z.literal("narration"),
  words: Words,
  direction: Direction,
  paragraphs: Paragraphs,
}).strict();

/**
 * A sound, an ambience or music (R-38). `heard` is what the listener hears, in the script's words;
 * the artifact is the sound placed for it, once one exists. A bed (ambience, music) runs from its
 * row down to `until` — the block it stops before — or to the end of its scene.
 */
export const ScriptCueSchema = z.object({
  id: UlidSchema, kind: z.enum(["sound", "ambience", "music"]),
  heard: z.string().trim().min(1).max(600),
  purpose: z.string().trim().max(240).optional(),
  required: z.boolean().optional(),
  soundArtifact: z.string().min(1).max(200).optional(),
  until: UlidSchema.optional(),
  paragraphs: Paragraphs,
}).strict();

/** A measured gap: silence is authored, with its length (R-16). */
export const ScriptSilenceSchema = z.object({
  id: UlidSchema, kind: z.literal("silence"),
  seconds: z.number().min(0.1).max(120),
  note: z.string().trim().max(240).optional(),
}).strict();

/** A production note: read by the author, never performed. */
export const ScriptNoteSchema = z.object({
  id: UlidSchema, kind: z.literal("note"),
  text: z.string().trim().min(1).max(2_000),
}).strict();

export const EpisodeScriptBlockSchema = z.discriminatedUnion("kind", [
  ScriptHeadingSchema, ScriptDialogueSchema, ScriptNarrationSchema, ScriptCueSchema, ScriptSilenceSchema, ScriptNoteSchema,
]);
export type EpisodeScriptBlock = z.infer<typeof EpisodeScriptBlockSchema>;
export type ScriptHeading = z.infer<typeof ScriptHeadingSchema>;
export type ScriptDialogue = z.infer<typeof ScriptDialogueSchema>;
export type ScriptCue = z.infer<typeof ScriptCueSchema>;

/** The relations a script must keep whole, whoever wrote it (R-18, R-24). */
export function episodeScriptProblems(blocks: readonly EpisodeScriptBlock[]): string[] {
  const problems: string[] = [];
  const index = new Map<string, number>();
  blocks.forEach((block, i) => {
    if (index.has(block.id)) problems.push(`Block ${block.id} appears twice.`);
    index.set(block.id, i);
  });
  blocks.forEach((block, i) => {
    if (block.kind === "dialogue" && block.cut) {
      const next = blocks[i + 1];
      if (next?.kind !== "dialogue" || !next.overlapsPrevious) problems.push(`A line broken off (${block.id}) must be followed by the line that breaks in.`);
    }
    if (block.kind === "dialogue" && block.overlapsPrevious) {
      // Both sides of the relation (codex on PR 1870): the line above must be the one broken off.
      const previous = blocks[i - 1];
      if (previous?.kind !== "dialogue" || !previous.cut) problems.push(`A line that breaks in (${block.id}) must follow the line it breaks off.`);
    }
    if ((block.kind === "ambience" || block.kind === "music") && block.until !== undefined) {
      const at = index.get(block.until);
      if (at === undefined || at <= i) problems.push(`A bed (${block.id}) stops before a block that is not below it.`);
    }
    if (block.kind === "sound" && block.until !== undefined) problems.push(`A sound (${block.id}) is a moment, not a bed: it has no until.`);
  });
  return problems;
}

export const EpisodeScriptSchema = z.object({
  version: z.number().int().min(1),
  episode: z.number().int().min(1).max(200),
  title: z.string().trim().max(160).default(""),
  blocks: z.array(EpisodeScriptBlockSchema).max(4_000),
}).strict().superRefine((script, ctx) => {
  for (const message of episodeScriptProblems(script.blocks)) ctx.addIssue({ code: "custom", path: ["blocks"], message });
});
export type EpisodeScript = z.infer<typeof EpisodeScriptSchema>;

/** Where episode `n`'s script lives: three digits keep every allowed episode in order (codex on PR 1870). */
export function episodeScriptFile(episode: number): string {
  return `episode-${String(episode).padStart(3, "0")}.json`;
}

/**
 * What a script is heard for, roughly: spoken words at about 2.6 a second, plus silence and a
 * second for each sound. An estimate to steer by (the listening ring), never a measurement.
 */
export function estimateScriptSeconds(blocks: readonly EpisodeScriptBlock[]): number {
  let seconds = 0;
  for (const block of blocks) {
    if (block.kind === "dialogue" || block.kind === "narration") seconds += block.words.trim().split(/\s+/).filter(Boolean).length / 2.6;
    else if (block.kind === "silence") seconds += block.seconds;
    else if (block.kind === "sound") seconds += 1;
  }
  return Math.round(seconds);
}
