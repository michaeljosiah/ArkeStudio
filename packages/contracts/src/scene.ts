import { z } from "zod";
import { IsoDateTimeSchema, SceneIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";

/**
 * Scenes and shots (master spec §2.3.4, §9).
 *
 * A scene file is authored structure only. Which take a shot currently uses is operational
 * state and lives in `selections.json`, never in the scene file (§2.3.7) — the §2.3.4 example
 * predates that correction. Putting selection inside the scene would make accepting a take
 * mutate a gated entity.
 */

export const ShotAudioSchema = z
  .object({
    /** "vo" | "dialogue" | "sfx" | "silence" — display vocabulary owned by SPEC-012. */
    kind: z.string().min(1),
    speaker: SlugSchema.optional(),
    line: z.string().optional(),
  })
  .strict();
export type ShotAudio = z.infer<typeof ShotAudioSchema>;

export const ShotSchema = z
  .object({
    id: ShotIdSchema,
    number: z.number().int().min(1),
    title: z.string().min(1),
    /** `@slug` tokens are live sheet references, resolved at prompt assembly (§2.3.4). */
    description: z.string(),
    camera: z.string().optional(),
    audio: ShotAudioSchema.optional(),
    durationSec: z.number().positive().optional(),
  })
  .strict();
export type Shot = z.infer<typeof ShotSchema>;

export const SceneBoardSchema = z
  .object({
    version: z.number().int().min(1),
    compiledAt: IsoDateTimeSchema,
    image: z.string().min(1),
  })
  .strict();
export type SceneBoard = z.infer<typeof SceneBoardSchema>;

export const SceneSchema = z
  .object({
    id: SceneIdSchema,
    number: z.number().int().min(1),
    slug: SlugSchema,
    title: z.string().min(1),
    /** Scene lifecycle vocabulary is owned by SPEC-012; the shape validates, the value displays. */
    status: z.string().min(1),
    /** Scenes are cited (shots inherit, boards compile from them) so they are versioned (§2.4.1). */
    version: z.number().int().min(1),
    inherits: z
      .object({
        location: SlugSchema.optional(),
        timeOfDay: z.string().optional(),
        tone: z.string().optional(),
      })
      .strict()
      .optional(),
    board: SceneBoardSchema.optional(),
    shots: z.array(ShotSchema),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

// ---------------------------------------------------------------------------
// Shot selection — productions/<p>/selections.json (§2.3.7). Operational, mutable.
// ---------------------------------------------------------------------------

export const ShotSelectionSchema = z
  .object({
    acceptedTakeId: TakeIdSchema.nullable().optional(),
    startFrameTakeId: TakeIdSchema.nullable().optional(),
  })
  .strict();
export type ShotSelection = z.infer<typeof ShotSelectionSchema>;

export const SelectionsSchema = z.record(ShotIdSchema, ShotSelectionSchema);
export type Selections = z.infer<typeof SelectionsSchema>;
