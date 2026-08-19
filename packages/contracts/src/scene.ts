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
    /**
     * An edited prompt, stored as an override, never a replacement (SPEC-012 R-15, D6): the
     * assembled form stays derivable, Reset stays possible, and the recorded sheet versions
     * are what make override staleness computable (R-16, D7).
     */
    promptOverride: z
      .object({
        text: z.string().min(1),
        /** Cited sheet versions at the moment of the edit. */
        sheetVersions: z.record(SlugSchema, z.number().int().min(1)),
      })
      .strict()
      .optional(),
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

/**
 * A storyboard drawn to be a *reference* (SPEC-019 R-22..R-25, R-27).
 *
 * Distinct from `board`, which compiles selected frames for review. This one is generated to be
 * read by a video model — line art, no text, capped panels — and it is production output, so it
 * lives beside the board rather than inside the authored record proper.
 */
export const SceneStoryboardSchema = z
  .object({
    /** Filename within the production's storyboard directory; doubles as its identity. */
    file: z.string().min(1),
    /**
     * The scene version the panels were drawn from (R-27). A board outlives the description it
     * was drawn from, and an edited shot beside an unredrawn panel is the contradiction R-24
     * exists to prevent — so the version travels with the board and staleness is computable.
     */
    sceneVersion: z.number().int().min(1),
    /** The shots this board actually covers, in order — the excess over the cap is not drawn. */
    panels: z.array(ShotIdSchema),
    drawnAt: IsoDateTimeSchema,
    /** The job that drew it, so its cost is findable in the ledger (R-25). */
    sourceJobId: z.string().min(1),
    /**
     * Accepted before it may steer a generation (R-25). Lands false: the accept gate is what
     * decides which images drive generation, and a board nobody looked at silently steering a
     * scene is that gate inverted.
     */
    accepted: z.boolean(),
    acceptedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type SceneStoryboard = z.infer<typeof SceneStoryboardSchema>;

export const SceneSchema = z
  .object({
    id: SceneIdSchema,
    /**
     * The scene's stable birth number — identity, not position (issue #387). It names the scene
     * ("Scene 4"), keys its board image, and joins cut entries to lanes; it is never rewritten,
     * so nothing that embeds it ever moves. Display and cut sequence come from `order`.
     */
    number: z.number().int().min(1),
    /**
     * Explicit display order (issue #387; SPEC-012 D3's rule applied to scenes): mutable,
     * rewritten by reorder alone. Read through `sceneOrderValue` — absent falls back to the
     * birth number, so legacy scenes sort exactly as they always did.
     */
    order: z.number().int().min(1).optional(),
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
    /** The reference storyboard drawn for this scene, when one has been (R-22). */
    storyboard: SceneStoryboardSchema.optional(),
    /**
     * The authoring skill this scene was drafted under (SPEC-019 R-19, R-21).
     *
     * Provenance, in the same spirit as a prompt override's recorded sheet versions: it explains
     * how the shots came to be written and is what R-21 compares against at dispatch, because
     * SPEC-008 R-21 lets any dispatch override the routed model — so a scene written for one
     * family can be sent to another without anything else noticing.
     *
     * Optional, and absent is an ordinary record rather than a missing one: a scene drafted by
     * hand, or under general guidance because the family ships no skill, simply has none.
     */
    draftedWith: z
      .object({
        skillId: z.string().min(1),
        version: z.number().int().min(1),
        family: z.string().min(1),
      })
      .strict()
      .optional(),
    shots: z.array(ShotSchema),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

/**
 * The one place a scene's effective order is read (issue #387): explicit `order` wins, the
 * stable birth `number` is the legacy fallback, and ties break by id so the sort is total and
 * deterministic everywhere it runs.
 */
export function sceneOrderValue(scene: Pick<Scene, "number" | "order">): number {
  return scene.order ?? scene.number;
}

/** Scenes in display/cut order — never by filename, never by mutating the input. */
export function sortScenes<T extends Pick<Scene, "number" | "order" | "id">>(scenes: readonly T[]): T[] {
  return [...scenes].sort(
    (a, b) => sceneOrderValue(a) - sceneOrderValue(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// Shot selection — productions/<p>/selections.json (§2.3.7). Operational, mutable.
// ---------------------------------------------------------------------------

export const ShotSelectionSchema = z
  .object({
    acceptedTakeId: TakeIdSchema.nullable().optional(),
    startFrameTakeId: TakeIdSchema.nullable().optional(),
    /**
     * Where this shot starts inside its selected media (#253). Operational selection state, not
     * an edit to the take: the take is immutable and this says which part of it is being used.
     * Changing the selected take resets it to 0 — a trim measured against different footage is
     * a number that means nothing, and silently keeping it would cut into the wrong frame.
     */
    trimInSec: z.number().min(0).default(0),
  })
  .strict();
export type ShotSelection = z.infer<typeof ShotSelectionSchema>;

export const SelectionsSchema = z.record(ShotIdSchema, ShotSelectionSchema);
export type Selections = z.infer<typeof SelectionsSchema>;
