import { z } from "zod";
import { SlugSchema } from "./ids.js";

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
