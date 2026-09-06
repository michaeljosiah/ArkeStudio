import { ShotVisualFactsSchema } from "./shot-visual-facts.js";
import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, SceneIdSchema, Sha256Schema, ShotIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import { PropIdSchema, PropStateIdSchema } from "./prop.js";

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

/**
 * The Stage: where the camera is and how it moves, blocked out on a greybox previs in metres
 * and seconds (the scene workspace's Stage tab). Authored ON the shot because the camera move
 * is a shot decision — one owner, versioned with the scene, restorable with it — and every
 * number here is one the prompt can state.
 *
 * World metres, +Y up; a figure faces +Z until it walks. An anchored key's `p` and `l` are
 * OFFSETS from that subject rather than world positions, so lengthening a walk moves every
 * key with it and none has to be re-authored. Aim is its own channel: `track` follows a
 * subject live at height `l[1]`, which is how a camera swinging round a walking figure keeps
 * them centred without a key per step.
 *
 * Nothing here is required beyond identity: this is the read path, and a `.min()` on the key
 * list would delete a hand-edited scene from a world on disk.
 */
export const StagingKeySchema = z
  .object({
    /** Seconds from the shot's start. */
    t: z.number().min(0),
    /** Camera position — world metres, or an offset from `anchor`. */
    p: z.tuple([z.number(), z.number(), z.number()]),
    /** Where the lens points — world metres, or an offset from `anchor`. */
    l: z.tuple([z.number(), z.number(), z.number()]),
    anchorSpace: z.enum(["world", "local"]).optional(),
    roll: z.number().finite().min(-180).max(180).optional(),
    focalMm: z.number().finite().positive().max(1000).optional(),
    /** The cast sheet the position rides with. */
    anchor: SlugSchema.optional(),
    /** The cast sheet the aim follows live. */
    track: SlugSchema.optional(),
    /** Fraction of the incoming leg spent decelerating into this mark. */
    easeIn: z.number().min(0).max(1).optional(),
    /** Fraction of the outgoing leg spent accelerating away from this mark. */
    easeOut: z.number().min(0).max(1).optional(),
  })
  .strict();
export type StagingKey = z.infer<typeof StagingKeySchema>;

export const StagingFigureSchema = z
  .object({
    sheetId: SlugSchema,
    x: z.number(),
    z: z.number(),
    parent: SlugSchema.optional(),
    facing: z.number().finite().optional(),
    y: z.number().finite().optional(),
    height: z.number().finite().positive().max(20).optional(),
    /** Static greybox posture; absent is standing. */
    pose: z.enum(["sit", "lie"]).optional(),
    /** Where the figure ends the shot; absent holds still. */
    to: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict()
  .superRefine((figure, context) => {
    if (figure.pose !== undefined && figure.to !== undefined) {
      context.addIssue({ code: "custom", message: "a seated or lying figure cannot also walk" });
    }
  });
export type StagingFigure = z.infer<typeof StagingFigureSchema>;

/** Set massing: a translucent box, named so the label reads on the floor. */
export const StagingSetSchema = z
  .object({
    name: z.string().min(1),
    shape: z.enum(["box", "sphere", "cylinder", "mesh"]).optional(),
    group: SlugSchema.optional(),
    vertices: z.array(z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])).min(3).max(2048).optional(),
    triangles: z.array(z.number().int().nonnegative()).min(3).max(12288).optional(),
    y: z.number().finite().optional(),
    rotation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
    solid: z.boolean().optional(),
    x: z.number(),
    z: z.number(),
    w: z.number(),
    h: z.number(),
    d: z.number(),
  })
  .strict();
export type StagingSet = z.infer<typeof StagingSetSchema>;

/** Cast marks and set massing shared by every camera that covers this scene action. */
export const SceneBlockingSchema = z
  .object({
    version: z.number().int().min(1),
    cast: z.array(StagingFigureSchema),
    sets: z.array(StagingSetSchema),
  })
  .strict();
export type SceneBlocking = z.infer<typeof SceneBlockingSchema>;

export const StageRigSchema = z.enum(["sticks", "dolly", "steadicam", "handheld", "crane", "drone", "car-mount"]);
export type StageRig = z.infer<typeof StageRigSchema>;

export const StagePerformanceKeySchema = z.object({
  t: z.number().finite().nonnegative(), x: z.number().finite(), z: z.number().finite(),
  y: z.number().finite().optional(), facing: z.number().finite().optional(),
  pose: z.enum(["stand", "sit", "lie"]).optional(),
}).strict();
export type StagePerformanceKey = z.infer<typeof StagePerformanceKeySchema>;
export const StagePerformanceSchema = z.object({
  sheetId: SlugSchema, keys: z.array(StagePerformanceKeySchema).min(1).max(120),
}).strict();
export type StagePerformance = z.infer<typeof StagePerformanceSchema>;
export const StageObjectMotionSchema = z.object({
  group: SlugSchema,
  keys: z.array(z.object({ t: z.number().finite().nonnegative(), p: z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]), rotation: z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]).optional(), easeIn: z.number().min(0).max(1).optional(), easeOut: z.number().min(0).max(1).optional() }).strict()).min(1).max(120),
}).strict();
export type StageObjectMotion = z.infer<typeof StageObjectMotionSchema>;
export const StageAuthorshipSchema = z.object({
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  instruction: z.string().max(4000).optional(),
  model: z.string().min(1), sourceVersion: z.number().int().positive(),
  assumptions: z.array(z.string().max(1000)).max(20),
  assessment: z.string().max(4000), inspectedFrames: z.number().int().nonnegative().max(24),
}).strict();

const ShotRigShape = {
  objectMotions: z.array(StageObjectMotionSchema).max(30).optional(),
  performances: z.array(StagePerformanceSchema).max(30).optional(),
  authorship: StageAuthorshipSchema.optional(),
  rig: StageRigSchema.optional(),
  seed: z.number().int().min(0).optional(),
  rigIntensity: z.number().min(0).max(2).optional(),
};

const ShotBlockingOverrideShape = {
  /** Present together only when this shot deliberately overrides the scene blocking. */
  cast: z.array(StagingFigureSchema).optional(),
  sets: z.array(StagingSetSchema).optional(),
};

/** The editable half of shot staging; versions and output pins are coordinator-owned. */
export const ShotStageEditSchema = z
  .object({ ...ShotBlockingOverrideShape, ...ShotRigShape, keys: z.array(StagingKeySchema) })
  .strict()
  .superRefine((value, context) => {
    if ((value.cast === undefined) !== (value.sets === undefined)) {
      context.addIssue({ code: "custom", message: "cast and sets must both be present for a shot blocking override" });
    }
  });
export type ShotStageEdit = z.infer<typeof ShotStageEditSchema>;

export const ShotStagingSchema = z
  .object({
    /** Counted up on every Keep, so a filed playblast can say which staging it was rendered from. */
    version: z.number().int().min(1),
    ...ShotBlockingOverrideShape,
    ...ShotRigShape,
    keys: z.array(StagingKeySchema),
    /**
      * The playblast and opening frame filed from this staging, and what they were rendered from:
      * the staging version and the shot length, lens and aspect. A pin that disagrees with any of
      * them is stale — the files still exist, they just no longer show this shot.
     */
    playblast: z
      .object({
        sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        artifactId: ArtifactIdSchema,
        openingFrameArtifactId: ArtifactIdSchema.optional(),
        version: z.number().int().min(1),
        durationSec: z.number().positive().optional(),
        aspect: z.string().min(1).optional(),
        lens: z.string().optional(),
        rig: StageRigSchema.optional(),
        seed: z.number().int().min(0).optional(),
        rigIntensity: z.number().min(0).max(2).optional(),
        /** Absent on legacy shot-owned pins; inherited pins name the shared block they depict. */
        blocking: z.discriminatedUnion("owner", [
          z.object({ owner: z.literal("scene"), version: z.number().int().min(1).nullable() }).strict(),
          z.object({ owner: z.literal("shot") }).strict(),
        ]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.cast === undefined) !== (value.sets === undefined)) {
      context.addIssue({ code: "custom", message: "cast and sets must both be present for a shot blocking override" });
    }
  });
export type ShotStaging = z.infer<typeof ShotStagingSchema>;

export const ShotSchema = z
  .object({
    visualFacts: ShotVisualFactsSchema.optional(),
    id: ShotIdSchema,
    number: z.number().int().min(1),
    title: z.string().min(1),
    /** `@slug` tokens are live sheet references, resolved at prompt assembly (§2.3.4). */
    description: z.string(),
    camera: z.string().optional(),
    audio: ShotAudioSchema.optional(),
    durationSec: z.number().positive().optional(),
    /** Turn 97 (14d): how it should feel. The prompt asks the model to infer only unset camera choices. */
    intent: z.string().optional(),
    /** Turn 97 (14d): timing beats — `span` is a label ("0–3s"), not a machine timeline. */
    beats: z
      .array(z.object({ span: z.string().min(1), text: z.string().min(1) }).strict())
      .optional(),
    /** Turn 97 (14d): the structured camera. A present field overrides the scene's `defaults`. */
    framing: ShotFramingSchema.optional(),
    /** The blocked-out camera move and cast positions (the Stage), where the shot has been staged. */
    staging: ShotStagingSchema.optional(),
    /**
     * The prop states this shot cites (design turn 105, `stateOwner: shot-or-dispatch`; issue
     * 536). The shot's own control is the one durable value: what it stores is what the next
     * dispatch reads, and the first shot whose entry changes IS the transition. A cited prop with
     * no entry resolves as unresolved — never the previous shot's state, never a guess.
     */
    propStates: z.array(z.object({ propId: PropIdSchema, stateId: PropStateIdSchema }).strict()).optional(),
    /**
     * Turn 97 (14d): continuity said plainly. `openOnPrevious` is issue 154's boundary frame as
     * an authored decision, and since issue 851 it is the decision: accepting a take still cuts
     * the still and files it onto the next shot, but the dispatch opens on it only where the
     * shot asked. Default off (SPEC-019 R-50's reasoning — most cuts are cuts), because a frame
     * displaces the cast sheets on every reference-capable route, and an unopposed run of
     * accepts otherwise walks a recurring face off its own reference a shot at a time. A frame
     * the shot was given rather than chained onto it is unaffected (SPEC-036 R-20).
     *
     * `keepOut` is the negative half of the same promise.
     */
    continuity: z
      .object({
        openOnPrevious: z.boolean().optional(),
        keepOut: z.string().optional(),
        /**
         * This shot extends the predecessor's footage rather than opening on a still cut out of
         * it (SPEC-019 R-50, T-31). The stronger form of `openOnPrevious` and deliberately its
         * neighbour: a frame keeps the composition and loses the motion, the momentum and the
         * audio running underneath, which is the whole reason continuation exists.
         *
         * Opt-in per shot, never a default (R-50). Most cuts are cuts — consecutive shots are
         * usually discontinuous, and extending across one fights the edit rather than serving
         * it. Declaring it is not the same as getting it: where the predecessor has no accepted
         * take, or its take was itself continued, the plan names the refusal (R-51, R-52).
         */
        continuesPrevious: z.boolean().optional(),
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

/**
 * Every scene field except its structural authority — the shared half of SPEC-029 R-1's
 * two-arm read union. `SceneSchema` below closes it with legacy `shots[]`; `GraphSceneSchema`
 * (scene-flow.ts) closes it with `flow`. One shape object, two schemas: the arms cannot drift,
 * because apart from the structural field there is nothing to drift — every other field keeps
 * its identity, owner, optionality, and meaning in both.
 */
export const SceneBaseShape = {
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
    /** The action and set shared by the scene's cameras; a shot may carry a complete override. */
    blocking: SceneBlockingSchema.optional(),
    /**
     * The authored board overrides (SPEC-035 R-4).
     *
     * Boards themselves are derived and never stored — packed live from the model's cap and
     * the continuity of the shots. What a person authors is only this: a **split** forcing a
     * board to begin at a shot, a **merge** suppressing the automatic break that would begin
     * one, and the consolidated prompt they have edited for a board.
     *
     * Keyed by shot id, never by ordinal, so reordering shots cannot silently move a seam.
     * An id naming no current shot is dropped where it is read rather than refused: shots are
     * deleted without ceremony, and a stale override is a no-op, not a broken scene.
     *
     * `splits` and `merges` are disjoint — a boundary cannot be both forced and suppressed —
     * and the writer keeps them so. A legacy record carrying an id in both reads as a split
     * with the merge dropped, because a dormant merge that wakes when a split is later cleared
     * would be a seam nobody chose.
     *
     * `prompts` key by the board's frozen member set, the only identity stable across a
     * repack: letters renumber and membership moves, so an entry whose members no longer match
     * a packed board is dropped at read and the prompt visibly returns to `auto` rather than
     * silently attaching to different shots.
     *
     * Optional, and absent means empty — this schema is a read path, and every scene ever
     * written parses unchanged.
     */
    boards: z
      .object({
        splits: z.array(ShotIdSchema),
        merges: z.array(ShotIdSchema),
        prompts: z
          .array(z.object({ members: z.array(ShotIdSchema).min(1), text: z.string().min(1) }).strict())
          .optional(),
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
        /*
         * The models the skill was written for, when it named any (2026-08-23).
         *
         * The family alone answered the question while a family had one document. Now that a
         * skill can narrow — Seedance 2.5's guidance is about thirty-second sequences, 2.0's is
         * not — a scene drafted under the narrow one and sent to 2.0 matches on family and
         * mismatches on everything that matters. Optional and additive: this schema is a read
         * path, and every scene written before today parses unchanged.
         */
        models: z.array(z.string().min(1)).optional(),
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
} as const;

/**
 * The legacy arm of SPEC-029 R-1's read union: `shots[]` owns both payload and order. Still
 * the only shape any writer produces and the shape every consumer reads — rollout step 3
 * (SPEC-029 §3.3) swaps the read path to `SceneRecordSchema` (scene-flow.ts) and moves ordered
 * consumers onto `linearizeSceneFlow`; until then this name keeps its historical meaning.
 */
export const SceneSchema = z.object({ ...SceneBaseShape, shots: z.array(ShotSchema) }).strict();
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

/**
 * Does this shot open on a picture it was given, rather than one chained onto it (SPEC-036 R-20)?
 *
 * The frame slot answers one question — what this shot opens on — and two things write it. A
 * frame run, or a still accepted by hand, files *this shot's own* picture there. The continuity
 * chain files the *previous* shot's boundary still there when its take is accepted, so a cut
 * can open where the last one ended.
 *
 * The author's own frame outranks the automatic seed, and that is what this predicate is for.
 * Without it, drawing every shot and then accepting takes one by one would silently replace
 * each following shot's drawn frame — the app quietly overruling a picture somebody chose,
 * exactly where the point of drawing first was to choose it. A shot that genuinely wants the
 * predecessor's footage says so with `continuity.continuesPrevious` (SPEC-019 R-50); it does
 * not arrive there through an accept it never asked for.
 *
 * Told apart by provenance already on the sidecar, never by a new flag: a boundary still
 * carries `boundaryExtraction` naming the take it was cut from, and a drawn frame does not.
 * Nothing stored can disagree with where the picture came from.
 */
/**
 * What a shot IS, in one word (SPEC-036 R-7, §2.5).
 *
 * Five states, derived and never stored: `needs attention` (nothing written to generate from),
 * `rendered` (a clip exists), `story` (written, unframed — a legitimate state and not an error),
 * `storyboard` (framed, but the script has moved on), `production-ready`. The precedence is
 * exhaustive and the order matters, so every surface that shows a chip — rows, completion, the
 * episode rollup — answers from this one function rather than inventing its own reading.
 *
 * `hasFrame` is deliberately the DISPATCHABLE question and not "is there a picture somewhere":
 * only a pinned image artifact resolves, because that is what the frame route can send. A
 * `startFrameTakeId` is continuity steering, not this shot's own frame, and offering
 * `production-ready` over something the dispatch cannot carry is the lie this exists to stop.
 *
 * A run failure never appears here: a failed attempt does not change what a shot HAS, so it
 * lives on the run strip and the report card instead.
 */
export type ShotCardState = "needs attention" | "story" | "storyboard" | "production-ready" | "rendered";

export function shotCardState(input: {
  blankScript: boolean;
  clipAccepted: boolean;
  hasFrame: boolean;
  coverage: ShotCoverage;
}): ShotCardState {
  if (input.blankScript) return "needs attention";
  if (input.clipAccepted) return "rendered";
  if (!input.hasFrame) return "story";
  if (input.coverage !== "fresh") return "storyboard";
  return "production-ready";
}

export function hasOwnFrame(
  selection: ShotSelection | undefined,
  artifacts: readonly { id: string; kind: string; boundaryExtraction?: unknown; supersedes?: string }[],
): boolean {
  const artifactId = selection?.startFrameArtifactId ?? null;
  if (artifactId === null) return false;
  const artifact = artifacts.find((candidate) => candidate.id === artifactId);
  return (
    artifact !== undefined &&
    artifact.kind === "image" &&
    artifact.boundaryExtraction === undefined &&
    !artifacts.some((candidate) => candidate.supersedes === artifactId)
  );
}

/** One authored fallback for planning, pricing, picture slots and display. */
export const DEFAULT_SHOT_SEC = 4;
export function resolvedAuthoredDuration(shot: { durationSec?: number }): number {
  return shot.durationSec ?? DEFAULT_SHOT_SEC;
}
