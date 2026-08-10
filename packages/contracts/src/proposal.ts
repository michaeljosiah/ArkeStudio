import { z } from "zod";
import { CanonIdSchema, IsoDateTimeSchema, ProposalIdSchema, Sha256Schema, SlugSchema } from "./ids.js";

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
    "art-direction",
  /** #70: the several changes one conversation turned into, staged together. */
  "worldbuilding",
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

/** A same-field rebase conflict awaiting a human choice (SPEC-004 R-6, D4). */
export const ProposalConflictSchema = z
  .object({
    path: z.string().min(1),
    /** Frontmatter key or section heading — the merge unit. */
    field: z.string().min(1),
    base: z.string().nullable(),
    mine: z.string().nullable(),
    theirs: z.string().nullable(),
    resolution: z.enum(["mine", "theirs"]).optional(),
  })
  .strict();
export type ProposalConflict = z.infer<typeof ProposalConflictSchema>;

/** Which proposition became which proposal, and at what revision (#70 §11.1). */
export const WorldChatProposalOriginSchema = z
  .object({
    requestId: z.string().min(1),
    conversationId: z.string().min(1),
    candidateId: z.string().min(1),
    candidateRevision: z.number().int().min(1),
    groupId: z.string().min(1).optional(),
    targetPaths: z.array(z.string().min(1)),
    fields: z.array(z.string().min(1)),
  })
  .strict();
export type WorldChatProposalOrigin = z.infer<typeof WorldChatProposalOriginSchema>;

export const ProposalOpenChoiceSchema = z
  .object({
    choiceId: z.string().min(1),
    kind: z.enum(["duplicate-or-amend", "unchecked-novelty"]),
    question: z.string().min(1).max(400),
    options: z.array(z.object({ optionId: z.string().min(1), label: z.string().min(1).max(200) }).strict()).min(2),
  })
  .strict();
export type ProposalOpenChoice = z.infer<typeof ProposalOpenChoiceSchema>;

/** The skill a draft was shaped under, recorded on the proposal it shaped (SPEC-019 R-19). */
export const ProposalSkillSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().min(1),
    /** The model family the guidance was written for, which R-21 compares against at dispatch. */
    family: z.string().min(1),
  })
  .strict();
export type ProposalSkill = z.infer<typeof ProposalSkillSchema>;

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
    /**
     * The production this draft belongs to, when it stages a guest (SPEC-020 R-8).
     *
     * Recorded on the proposal because the targets carry only path, base version and base hash —
     * no content — so nothing downstream can tell a pending guest from a pending world sheet by
     * reading them. Without it a staged guest appears in the world's cast fan and ledgers for the
     * whole length of its review, which is the one thing the scope was added to prevent.
     *
     * Provenance stays in `source`; this is ownership, and the two answer different questions.
     */
    production: SlugSchema.optional(),
    created: IsoDateTimeSchema,
    /** Set by a rebase: the merged result must be seen before accept (SPEC-004 R-7). */
    pendingReview: z.boolean().optional(),
    /** Same-field conflicts from the last rebase; all must carry a resolution before accept. */
    conflicts: z.array(ProposalConflictSchema).optional(),
    rebasedAt: IsoDateTimeSchema.optional(),
    /**
     * #70 §11.1. Optional and defaulted so every proposal written before this existed still
     * parses: a proposal on disk is a record, and a reader that rejected last week's records
     * would lose work rather than migrate it.
     */
    draftRevision: z.number().int().min(1).default(1),
    /**
     * The request id of the edit that produced this revision (#70 §11.4.1).
     *
     * A refused edit is retried by the screen that lost, and the retry must be the same edit
     * rather than a second one. Recorded on the manifest because the journal is gone by the time
     * the retry arrives — the whole point of the journal is that it does not outlive the edit.
     */
    lastDraftRequestId: z.string().min(1).optional(),
    /**
     * Which propositions became this proposal.
     *
     * Explains the draft; it never governs acceptance. The proposed files and the captured bases
     * remain the gate's only authority, so a wrong or missing origin can mislead a reader but can
     * never let something into the world that the gate would refuse.
     */
    worldChatOrigins: z.array(WorldChatProposalOriginSchema).optional(),
    /**
     * Questions the coordinator could not answer, blocking this proposal's acceptance and no
     * other (R-34c).
     *
     * This is what lets wrap-up be one step. A question travels with the proposal it concerns
     * rather than holding the whole wrap-up behind a dialog, so it is answered beside the values
     * it would change and everything else stays acceptable.
     */
    openChoices: z.array(ProposalOpenChoiceSchema).optional(),
    /**
     * The authoring skill in force when this draft was shaped (SPEC-019 R-19).
     *
     * Same discipline as provenance at dispatch: a scene drafted under one version of a family's
     * guidance and one drafted under the next differ for a reason that is otherwise
     * unrecoverable. Explains the draft and never governs acceptance — the gate's authority is
     * still the proposed files and the captured bases.
     *
     * Absent means the draft was made under general guidance, which is an ordinary outcome
     * (R-20) and not a missing field.
     */
    skill: ProposalSkillSchema.optional(),
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
  "visual-assets-keep-look",
  "reference-kits-see-new-look",
  "productions-inherit-look",
  "overrides-keep-own-look",
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
