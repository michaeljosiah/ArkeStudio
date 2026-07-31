import { z } from "zod";
import {
  IsoDateTimeSchema,
  JobIdSchema,
  PassIdSchema,
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

export const TakeKindSchema = z.enum(["clip", "frame", "still", "voice", "sheet"]);
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
  })
  .strict();
export type TakeCost = z.infer<typeof TakeCostSchema>;

/** What the world looked like at dispatch — the pair that makes drift computable (§2.4). */
export const ProvenanceSchema = z
  .object({
    canonRevision: z.number().int().min(0),
    sheets: z.record(SlugSchema, z.number().int().min(1)),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const TakeSchema = z
  .object({
    id: TakeIdSchema,
    jobId: JobIdSchema,
    /** Present when produced by a whole-scene pass (§10.3). */
    passId: PassIdSchema.optional(),
    /** One shot per-shot; several for a pass segment. */
    coversShots: z.array(ShotIdSchema).min(1),
    kind: TakeKindSchema,
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
  })
  .strict();
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
