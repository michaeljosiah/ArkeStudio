import { z } from "zod";
import { CanonIdSchema, IsoDateTimeSchema, ProposalIdSchema, Sha256Schema } from "./ids.js";

/**
 * Proposals and ripples (master spec §3.3–§3.4).
 *
 * A proposal is a directory under `.proposals/<id>/` holding the complete proposed files —
 * whole files, not patches — plus this manifest. Every proposal records the base it was
 * drafted against; accept verifies every base hash under the world lock and refuses a stale
 * proposal rather than merging silently.
 */

export const ProposalKindSchema = z.enum([
  "sheet-edit",
  "new-sheet",
  "canon-edit",
  "new-canon",
  "canon-settle",
  "chapter-draft",
  "story-overview",
  "scene-draft",
  "scene-edit",
  "extraction",
  "restore",
]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const ProposalTargetSchema = z
  .object({
    /** World-relative path of the file the proposal replaces or creates. */
    path: z.string().min(1),
    /** The entity's version when drafting began; null for a new file. */
    baseVersion: z.number().int().min(1).nullable(),
    /** Content hash when drafting began; null for a new file. */
    baseHash: Sha256Schema.nullable(),
  })
  .strict();
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>;

export const ProposalSchema = z
  .object({
    id: ProposalIdSchema,
    kind: ProposalKindSchema,
    /** One-line human summary shown on the proposal panel. */
    summary: z.string().min(1),
    targets: z.array(ProposalTargetSchema).min(1),
    baseCanonRevision: z.number().int().min(0),
    /** Canon ids reserved at proposal time under the world lock (§2.3.1). */
    reservedCanonIds: z.array(CanonIdSchema),
    /** Where the draft came from, e.g. "chat:sess_9f2" | "form" | "import:ar_…". */
    source: z.string().min(1),
    created: IsoDateTimeSchema,
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

// ---------------------------------------------------------------------------
// Ripples (§3.4) — computed from the index, never asked of the model. The set stored with a
// proposal is an advisory preview; the governing set is recomputed at accept under the lock.
// ---------------------------------------------------------------------------

export const RippleKindSchema = z.enum([
  "stale-reference-tiles",
  "productions-pick-up",
  "scene-briefs-rerender",
  "owning-canon-rules",
  "takes-pinned-to-old-version",
  "contradiction-candidates",
  "gains-cross-reference",
  "productions-see-new-revision",
]);
export type RippleKind = z.infer<typeof RippleKindSchema>;

export const RippleItemSchema = z
  .object({
    kind: RippleKindSchema,
    /** Human sentence, e.g. "14 reference images predate v5 — regenerate looks after accept". */
    summary: z.string().min(1),
    /** The ids or paths the ripple touches. */
    targets: z.array(z.string()),
  })
  .strict();
export type RippleItem = z.infer<typeof RippleItemSchema>;

export const RipplePreviewSchema = z
  .object({
    computedAt: IsoDateTimeSchema,
    /** True only for the governing recompute done at accept time (§3.4). */
    governing: z.boolean().default(false),
    items: z.array(RippleItemSchema),
  })
  .strict();
export type RipplePreview = z.infer<typeof RipplePreviewSchema>;
