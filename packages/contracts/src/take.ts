import { DialogueDispatchAssessmentSchema } from "./dialogue-assessment.js";
import { AudioAssetProvenanceSchema } from "./audio.js";
import { z } from "zod";
import { PropIdSchema, PropStateIdSchema, PropStateProvenanceSchema } from "./prop.js";
import {
  IsoDateTimeSchema,
  JobIdSchema,
  PassIdSchema,
  SceneIdSchema,
  ShotIdSchema,
  SlugSchema,
  TakeIdSchema,
} from "./ids.js";

/**
 * Takes and review (master spec §2.3.5–§2.3.7).
 *
 * A take is an immutable generation record with no status field: what the provider produced
 * (take.json, write-once), what a human decided (reviews.jsonl, append-only) and what the cut
 * uses (selections.json, mutable) are three different things and live in three places.
 */

export const TakeKindSchema = z.enum([
  "clip",
  "frame",
  "still",
  "voice",
  "main-photo",
  "sheet",
  "look",
  /** One accepted angle on a location (#243) — an immutable take, like a main photo. */
  "location-view",
  /** One accepted reference for a prop state (design turn 105; issue 535). */
  "prop-state",
]);
export type TakeKind = z.infer<typeof TakeKindSchema>;

/**
 * Where an actual cost figure came from (SPEC-008): the provider said so, the manifest priced
 * it, or it ran locally and is recorded at zero as unmetered.
 */
export const ActualCostSourceSchema = z.enum(["provider-reported", "manifest-derived", "local-zero"]);
export type ActualCostSource = z.infer<typeof ActualCostSourceSchema>;

/** Money is integer micro-dollars, never floating point (SPEC-008 R-14). */
export const TakeCostSchema = z
  .object({
    estimatedMicroUsd: z.number().int().min(0),
    actualMicroUsd: z.number().int().min(0).nullable(),
    actualSource: ActualCostSourceSchema.optional(),
    /**
     * A duration-pro-rata share of a pass's real charge, divided rather than measured
     * (SPEC-013 R-5, D4). The ledger records the pass once; totals never double-count.
     */
    allocated: z.boolean().optional(),
  })
  .strict();
export type TakeCost = z.infer<typeof TakeCostSchema>;

/** What the world looked like at dispatch — the pair that makes drift computable (§2.4). */
export const ProvenanceSchema = z
  .object({
    /** Complete local preparation evidence, frozen by audio consumers rather than a cache pointer. */
    audioAssets: z.array(AudioAssetProvenanceSchema).optional(),
    dialogueAssessments: z.record(ShotIdSchema, DialogueDispatchAssessmentSchema).optional(),
    canonRevision: z.number().int().min(0),
    sheets: z.record(SlugSchema, z.number().int().min(1)),
    /** Frozen at dispatch; later world-look versions never rewrite this value. */
    artDirectionVersion: z.number().int().min(1).optional(),
    /** Frame runs retain the exact scene revision that authorized the take. */
    sceneId: SceneIdSchema.optional(),
    sceneVersion: z.number().int().min(1).optional(),
    /**
     * The recipe version a local-recipe take was made with (SPEC-021 §2.9, R-13). The recipe id
     * is already `model`; this is what keeps "made with Draft Video v1, which no longer exists"
     * answerable after the catalogue advances. Read from the identity frozen on the job at
     * enqueue, never looked up at arrival.
     */
    recipeVersion: z.number().int().min(1).optional(),
    /**
     * The prop states this take dispatched with (design turn 105; issue 534) — one entry per prop
     * the shot cited, each explicit about what resolved and what did not. Absent for every take
     * made before props existed and for any shot that cites none.
     */
    propStates: z.array(PropStateProvenanceSchema).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * What arrival measured about the decoded media, when it could measure anything (#248).
 *
 * A provider can return a file that declares an ordinary frame rate and contains runs of
 * byte-identical frames — nominally 24 fps, effectively half that, and it reads as stutter to
 * the person watching it rather than to anything that inspected it. This records that signal
 * before review, so a clip's motion is known before somebody spends attention discovering it.
 *
 * Deliberately non-authoritative. The measurement cannot tell a provider's duplicated frames
 * from a deliberately motionless shot, so it never rejects, repairs, or hides a take — and it
 * is optional, because a machine without ffmpeg is a supported way to run this application.
 */
export const TakeQcSchema = z
  .object({
    method: z.literal("adjacent-framemd5-v1"),
    /** The decoded media file, not editorial intent and not a separately decoded segment. */
    scope: z.literal("source-media"),
    status: z.enum(["clean", "degraded"]),
    nominalFps: z.number().positive(),
    effectiveFps: z.number().min(0),
    duplicateFrames: z.number().int().min(0),
    duplicateRatio: z.number().min(0).max(1),
    sampledFrames: z.number().int().min(2),
    thresholdRatio: z.literal(0.8),
  })
  .strict();
export type TakeQc = z.infer<typeof TakeQcSchema>;

export const TakeSchema = z
  .object({
    id: TakeIdSchema,
    /** User-uploaded reference takes have no generating job. */
    jobId: JobIdSchema.optional(),
    /** Present when produced by a whole-scene pass (§10.3). */
    passId: PassIdSchema.optional(),
    /** One shot per-shot; several for a pass segment. */
    /** Reference takes cover a sheet rather than a shot and therefore carry an empty array. */
    coversShots: z.array(ShotIdSchema),
    kind: TakeKindSchema,
    reference: z.object({ sheetId: SlugSchema }).strict().optional(),
    /** A prop-state take names its prop and state instead of a sheet (issue 535). */
    prop: z.object({ propId: PropIdSchema, stateId: PropStateIdSchema }).strict().optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    provenance: ProvenanceSchema,
    prompt: z.string().optional(),
    /** World-relative reference paths, e.g. "references/maren-kest/model-sheet-v4.png". */
    references: z.array(z.string()).default([]),
    /** World-relative path of the seeding frame, when continuity-chained (§10.4). */
    startFrame: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
    cost: TakeCostSchema,
    dispatchedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.optional(),
    /** Media filename within the take directory, e.g. "clip.mp4". */
    media: z.string().optional(),
    /** Durable provider sheet retained for review/context, never a shot-selectable frame. */
    boardSheetParent: z.literal(true).optional(),
    /**
     * A pass segment references the pass's media with an in/out range — a range, not a file
     * (SPEC-013 R-3, D2). Boundaries come from the pre-dispatch shot plan, never from
     * inspecting the returned clip (R-4, D3).
     */
    segment: z
      .object({
        passTakeId: TakeIdSchema,
        inSec: z.number().min(0),
        outSec: z.number().min(0),
      })
      .strict()
      .optional(),
    /** A deterministic image crop derived from an immutable multi-panel parent sheet. */
    panel: z
      .object({
        parentTakeId: TakeIdSchema,
        sourceJobId: JobIdSchema,
        index: z.number().int().min(1),
        shotId: ShotIdSchema,
        crop: z
          .object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .strict(),
        /** Hash of the immutable provider result retained by the parent take. */
        parentHash: z.string().regex(/^sha256:[0-9a-f]{16}$/),
        /** Hash of the normalized PNG bytes whose pixels the crop geometry addresses. */
        cropSourceHash: z.string().regex(/^sha256:[0-9a-f]{16}$/),
        hash: z.string().regex(/^sha256:[0-9a-f]{16}$/),
      })
      .strict()
      .optional(),
    /**
     * The take this one was produced by extending (SPEC-019 R-53, D34).
     *
     * The edge continuation adds to a take graph that had none. It is what makes supersession
     * computable when the predecessor stops being the selection — and what R-52 reads to refuse
     * a second hop, since §1.4 settles v1 on a single link.
     */
    continuedFrom: TakeIdSchema.optional(),
    /**
     * How that predecessor was continued (issue 852): `extended` on a route that reads the
     * footage and carries on from its last frame, `carried` where the model has no such route and
     * the take rode as a motion reference instead — a weaker promise (no shared latent, no audio
     * carried) that the provenance has to name, or a carried take reads as an extension it is not.
     * Absent on takes older than the distinction, which were all extensions.
     */
    continuation: z.enum(["extended", "carried"]).optional(),
    /**
     * Absent means "not measured" — no analyzer configured, or the measurement could not be
     * made — and never "measured clean". Legacy takes have none and are not backfilled: a take
     * is immutable, and inventing a measurement nobody took would be worse than saying nothing.
     */
    qc: TakeQcSchema.optional(),
  })
  .strict()
  .superRefine((take, ctx) => {
    if (take.boardSheetParent === true && (take.kind !== "frame" || take.jobId === undefined || take.coversShots.length === 0 || take.panel !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["boardSheetParent"], message: "a board-sheet parent must be a generated frame covering shots, not a panel crop" });
    }
  });
export type Take = z.infer<typeof TakeSchema>;

// ---------------------------------------------------------------------------
// Review decisions — reviews.jsonl (§2.3.6). Append-only; later lines win.
// ---------------------------------------------------------------------------

export const ReviewDecisionSchema = z
  .object({
    ts: IsoDateTimeSchema,
    takeId: TakeIdSchema,
    shotId: ShotIdSchema.optional(),
    decision: z.enum(["accept", "reject"]),
    by: z.string().min(1),
    /** A rejection may cite the sheet field the take drifted from (§10.5). */
    citation: z
      .object({
        sheet: SlugSchema,
        field: z.string().optional(),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
