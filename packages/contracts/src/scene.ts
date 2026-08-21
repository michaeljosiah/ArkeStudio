import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, SceneIdSchema, Sha256Schema, ShotIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";

/**
 * A scene-script block (SPEC-023 R-13): the smallest stable thing a shot can cite. Block ids
 * survive edits and reorders; a shot cites the digest of the text it covered, so staleness is a
 * pure derivation and no stored flag can lie.
 */
export const ScriptBlockSchema = z
  .object({
    id: z.string().regex(/^blk_[a-z0-9-]+$/, "expected blk_<slug>"),
    kind: z.enum(["action", "dialogue"]),
    /** Dialogue names its speaker by sheet slug; action has none. */
    speaker: SlugSchema.optional(),
    text: z.string().min(1),
  })
  .strict();
export type ScriptBlock = z.infer<typeof ScriptBlockSchema>;

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
    /** Turn 97 (14d, Sound): the bed under the line and the hits beside it. Free text, optional. */
    ambience: z.string().optional(),
    effects: z.string().optional(),
  })
  .strict();
export type ShotAudio = z.infer<typeof ShotAudioSchema>;

/**
 * The structured camera (turn 97, 14d). One shape serves two places: a scene's `defaults`,
 * which every shot inherits, and a shot's `framing`, where a present field IS the override —
 * absence inherits, so no stored flag can disagree with the value (the covers-digest rule
 * applied to camera). Values are display vocabulary (SPEC-012 owns the words); the shape only
 * says they are strings, so a new size or movement never needs a schema change. Every field
 * optional and the object itself optional: a scene written before turn 97 parses unchanged —
 * this schema is the read path, and a `.min()` here deletes scenes from worlds on disk.
 */
export const ShotFramingSchema = z
  .object({
    size: z.string().optional(),
    angle: z.string().optional(),
    lens: z.string().optional(),
    focus: z.string().optional(),
    movement: z.string().optional(),
    pace: z.string().optional(),
    lighting: z.string().optional(),
    timeOfDay: z.string().optional(),
    /** grade & texture — one free-text line, not a taxonomy. */
    grade: z.string().optional(),
  })
  .strict();
export type ShotFraming = z.infer<typeof ShotFramingSchema>;

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
    /** Turn 97 (14d): how it should feel. The camera is inferred from this; hand settings win. */
    intent: z.string().optional(),
    /** Turn 97 (14d): timing beats — `span` is a label ("0–3s"), not a machine timeline. */
    beats: z
      .array(z.object({ span: z.string().min(1), text: z.string().min(1) }).strict())
      .optional(),
    /** Turn 97 (14d): the structured camera. A present field overrides the scene's `defaults`. */
    framing: ShotFramingSchema.optional(),
    /**
     * Turn 97 (14d): continuity said plainly. `openOnPrevious` is issue 154's boundary frame as
     * an authored intent — the dispatch already chains when a boundary still exists; this records
     * that the shot *wants* it. `keepOut` is the negative half of the same promise.
     */
    continuity: z
      .object({
        openOnPrevious: z.boolean().optional(),
        keepOut: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Script coverage (SPEC-023 R-13): the block ids this shot covers, each with the sha256 of
     * the block text at citation time. A digest mismatch derives "covers text that changed"; a
     * missing block derives "covers nothing" — derived, never stored as status.
     */
    covers: z
      .array(z.object({ blockId: z.string().min(1), textDigest: Sha256Schema }).strict())
      .optional(),
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
    /**
     * The delivery aspect the panels were drawn at (issue 389). Absent means drawn before
     * aspect reached storyboards — which was always landscape, so staleness against a vertical
     * production is computable for those boards too.
     */
    aspect: z.string().min(1).optional(),
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
    /** Turn 97 (14c): the line under the title — edited on the page, read by prompt assembly. */
    synopsis: z.string().optional(),
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
    /** Turn 97 (14d): camera defaults every shot inherits — a shot's `framing` field wins. */
    defaults: ShotFramingSchema.optional(),
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
    /**
     * The scene script (SPEC-023 R-13): ordered blocks with stable ids that shots cite by
     * digest. Optional — a script-less scene is an ordinary scene, and the board still works.
     */
    script: z
      .object({
        blocks: z.array(ScriptBlockSchema),
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

/**
 * The camera a shot actually shoots with (turn 97, 14d): its own `framing` over the scene's
 * `defaults`, field by field. A field present on the shot is an override by definition —
 * presence is the flag, so the answer can never disagree with the data.
 */
export function effectiveFraming(
  scene: Pick<Scene, "defaults">,
  shot: Pick<Shot, "framing">,
): ShotFraming {
  return { ...scene.defaults, ...shot.framing };
}

/**
 * Script coverage, derived (SPEC-023 R-13; turn 97's `Re-read` chip reads this).
 *
 * `digests` maps block id → `sha256:<hex>` of the block's current text. Stored digests may be
 * truncated (Sha256Schema allows 8–64 hex chars), so comparison is prefix-based on the shorter
 * of the two. Derived every time, stored nowhere — no flag can lie.
 */
export type ShotCoverage = "unlinked" | "fresh" | "changed" | "uncovered";

export function shotCoverage(
  shot: Pick<Shot, "covers">,
  digests: ReadonlyMap<string, string>,
): ShotCoverage {
  if (!shot.covers || shot.covers.length === 0) return "unlinked";
  let changed = false;
  for (const cover of shot.covers) {
    const current = digests.get(cover.blockId);
    // The cited block no longer exists: the shot covers nothing (R-13's second derivation).
    if (current === undefined) return "uncovered";
    const a = cover.textDigest.replace(/^sha256:/, "");
    const b = current.replace(/^sha256:/, "");
    const n = Math.min(a.length, b.length);
    if (n === 0 || a.slice(0, n) !== b.slice(0, n)) changed = true;
  }
  return changed ? "changed" : "fresh";
}

// ---------------------------------------------------------------------------
// Shot selection — productions/<p>/selections.json (§2.3.7). Operational, mutable.
// ---------------------------------------------------------------------------

export const ShotSelectionSchema = z
  .object({
    acceptedTakeId: TakeIdSchema.nullable().optional(),
    startFrameTakeId: TakeIdSchema.nullable().optional(),
    /**
     * The durable boundary still this shot opens on (issue 154): an image artifact cut from the
     * previous shot's accepted footage, with its own bytes, hash and extraction provenance.
     * `startFrameTakeId` above names footage and can only steer; this names a picture the
     * dispatch can actually send. Optional and nullable so every selections.json written before
     * boundary frames existed parses unchanged.
     */
    startFrameArtifactId: ArtifactIdSchema.nullable().optional(),
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
