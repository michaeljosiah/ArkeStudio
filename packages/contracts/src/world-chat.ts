import { z } from "zod";
import {
  CandidateGroupIdSchema,
  CandidateIdSchema,
  CanonIdSchema,
  ChatAttachmentIdSchema,
  ChatEventIdSchema,
  CheckReceiptIdSchema,
  ConversationIdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  Sha256Schema,
  SlugSchema,
  TurnIdSchema,
} from "./ids.js";

/**
 * World Chat (#70): a conversation about a world, and the propositions it produced.
 *
 * The shape here follows one rule that is easy to lose later: **the conversation is not the
 * authority for anything the world contains.** Messages record what was said, propositions record
 * what the Studio understood, and neither is a file. Only wrap-up writes a proposal, and only the
 * accept gate writes the world.
 *
 * A second rule shapes the event log: the store appends, it does not mutate. A proposition's
 * current state is the fold of its snapshots, so a torn write costs the last event and nothing
 * before it. That is why turn.completed carries the reply *and* every proposition it changed in
 * one record — a crash must not be able to persist a reply whose propositions never arrived.
 */

// ---------------------------------------------------------------------------
// Conversation identity and lifecycle
// ---------------------------------------------------------------------------

/**
 * `conversation.json` — the immutable header, and nothing else.
 *
 * Title, lifecycle and updatedAt are deliberately absent: they are folded from events. Keeping
 * mutable metadata in a second file would mean two writers racing over one conversation's truth,
 * and the checkpoint already exists to make the fold cheap.
 */
export const WorldChatConversationMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ConversationIdSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WorldChatConversationMeta = z.infer<typeof WorldChatConversationMetaSchema>;

/**
 * `open` while it can still be talked to, `closed` once wrap-up turned it into proposals,
 * `archived` when shelved by hand. Closed is not archived: a closed conversation still owns the
 * proposals it produced, and sending one back reopens it.
 */
export const WorldChatStatusSchema = z.enum(["open", "closed", "archived"]);
export type WorldChatStatus = z.infer<typeof WorldChatStatusSchema>;

/**
 * Why a conversation cannot be deleted yet (R-50), or absent when it can be.
 *
 * Carried on the row rather than asked for on demand, because the reason has to be readable
 * *before* the button is pressed. A Delete that looks available and then refuses is the same
 * design mistake as one that vanishes without saying why.
 */
export const WorldChatDeletionBlockSchema = z.enum([
  "active-run",
  "wrap-up-in-flight",
  "unresolved-proposals",
]);
export type WorldChatDeletionBlock = z.infer<typeof WorldChatDeletionBlockSchema>;

/** What the conversation was opened about. Focus can change without losing what came before. */
export const WorldChatContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world") }).strict(),
  z
    .object({
      kind: z.literal("canon-question"),
      question: z.string().min(1).max(2000),
      candidateEntryIds: z.array(CanonIdSchema),
    })
    .strict(),
  z.object({ kind: z.literal("canon-entry"), entryId: CanonIdSchema }).strict(),
  z
    .object({
      kind: z.literal("sheet"),
      sheetKind: z.enum(["character", "location", "faction"]),
      sheetId: SlugSchema,
    })
    .strict(),
  z.object({ kind: z.literal("attachment"), attachmentId: ChatAttachmentIdSchema }).strict(),
]);
export type WorldChatContext = z.infer<typeof WorldChatContextSchema>;

// ---------------------------------------------------------------------------
// References into the world
// ---------------------------------------------------------------------------

const SheetKindSchema = z.enum(["character", "location", "faction"]);
export type WorldChatSheetKind = z.infer<typeof SheetKindSchema>;

/** What a proposition is about. Model output uses these; it never supplies a path. */
export const WorldChatEntityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world") }).strict(),
  z.object({ kind: z.literal("canon"), entryId: CanonIdSchema }).strict(),
  z.object({ kind: z.literal("sheet"), sheetKind: SheetKindSchema, sheetId: SlugSchema }).strict(),
]);
export type WorldChatEntityRef = z.infer<typeof WorldChatEntityRefSchema>;

/**
 * A reference to something that does not exist yet, pinned to the exact revision that will
 * create it. Wrap-up allocates every identity first, then resolves the graph, so two new
 * entities in one proposal can cite each other. A pending reference outside the group is
 * rejected rather than silently dropped.
 */
export const PendingRefSchema = z
  .object({ candidateId: CandidateIdSchema, revision: z.number().int().min(1) })
  .strict();

export const WorldChatLinkRefSchema = z.union([
  z.object({ kind: z.literal("canon"), entryId: CanonIdSchema }).strict(),
  z.object({ kind: z.literal("sheet"), sheetId: SlugSchema }).strict(),
  z.object({ kind: z.literal("pending-entity"), ref: PendingRefSchema }).strict(),
]);
export type WorldChatLinkRef = z.infer<typeof WorldChatLinkRefSchema>;

// ---------------------------------------------------------------------------
// Messages and runs
// ---------------------------------------------------------------------------

export const WorldChatMessageSchema = z
  .object({
    id: MessageIdSchema,
    turnId: TurnIdSchema,
    role: z.enum(["user", "studio"]),
    text: z.string(),
    /** Conversation-private attachment ids, not world artifact ids. */
    attachmentIds: z.array(ChatAttachmentIdSchema),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WorldChatMessage = z.infer<typeof WorldChatMessageSchema>;

export const WorldChatRunStatusSchema = z.enum([
  "running",
  "completed",
  "cancelled",
  "timeout",
  "budget-exceeded",
  "interrupted",
  "failed",
]);
export type WorldChatRunStatus = z.infer<typeof WorldChatRunStatusSchema>;

/**
 * One model attempt. `harnessCleanup` is recorded rather than assumed: an adapter that cannot
 * delete its own sessions must not be described as if it had, so the honest states include
 * "unsupported" and "unconfirmed".
 */
export const WorldChatRunSchema = z
  .object({
    id: RunIdSchema,
    turnId: TurnIdSchema,
    basedOnConversationSeq: z.number().int().min(0),
    status: WorldChatRunStatusSchema,
    adapter: z.string().min(1),
    model: z.string().min(1).optional(),
    harnessSessionId: z.string().min(1).optional(),
    harnessCleanup: z.enum(["not-required", "pending", "confirmed", "unsupported", "unconfirmed"]),
    contextDigest: Sha256Schema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.optional(),
    /** Operator-safe detail. Never carries message, candidate or world content. */
    safeDetail: z.string().max(500).optional(),
  })
  .strict();
export type WorldChatRun = z.infer<typeof WorldChatRunSchema>;

// ---------------------------------------------------------------------------
// Evidence and checks
// ---------------------------------------------------------------------------

/**
 * Why a proposition exists, in terms that can be checked. Every quote is verified against its
 * source before the turn is accepted, so a proposition can never cite something that was not
 * said or is no longer there.
 */
const MessageEvidencePurposeSchema = z.enum(["intent", "settledness", "correction"]);
const WorldEvidencePurposeSchema = z.enum(["supports", "amendment-target", "duplicate", "context"]);

export const CandidateEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      messageId: MessageIdSchema,
      quote: z.string().min(1).max(2000),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      purpose: MessageEvidencePurposeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("world"),
      ref: WorldChatEntityRefSchema,
      /** Sheet version, or the world's Canon revision for a Canon observation. */
      observedVersion: z.number().int().min(0),
      contentHash: Sha256Schema,
      field: z.string().max(120).optional(),
      quote: z.string().min(1).max(2000),
      purpose: WorldEvidencePurposeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("attachment"),
      attachmentId: ChatAttachmentIdSchema,
      contentHash: Sha256Schema,
      artifactId: z.string().min(1).optional(),
      quote: z.string().min(1).max(2000),
      line: z.number().int().min(1).optional(),
      purpose: z.literal("supports"),
    })
    .strict(),
]);
export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;

export const CheckToolSchema = z.enum([
  "search-canon",
  "search-sheets",
  "get-entry",
  "get-sheet",
  "list-entities",
  "related",
  "get-attachment-text",
]);

/** One coordinator-owned observation. The model never writes these; it only cites them. */
export const WorldChatCheckReceiptSchema = z
  .object({
    id: CheckReceiptIdSchema,
    runId: RunIdSchema,
    tool: CheckToolSchema,
    status: z.enum(["complete", "empty", "unavailable", "failed"]),
    /** Safe product text, never raw tool JSON, and never written to diagnostics. */
    querySummary: z.string().max(300).optional(),
    consulted: z.array(
      z
        .object({
          ref: WorldChatEntityRefSchema,
          observedVersion: z.number().int().min(0),
          contentHash: Sha256Schema,
        })
        .strict(),
    ),
    searchedCount: z.number().int().min(0).optional(),
    at: IsoDateTimeSchema,
  })
  .strict();
export type WorldChatCheckReceipt = z.infer<typeof WorldChatCheckReceiptSchema>;

export const CheckCategorySchema = z.enum(["canon-search", "sheet-search", "target-read", "related-read"]);

/**
 * What was actually checked, derived by the coordinator from receipts. The model may offer
 * prose for `explanation`, but it cannot decide `state`, the duplicate sets, or completeness —
 * an unchecked idea must never be able to describe itself as new.
 */
export const CandidateChecksSchema = z
  .object({
    state: z.enum(["complete", "partial", "unavailable", "stale"]),
    basedOnCanonRevision: z.number().int().min(0),
    required: z.array(CheckCategorySchema),
    completed: z.array(CheckCategorySchema),
    consulted: z.array(
      z
        .object({
          ref: WorldChatEntityRefSchema,
          observedVersion: z.number().int().min(0),
          contentHash: Sha256Schema,
          checkId: CheckReceiptIdSchema,
        })
        .strict(),
    ),
    likelyDuplicates: z.array(WorldChatEntityRefSchema),
    possibleAmendments: z.array(WorldChatEntityRefSchema),
    contradictionCandidates: z.array(WorldChatEntityRefSchema),
    explanation: z.string().max(1000),
    userOverride: z
      .object({
        at: IsoDateTimeSchema,
        reason: z.enum(["create-anyway", "target-selected", "retrieval-unavailable"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CandidateChecks = z.infer<typeof CandidateChecksSchema>;

// ---------------------------------------------------------------------------
// Propositions
// ---------------------------------------------------------------------------

export const WorldChangeClassificationSchema = z.enum([
  "canon.create",
  "canon.amend",
  "canon.thread",
  "sheet.create",
  "sheet.edit",
  "relationship.change",
  "media.image-opportunity",
  "undecided",
]);
export type WorldChangeClassification = z.infer<typeof WorldChangeClassificationSchema>;

/**
 * Internal bookkeeping, never a vocabulary shown to the user. The understanding panel renders
 * `live` propositions and nothing else.
 *
 * `discarded` deliberately does not return to `live`: discard is the user saying they changed
 * their mind, while send-back is the one that reopens the conversation. Having both is what
 * makes discard safe to offer.
 */
export const CandidateStatusSchema = z.enum([
  "live",
  "withdrawn",
  "superseded",
  "proposed",
  "accepted",
  "discarded",
  "handed-off",
]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const SettlednessSchema = z.enum(["settled", "tentative", "unresolved"]);
export type Settledness = z.infer<typeof SettlednessSchema>;

const SectionSchema = z.object({ heading: z.string().min(1).max(120), body: z.string() }).strict();

const CanonEntryTypeSchema = z.enum(["rule", "lore", "location", "faction", "timeline", "tone"]);

const CandidateBaseSchema = z.object({
  id: CandidateIdSchema,
  conversationId: ConversationIdSchema,
  revision: z.number().int().min(1),
  status: CandidateStatusSchema,
  settledness: SettlednessSchema,
  /** The heading it displays under. Grouping is by subject, not by classification. */
  subject: z.union([
    WorldChatEntityRefSchema,
    z.object({ kind: z.literal("new"), label: z.string().min(1).max(120) }).strict(),
  ]),
  /** One sentence, in the user's register. This is what the panel renders. */
  title: z.string().min(1).max(160),
  rationale: z.string().max(1000),
  sourceMessageIds: z.array(MessageIdSchema),
  evidence: z.array(CandidateEvidenceSchema),
  checks: CandidateChecksSchema,
  groupId: CandidateGroupIdSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  proposalBinding: z
    .object({
      proposalId: ProposalIdSchema,
      proposedCandidateRevision: z.number().int().min(1),
      targetPaths: z.array(z.string().min(1)),
      acceptedProposalDigest: Sha256Schema.optional(),
    })
    .strict()
    .optional(),
  /** Set when this proposition came back from a proposal that was sent back. */
  returnedFrom: z.object({ proposalId: ProposalIdSchema, at: IsoDateTimeSchema }).strict().optional(),
  splitFrom: CandidateIdSchema.optional(),
  supersedes: z.array(CandidateIdSchema).optional(),
});

/**
 * The eight payloads a proposition can carry. Each carries only what its files need.
 *
 * Defined once and shared by the stored candidate (which adds the identity, status and checks
 * the coordinator owns) and the model-facing draft (which adds none of those). Writing them
 * twice would let the two drift, and the drift would show up at the worst moment: a model draft
 * that validates on arrival but cannot become a stored candidate, discovered only after the
 * user's turn is otherwise complete.
 */
const CanonCreatePayload = {
  classification: z.literal("canon.create"),
  draft: z
    .object({
      type: CanonEntryTypeSchema,
      title: z.string().min(1).max(160),
      statement: z.string().min(1),
      links: z.array(WorldChatLinkRefSchema),
    })
    .strict(),
} as const;

const CanonAmendPayload = {
  classification: z.literal("canon.amend"),
  target: z.object({ kind: z.literal("canon"), entryId: CanonIdSchema }).strict(),
  draft: z
    .object({
      type: CanonEntryTypeSchema.optional(),
      title: z.string().min(1).max(160).optional(),
      statement: z.string().min(1).optional(),
      links: z.array(WorldChatLinkRefSchema).optional(),
    })
    .strict()
    // An amendment that changes nothing is a no-op the gate would reject later; catching it
    // here means it never becomes a proposal in the first place.
    .refine((d) => Object.keys(d).length > 0, "an amendment must change at least one field"),
} as const;

const CanonThreadPayload = {
  classification: z.literal("canon.thread"),
  draft: z
    .object({
      title: z.string().min(1).max(160),
      question: z.string().min(1),
      consideredEntryIds: z.array(CanonIdSchema),
    })
    .strict(),
} as const;

const SheetCreatePayload = {
  classification: z.literal("sheet.create"),
  draft: z
    .object({
      type: SheetKindSchema,
      name: z.string().min(1).max(120),
      role: z.string().max(200).optional(),
      billing: z.string().max(80).optional(),
      region: z.string().max(120).optional(),
      canonRules: z.array(CanonIdSchema),
      links: z.array(WorldChatLinkRefSchema),
      sections: z.array(SectionSchema),
    })
    .strict(),
} as const;

const SheetEditPayload = {
  classification: z.literal("sheet.edit"),
  target: z.object({ kind: z.literal("sheet"), sheetKind: SheetKindSchema, sheetId: SlugSchema }).strict(),
  // Version, status, retirement and voice are absent on purpose: each has its own workflow,
  // and a conversation must not be able to reach them by describing a sheet edit.
  draft: z
    .object({
      name: z.string().min(1).max(120).optional(),
      role: z.string().max(200).nullable().optional(),
      billing: z.string().max(80).nullable().optional(),
      region: z.string().max(120).nullable().optional(),
      canonRules: z.array(CanonIdSchema).optional(),
      links: z.array(WorldChatLinkRefSchema).optional(),
      sections: z.array(SectionSchema).optional(),
    })
    .strict(),
} as const;

const LinkActionSchema = z.enum(["add", "remove", "unchanged"]);

const RelationshipChangePayload = {
  classification: z.literal("relationship.change"),
  draft: z
    .object({
      from: WorldChatLinkRefSchema,
      to: WorldChatLinkRefSchema,
      linkAction: LinkActionSchema,
      proseEdits: z.array(
        z
          .object({
            sheet: WorldChatLinkRefSchema,
            sectionHeading: z.string().min(1).max(120),
            /** The complete proposed section body, never an append instruction. */
            body: z.string(),
            reason: z.string().max(500),
          })
          .strict(),
      ),
    })
    .strict(),
} as const;

const ImagePurposeSchema = z.enum(["world-key-art", "character-main-photo", "character-look"]);

const ImageOpportunityPayload = {
  classification: z.literal("media.image-opportunity"),
  draft: z
    .object({
      target: WorldChatEntityRefSchema,
      purpose: ImagePurposeSchema,
      brief: z.string().min(1).max(4000),
      reason: z.string().max(1000),
      dependencies: z.array(
        z.union([
          PendingRefSchema,
          z.object({ proposalId: ProposalIdSchema, targetPath: z.string().optional() }).strict(),
        ]),
      ),
    })
    .strict(),
} as const;

const UndecidedPayload = {
  classification: z.literal("undecided"),
  draft: z
    .object({
      question: z.string().min(1),
      plausibleActions: z.array(WorldChangeClassificationSchema),
      possibleTargets: z.array(WorldChatEntityRefSchema),
    })
    .strict(),
} as const;

/** The eight things a proposition can be, as the coordinator stores them. */
export const WorldChangeCandidateSchema = z.discriminatedUnion("classification", [
  CandidateBaseSchema.extend(CanonCreatePayload).strict(),
  CandidateBaseSchema.extend(CanonAmendPayload).strict(),
  CandidateBaseSchema.extend(CanonThreadPayload).strict(),
  CandidateBaseSchema.extend(SheetCreatePayload).strict(),
  CandidateBaseSchema.extend(SheetEditPayload).strict(),
  CandidateBaseSchema.extend(RelationshipChangePayload).strict(),
  CandidateBaseSchema.extend(ImageOpportunityPayload).strict(),
  CandidateBaseSchema.extend(UndecidedPayload).strict(),
]);

export type WorldChangeCandidate = z.infer<typeof WorldChangeCandidateSchema>;

/**
 * An atomic group: these land together or not at all. Computed by the coordinator, never
 * assembled by the user — atomicity is a property of the references between propositions, not a
 * preference, and asking a person to work it out twelve times was the thing this design removed.
 */
export const CandidateGroupSchema = z
  .object({
    id: CandidateGroupIdSchema,
    conversationId: ConversationIdSchema,
    revision: z.number().int().min(1),
    title: z.string().min(1).max(160),
    rationale: z.string().max(1000),
    members: z.array(PendingRefSchema).min(1),
    atomic: z.literal(true),
    status: z.enum(["live", "proposed", "accepted", "discarded", "withdrawn"]),
  })
  .strict();
export type CandidateGroup = z.infer<typeof CandidateGroupSchema>;

/** A retraction, so the same idea does not reappear next turn simply because it is in context. */
export const CandidateTombstoneSchema = z
  .object({
    candidateId: CandidateIdSchema,
    revision: z.number().int().min(1),
    /** Coordinator-computed: same target, same owned fields, same normalised values. */
    structuralKey: z.string().min(1),
    payloadDigest: Sha256Schema,
    retractedByMessageId: MessageIdSchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type CandidateTombstone = z.infer<typeof CandidateTombstoneSchema>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const WorldChatAttachmentSchema = z
  .object({
    id: ChatAttachmentIdSchema,
    conversationId: ConversationIdSchema,
    fileName: z.string().min(1).max(255),
    kind: z.enum(["document", "image", "audio", "video", "other"]),
    contentHash: Sha256Schema,
    byteLength: z.number().int().min(0),
    /** What the chat may honestly claim about it, and no more. */
    readability: z.enum(["text-readable", "not-readable", "extracted-text-available"]),
    linkedMessageIds: z.array(MessageIdSchema),
    promotedArtifactId: z.string().min(1).optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WorldChatAttachment = z.infer<typeof WorldChatAttachmentSchema>;

// ---------------------------------------------------------------------------
// The stored event log
// ---------------------------------------------------------------------------

/**
 * A proposition a wrap-up did not carry, and why (R-13, R-27d).
 *
 * The summary travels with the reason because the approvals screen names what did not come
 * across. A bare id would be unusable there, and a bare count would be worse: it would tell
 * somebody they had lost something without telling them what.
 */
export const WorldChatNotCarriedSchema = z
  .object({
    candidateId: CandidateIdSchema,
    summary: z.string().min(1).max(300),
    reason: z.enum(["tentative", "undecided", "target-missing", "invalid"]),
  })
  .strict();
export type WorldChatNotCarried = z.infer<typeof WorldChatNotCarriedSchema>;

/**
 * `turn.completed` carries the reply, its receipts and every proposition it changed in one
 * record. Splitting them would let a crash persist a reply that refers to propositions which
 * never landed, and the panel would then describe changes that do not exist.
 */
export const WorldChatStoredEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("conversation.created"),
      title: z.string().min(1).max(200),
      entryContext: WorldChatContextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("conversation.metadata-updated"),
      title: z.string().min(1).max(200).optional(),
      entryContext: WorldChatContextSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("conversation.archived") }).strict(),
  z.object({ type: z.literal("conversation.unarchived") }).strict(),
  z
    .object({
      type: z.literal("conversation.reopened"),
      /** Reopening has exactly one cause: a proposal was sent back. */
      proposalId: ProposalIdSchema,
      restoredCandidateIds: z.array(CandidateIdSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.started"),
      /** The user's message and its first run land together: no crash window between them. */
      message: WorldChatMessageSchema,
      run: WorldChatRunSchema,
    })
    .strict(),
  z.object({ type: z.literal("run.retry-started"), run: WorldChatRunSchema }).strict(),
  z
    .object({
      type: z.literal("run.session-created"),
      runId: RunIdSchema,
      harnessSessionId: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("run.finished"), run: WorldChatRunSchema }).strict(),
  z
    .object({
      type: z.literal("turn.completed"),
      message: WorldChatMessageSchema,
      run: WorldChatRunSchema,
      receipts: z.array(WorldChatCheckReceiptSchema),
      candidates: z.array(WorldChangeCandidateSchema),
      groups: z.array(CandidateGroupSchema),
      tombstones: z.array(CandidateTombstoneSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("candidate.status-changed"),
      candidateId: CandidateIdSchema,
      revision: z.number().int().min(1),
      status: CandidateStatusSchema,
      proposalId: ProposalIdSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("attachment.created"), attachment: WorldChatAttachmentSchema }).strict(),
  z
    .object({
      type: z.literal("attachment.linked"),
      attachmentId: ChatAttachmentIdSchema,
      messageId: MessageIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("attachment.unlinked"),
      attachmentId: ChatAttachmentIdSchema,
      messageId: MessageIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("attachment.promoted"),
      attachmentId: ChatAttachmentIdSchema,
      artifactId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("wrapup.intent-recorded"),
      requestId: z.string().min(1),
      expectedConversationSeq: z.number().int().min(0),
      plannedProposalIds: z.array(ProposalIdSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("wrapup.completed"),
      requestId: z.string().min(1),
      proposalIds: z.array(ProposalIdSchema),
      /** Named, never merely counted — a dropped idea must be visible as a dropped idea. */
      notCarried: z.array(WorldChatNotCarriedSchema),
      mediaIdeaIds: z.array(CandidateIdSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("wrapup.failed"),
      requestId: z.string().min(1),
      safeDetail: z.string().max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("proposal.resolved"),
      proposalId: ProposalIdSchema,
      outcome: z.enum(["accepted", "discarded", "sent-back"]),
      candidateIds: z.array(CandidateIdSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("summary.updated"),
      throughSeq: z.number().int().min(0),
      text: z.string().max(8000),
      sourceMessageIds: z.array(MessageIdSchema),
    })
    .strict(),
  z.object({ type: z.literal("deletion.intent-recorded"), requestId: z.string().min(1) }).strict(),
]);
export type WorldChatStoredEvent = z.infer<typeof WorldChatStoredEventSchema>;

/** One line of `events.jsonl`. The sequence is monotonic per conversation. */
export const WorldChatEventEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: z.number().int().min(1),
    eventId: ChatEventIdSchema,
    at: IsoDateTimeSchema,
    /** Present on anything a client can retry; a repeat returns the first result. */
    requestId: z.string().min(1).optional(),
    event: WorldChatStoredEventSchema,
  })
  .strict();
export type WorldChatEventEnvelope = z.infer<typeof WorldChatEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * What the world snapshot carries: enough to choose a conversation, and no history. Full
 * transcripts are loaded by id, so opening a world does not pay for every conversation ever had.
 *
 * There is deliberately no last-message preview. What is pending tells you whether to go back;
 * the previous sentence does not, and it costs a line on every row.
 */
export const WorldChatSummarySchema = z
  .object({
    id: ConversationIdSchema,
    title: z.string().min(1).max(200),
    status: WorldChatStatusSchema,
    updatedAt: IsoDateTimeSchema,
    entryContext: WorldChatContextSchema.optional(),
    /** Live propositions. Zero for a conversation that produced nothing. */
    pointCount: z.number().int().min(0),
    /** Proposals from its wrap-up that are still awaiting a decision. */
    openProposalCount: z.number().int().min(0),
    reopened: z.boolean().optional(),
    /** What its wrap-up could not carry, so the approvals screen can say so. */
    notCarried: z.array(WorldChatNotCarriedSchema).default([]),
    /** Why deleting is refused for now (R-50). Absent when it can be deleted. */
    deletionBlock: WorldChatDeletionBlockSchema.optional(),
  })
  .strict();
export type WorldChatSummary = z.infer<typeof WorldChatSummarySchema>;

/** A named failure to read part of a conversation. Surfaced, never silently swallowed. */
export const WorldChatProblemSchema = z
  .object({
    kind: z.enum(["torn-tail", "interior-corruption", "checkpoint-invalid", "foreign-write"]),
    detail: z.string().max(500),
    /** The first sequence that could not be trusted, when one is known. */
    atSeq: z.number().int().min(0).optional(),
  })
  .strict();
export type WorldChatProblem = z.infer<typeof WorldChatProblemSchema>;

/** The whole workspace for one conversation, folded from its events. */
export const WorldChatLoadedSchema = z
  .object({
    id: ConversationIdSchema,
    title: z.string().min(1).max(200),
    status: WorldChatStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    entryContext: WorldChatContextSchema.optional(),
    seq: z.number().int().min(0),
    /** Set when a sent-back proposal reopened this conversation. Survives checkpointing. */
    reopened: z.boolean().optional(),
    messages: z.array(WorldChatMessageSchema),
    /** True when older messages exist before `messages[0]`. */
    hasMore: z.boolean(),
    candidates: z.array(WorldChangeCandidateSchema),
    groups: z.array(CandidateGroupSchema),
    attachments: z.array(WorldChatAttachmentSchema),
    activeRun: WorldChatRunSchema.nullable(),
    /**
     * The most recent run that ended without producing a reply, once it is no longer active.
     *
     * Without this a failure erases itself: `activeRun` is only ever a running or interrupted
     * run, so a turn that timed out stops being active the instant it fails and the screen goes
     * quiet — which is exactly what it looks like when nothing was sent at all. A person who
     * waited two minutes for an answer is owed the difference between "still thinking" and
     * "this did not work".
     */
    lastFailedRun: WorldChatRunSchema.nullable().default(null),
    summary: z.string().max(8000).optional(),
    proposalIds: z.array(ProposalIdSchema),
    /** What its wrap-up could not carry; empty until one has happened. */
    notCarried: z.array(WorldChatNotCarriedSchema).default([]),
    /**
     * Why deleting is refused for now (R-50), or null when nothing depends on this conversation.
     *
     * Folded here rather than computed by the caller so that the row, the workspace and the
     * command that actually refuses all read one answer. Two implementations of "is this in use"
     * would eventually disagree, and the one that disagreed in the permissive direction would
     * delete something somebody still needed.
     */
    deletionBlock: WorldChatDeletionBlockSchema.nullable().default(null),
    problems: z.array(WorldChatProblemSchema),
  })
  .strict();
export type WorldChatLoaded = z.infer<typeof WorldChatLoadedSchema>;

/**
 * `checkpoint.json` — a derived acceleration file. Deleting it costs a fold, never data, and it
 * is distrusted whenever its sequence runs past the complete tail of the log it claims to
 * summarise.
 */
export const WorldChatCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    throughSeq: z.number().int().min(0),
    view: WorldChatLoadedSchema,
  })
  .strict();
export type WorldChatCheckpoint = z.infer<typeof WorldChatCheckpointSchema>;

// ---------------------------------------------------------------------------
// What the model is allowed to say (#70 §8.3)
// ---------------------------------------------------------------------------

/**
 * The common part of a model-proposed candidate.
 *
 * Everything the coordinator owns is absent: identity, revision, status, subject grouping, group
 * and proposal binding, paths, Canon IDs, sheet slugs, job IDs. The model proposes *what the
 * change is*; it never decides what the change is called or whether it is ready.
 *
 * `checkReceiptIds` is the one field that looks like an exception and is not. A model may cite
 * reads it made while composing, and those are shown as context — but they cannot satisfy the
 * coordinator's required check plan (§8.3.1). Otherwise a model could mark its own homework by
 * searching for something it knew would miss.
 */
export const ModelCandidateCommonSchema = z.object({
  title: z.string().min(1).max(160),
  rationale: z.string().max(1000),
  settledness: SettlednessSchema,
  evidence: z.array(CandidateEvidenceSchema),
  checkReceiptIds: z.array(CheckReceiptIdSchema),
});

export const ModelCandidateDraftSchema = z.discriminatedUnion("classification", [
  ModelCandidateCommonSchema.extend(CanonCreatePayload).strict(),
  ModelCandidateCommonSchema.extend(CanonAmendPayload).strict(),
  ModelCandidateCommonSchema.extend(CanonThreadPayload).strict(),
  ModelCandidateCommonSchema.extend(SheetCreatePayload).strict(),
  ModelCandidateCommonSchema.extend(SheetEditPayload).strict(),
  ModelCandidateCommonSchema.extend(RelationshipChangePayload).strict(),
  ModelCandidateCommonSchema.extend(ImageOpportunityPayload).strict(),
  ModelCandidateCommonSchema.extend(UndecidedPayload).strict(),
]);
export type ModelCandidateDraft = z.infer<typeof ModelCandidateDraftSchema>;

/** A temporary id is only meaningful inside the turn result that created it. */
const TemporaryIdSchema = z.string().min(1).max(64);

export const ModelCandidateRefSchema = z.union([
  z.object({ candidateId: CandidateIdSchema, revision: z.number().int().min(1) }).strict(),
  z.object({ temporaryId: TemporaryIdSchema }).strict(),
]);
export type ModelCandidateRef = z.infer<typeof ModelCandidateRefSchema>;

export const ModelCandidateOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), temporaryId: TemporaryIdSchema, candidate: ModelCandidateDraftSchema }).strict(),
  z
    .object({
      op: z.literal("update"),
      candidateId: CandidateIdSchema,
      expectedRevision: z.number().int().min(1),
      candidate: ModelCandidateDraftSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("withdraw"),
      candidateId: CandidateIdSchema,
      expectedRevision: z.number().int().min(1),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      op: z.literal("split"),
      candidateId: CandidateIdSchema,
      expectedRevision: z.number().int().min(1),
      replacements: z.array(ModelCandidateDraftSchema).min(2),
    })
    .strict(),
]);
export type ModelCandidateOperation = z.infer<typeof ModelCandidateOperationSchema>;

export const ModelGroupOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create"),
      temporaryId: TemporaryIdSchema,
      title: z.string().min(1).max(160),
      rationale: z.string().max(1000),
      members: z.array(ModelCandidateRefSchema).min(2),
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      groupId: CandidateGroupIdSchema,
      expectedRevision: z.number().int().min(1),
      title: z.string().min(1).max(160),
      rationale: z.string().max(1000),
      members: z.array(ModelCandidateRefSchema).min(2),
    })
    .strict(),
  z
    .object({
      op: z.literal("withdraw"),
      groupId: CandidateGroupIdSchema,
      expectedRevision: z.number().int().min(1),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
]);
export type ModelGroupOperation = z.infer<typeof ModelGroupOperationSchema>;

/**
 * The assistant's entire completed message (§8.3).
 *
 * The freeform `reply` carries no machine references to propositions. The panel renders from the
 * structured operations beside it, so an invalid candidate id is rejected in the operations
 * rather than inferred out of prose — there is no path by which what the Studio *said* can create
 * or alter a proposition that the operations did not.
 *
 * The bounds are hard. They are not a guess at what a model will do; they are what this app will
 * accept, so that one turn cannot become a wall of propositions nobody can review.
 */
export const TURN_RESULT_BOUNDS = {
  reply: 8_000,
  candidateOperations: 12,
  groupOperations: 6,
} as const;

export const WorldChatTurnResultSchema = z
  .object({
    reply: z.string().max(TURN_RESULT_BOUNDS.reply),
    candidateOperations: z.array(ModelCandidateOperationSchema).max(TURN_RESULT_BOUNDS.candidateOperations),
    groupOperations: z.array(ModelGroupOperationSchema).max(TURN_RESULT_BOUNDS.groupOperations),
  })
  .strict();
export type WorldChatTurnResult = z.infer<typeof WorldChatTurnResultSchema>;

// ---------------------------------------------------------------------------
// What the client renders (#70 §10.3)
// ---------------------------------------------------------------------------

/**
 * One line in the understanding panel.
 *
 * A projection, not the candidate itself. The panel shows what was understood in the user's own
 * register; it has no use for revisions, structural keys, evidence spans or classifications, and
 * sending them would invite a screen to start making decisions out of them. `settled` is here
 * only so the wrap-up caption can say how many points would actually carry.
 */
export const WorldChatPointSchema = z
  .object({
    id: CandidateIdSchema,
    /** A statement about the world, or a question still open. */
    kind: z.enum(["point", "question"]),
    /** The heading it displays under — the thing it is about. */
    subject: z.string().min(1).max(160),
    /** "sheet · v4", "new rule" — what the subject is, in the panel's own words. */
    subjectKind: z.string().max(80),
    /** One sentence, as the panel renders it. */
    text: z.string().min(1).max(400),
    /** Whether it is settled enough to become a proposal at wrap-up. */
    settled: z.boolean(),
  })
  .strict();
export type WorldChatPoint = z.infer<typeof WorldChatPointSchema>;

export const WorldChatTranscriptMessageSchema = z
  .object({
    id: MessageIdSchema,
    role: z.enum(["user", "studio"]),
    text: z.string(),
    /** Persisted receipts, already worded for a person: "read Maren Kest v4". */
    receipts: z.array(z.string().max(200)),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type WorldChatTranscriptMessage = z.infer<typeof WorldChatTranscriptMessageSchema>;

/**
 * One conversation as the client holds it.
 *
 * Loaded by id rather than carried in the world snapshot: opening a world must not cost every
 * conversation ever had, and a transcript is not world state.
 */
export const WorldChatWorkspaceSchema = z
  .object({
    conversationId: ConversationIdSchema,
    status: WorldChatStatusSchema,
    messages: z.array(WorldChatTranscriptMessageSchema),
    /** True when older messages exist before the first one here. */
    hasMore: z.boolean().default(false),
    points: z.array(WorldChatPointSchema),
    /**
     * How many events this conversation has, so wrap-up can be refused when it has moved on.
     *
     * Carried to the screen because the refusal has to be checkable at the moment the button is
     * pressed rather than discovered afterwards.
     */
    seq: z.number().int().min(0).default(0),
    /** Set while a turn is in flight, so the composer can say so. */
    runStatus: WorldChatRunStatusSchema.nullable().default(null),
    /**
     * When the turn in flight began, so the screen can count up alongside it.
     *
     * Elapsed time is the one honest thing a waiting surface can offer: it cannot promise how
     * long is left, but it can say how long it has been, which is what turns "is this broken?"
     * into "this is taking a while". Sent rather than started client-side so it survives a
     * reconnect mid-turn without restarting the clock.
     */
    runStartedAt: IsoDateTimeSchema.nullable().default(null),
    /**
     * The turn that failed and left no reply, so the screen can say so and offer it again.
     *
     * `runStatus` cannot carry this: it is read from the *active* run, and a failed run stops
     * being active the moment it fails. Silence then looks the same as never having asked.
     */
    lastFailure: z
      .object({
        turnId: TurnIdSchema,
        status: WorldChatRunStatusSchema,
        /** Operator-safe; never carries message, candidate or world content. */
        detail: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
    /**
     * The conversation's own attachments, as chips need them.
     *
     * `readability` travels because the chip has to be honest about it: an image can be attached
     * and referred to but never quoted, and a chip that looked the same as a readable document
     * would imply the Studio had read it (§13.2).
     */
    attachments: z
      .array(
        z
          .object({
            id: ChatAttachmentIdSchema,
            fileName: z.string().min(1).max(255),
            kind: z.enum(["document", "image", "audio", "video", "other"]),
            readability: z.enum(["text-readable", "not-readable", "extracted-text-available"]),
            promoted: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    /** What could not be checked, stated rather than hidden (§9.4). */
    retrievalUnavailable: z.boolean().default(false),
  })
  .strict();
export type WorldChatWorkspace = z.infer<typeof WorldChatWorkspaceSchema>;

// ---------------------------------------------------------------------------
// The result shape, as the model is told it (#70 §8.3)
// ---------------------------------------------------------------------------

/**
 * Worked examples of everything a turn result may contain, beside the schemas they must satisfy.
 *
 * These exist because the first live turn of World Chat failed, twice, deterministically: the
 * brief described the envelope and left the model to guess field names, and the strict schemas
 * reject a guess. The examples are the other half of the contract — the brief renders them into
 * the prompt via `worldChatResultShapeGuide`, and `satisfies` plus the drift tests hold them to
 * the schemas, so the shape the model is shown cannot quietly stop being the shape we accept.
 *
 * The ids are real-shaped and deliberately memorable-nonsense: a model that copies one verbatim
 * instead of using an id from its context produces evidence that fails verification, which is
 * the failure we can diagnose, rather than a schema failure, which stalled the whole feature.
 */
const EXAMPLE_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const exampleMessageEvidence = {
  kind: "message",
  messageId: `msg_${EXAMPLE_ULID}`,
  quote: "Her aunt raised her, not her mother.",
  start: 0,
  end: 36,
  purpose: "intent",
} satisfies CandidateEvidence;

const exampleWorldEvidence = {
  kind: "world",
  ref: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
  observedVersion: 4,
  contentHash: "sha256:3b7daae90a80",
  field: "Essence",
  quote: "keeper of the drowned verse",
  purpose: "supports",
} satisfies CandidateEvidence;

const exampleAttachmentEvidence = {
  kind: "attachment",
  attachmentId: `wca_${EXAMPLE_ULID}`,
  contentHash: "sha256:2d76945ae1c8",
  quote: "the bells only ring at slack water",
  line: 12,
  purpose: "supports",
} satisfies CandidateEvidence;

const exampleCanonCreateDraft = {
  classification: "canon.create",
  title: "Maren was raised by her aunt",
  rationale: "Stated directly, as settled fact.",
  settledness: "settled",
  evidence: [exampleMessageEvidence],
  checkReceiptIds: [`check_${EXAMPLE_ULID}`],
  draft: {
    type: "lore",
    title: "Maren's upbringing",
    statement: "Maren Kest was raised by her aunt, not her mother.",
    links: [],
  },
} satisfies ModelCandidateDraft;

const exampleDrafts = {
  "canon.create": exampleCanonCreateDraft,
  "canon.amend": {
    classification: "canon.amend",
    target: { kind: "canon", entryId: "CANON-012" },
    title: "The bells ring at slack water, not at dusk",
    rationale: "They corrected the earlier timing.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: { statement: "The harbour bells ring only at slack water." },
  },
  "canon.thread": {
    classification: "canon.thread",
    title: "Who tends the bells?",
    rationale: "Raised but not decided.",
    settledness: "unresolved",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      title: "Bell-tending",
      question: "Who tends the harbour bells, and what does it cost them?",
      consideredEntryIds: ["CANON-012"],
    },
  },
  "sheet.create": {
    classification: "sheet.create",
    title: "Maren's aunt becomes a character",
    rationale: "Named as the person who raised her.",
    settledness: "tentative",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      type: "character",
      name: "Sera Kest",
      role: "Tide-caller",
      canonRules: [],
      links: [],
      sections: [{ heading: "Essence", body: "The aunt who raised Maren after the drowning year." }],
    },
  },
  "sheet.edit": {
    classification: "sheet.edit",
    target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
    title: "Maren's upbringing moves into her sheet",
    rationale: "Her history section should carry it.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      sections: [{ heading: "History", body: "Raised by her aunt Sera after the drowning year." }],
    },
  },
  "relationship.change": {
    classification: "relationship.change",
    title: "Maren and Sera are family",
    rationale: "The upbringing implies the tie.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      from: { kind: "sheet", sheetId: "maren-kest" },
      to: { kind: "sheet", sheetId: "sera-kest" },
      linkAction: "add",
      proseEdits: [
        {
          sheet: { kind: "sheet", sheetId: "maren-kest" },
          sectionHeading: "Ties",
          body: "Sera Kest, the aunt who raised her.",
          reason: "The new tie needs a line in her sheet.",
        },
      ],
    },
  },
  "media.image-opportunity": {
    classification: "media.image-opportunity",
    title: "Maren at the slack-water bells",
    rationale: "The scene they described wants an image.",
    settledness: "tentative",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
      purpose: "character-look",
      brief: "Maren at the harbour rail at slack water, bells above her, late light.",
      reason: "The conversation settled her look; an image would hold it.",
      dependencies: [],
    },
  },
  undecided: {
    classification: "undecided",
    title: "The drowning year needs a home",
    rationale: "Mentioned twice, never placed.",
    settledness: "unresolved",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      question: "Is the drowning year a canon event, or one character's history?",
      plausibleActions: ["canon.create", "sheet.edit"],
      possibleTargets: [{ kind: "sheet", sheetKind: "character", sheetId: "maren-kest" }],
    },
  },
} satisfies Record<WorldChangeClassification, ModelCandidateDraft>;

const exampleOperations = {
  create: { op: "create", temporaryId: "t1", candidate: exampleCanonCreateDraft },
  update: {
    op: "update",
    candidateId: `cand_${EXAMPLE_ULID}`,
    expectedRevision: 2,
    candidate: exampleDrafts["canon.amend"],
  },
  withdraw: {
    op: "withdraw",
    candidateId: `cand_${EXAMPLE_ULID}`,
    expectedRevision: 2,
    reason: "They took it back.",
  },
  split: {
    op: "split",
    candidateId: `cand_${EXAMPLE_ULID}`,
    expectedRevision: 2,
    replacements: [exampleDrafts["canon.create"], exampleDrafts["canon.thread"]],
  },
} satisfies Record<string, ModelCandidateOperation>;

const exampleTurnResult = {
  reply:
    "Noted — her aunt raised her, and I've kept the question of who tends the bells open until you decide.",
  candidateOperations: [
    { op: "create", temporaryId: "t1", candidate: exampleDrafts["canon.create"] },
    { op: "create", temporaryId: "t2", candidate: exampleDrafts["canon.thread"] },
  ],
  groupOperations: [],
} satisfies WorldChatTurnResult;

const exampleGroupOperation = {
  op: "create",
  temporaryId: "g1",
  title: "Maren's upbringing lands together",
  rationale: "The fact and the sheet edit describe one change.",
  members: [{ temporaryId: "t1" }, { temporaryId: "t2" }],
} satisfies ModelGroupOperation;

/** Exported for the drift tests, which hold every example to the schema it claims to satisfy. */
export const WORLD_CHAT_SHAPE_EXAMPLES = {
  evidence: {
    message: exampleMessageEvidence,
    world: exampleWorldEvidence,
    attachment: exampleAttachmentEvidence,
  },
  drafts: exampleDrafts,
  operations: exampleOperations,
  groupOperation: exampleGroupOperation,
  turnResult: exampleTurnResult,
} as const;

/** One classification's payload line: what sits beside the common fields, shown as real JSON. */
function draftPayloadLine(classification: WorldChangeClassification): string {
  const example = exampleDrafts[classification] as ModelCandidateDraft & { target?: unknown };
  const payload = {
    classification,
    ...(example.target !== undefined ? { target: example.target } : {}),
    draft: example.draft,
  };
  return JSON.stringify(payload);
}

const DRAFT_PAYLOADS = {
  "canon.create": CanonCreatePayload,
  "canon.amend": CanonAmendPayload,
  "canon.thread": CanonThreadPayload,
  "sheet.create": SheetCreatePayload,
  "sheet.edit": SheetEditPayload,
  "relationship.change": RelationshipChangePayload,
  "media.image-opportunity": ImageOpportunityPayload,
  undecided: UndecidedPayload,
} as const satisfies Record<WorldChangeClassification, { draft: z.ZodTypeAny }>;

/** The object under a draft schema, past any `.refine()` wrapping it. */
function draftObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null {
  let inner = schema;
  while (inner instanceof z.ZodEffects) inner = inner.innerType();
  return inner instanceof z.ZodObject ? inner : null;
}

/** An object shape as a short signature: `{kind:"canon", entryId}`. */
function shapeSignature(schema: z.ZodTypeAny): string {
  const object = draftObject(schema);
  if (!object) return "value";
  const keys = Object.entries(object.shape).map(([key, field]) =>
    field instanceof z.ZodLiteral ? `${key}:${JSON.stringify(field.value)}` : key,
  );
  return `{${keys.join(", ")}}`;
}

/**
 * One field, described from its own schema.
 *
 * The examples show a shape; this says what else that shape may contain. One instance cannot:
 * the `sheet.edit` example happens to carry `sections`, so a model asked to rename a sheet or
 * clear its role learns nothing from it and has to guess a field name — which is the
 * whole-turn rejection this guide exists to prevent, one level further in.
 */
function unwrapField(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; nullable: boolean } {
  let inner = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    if (inner instanceof z.ZodOptional) {
      optional = true;
      inner = inner.unwrap();
      continue;
    }
    if (inner instanceof z.ZodNullable) {
      nullable = true;
      inner = inner.unwrap();
      continue;
    }
    break;
  }
  return { inner, optional, nullable };
}

/** The type alone, with no "optional" tail — so it can be nested inside "array of …". */
function fieldType(schema: z.ZodTypeAny): string {
  const { inner } = unwrapField(schema);
  if (inner instanceof z.ZodEnum) return (inner.options as string[]).map((o) => JSON.stringify(o)).join(" | ");
  if (inner instanceof z.ZodLiteral) return JSON.stringify(inner.value);
  if (inner instanceof z.ZodString) return "string";
  if (inner instanceof z.ZodNumber) return "number";
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodArray) return `array of ${fieldType(inner.element)}`;
  if (inner instanceof z.ZodUnion) {
    return (inner.options as z.ZodTypeAny[]).map(shapeSignature).join(" or ");
  }
  if (inner instanceof z.ZodObject) return shapeSignature(inner);
  return "value";
}

function describeField(schema: z.ZodTypeAny): string {
  const { optional, nullable } = unwrapField(schema);
  return `${fieldType(schema)}${nullable ? ", or null to clear it" : ""}${optional ? ", optional" : ""}`;
}

/** Every field a classification's draft accepts, not only the ones its example happens to use. */
function draftFieldCatalogue(classification: WorldChangeClassification): string {
  const object = draftObject(DRAFT_PAYLOADS[classification].draft);
  if (!object) return "";
  return Object.entries(object.shape)
    .map(([key, field]) => `${key} (${describeField(field as z.ZodTypeAny)})`)
    .join("; ");
}

/**
 * The result shape as the model is told it, rendered from the same objects the tests validate.
 *
 * Written into the world-builder prompt by the adapter, after the brief and beyond the reach of
 * any Settings override — the shape is what the coordinator accepts, not a preference. Every JSON
 * line in here is an example object from above, so a schema change that invalidates one fails
 * compilation and the drift tests before it can reach a prompt.
 */
export function worldChatResultShapeGuide(): string {
  return `## The result shape, exactly

Return one JSON object and nothing else — no prose around it, no markdown fences:

{"reply": "...", "candidateOperations": [...], "groupOperations": [...]}

reply is plain prose for the person (at most ${TURN_RESULT_BOUNDS.reply} characters). candidateOperations holds at most ${TURN_RESULT_BOUNDS.candidateOperations} operations, groupOperations at most ${TURN_RESULT_BOUNDS.groupOperations}; both are [] when there is nothing to record.

A complete result:
${JSON.stringify(exampleTurnResult, null, 1)}

### Candidate operations

op is one of create | update | withdraw | split.

- update: ${JSON.stringify(exampleOperations.update)}
- withdraw: ${JSON.stringify(exampleOperations.withdraw)}
- split: ${JSON.stringify(exampleOperations.split)}
  (replacements holds at least two complete candidates, each shaped exactly like create's)

candidateId and expectedRevision come from "What you have already understood" — the registry lists each as [cand_... rN]. temporaryId is yours to invent ("t1", "t2", ...) and only means anything inside this one result.

### Every candidate

{"classification": ..., "title": ..., "rationale": ..., "settledness": ..., "evidence": [...], "checkReceiptIds": [...], ...}

- classification: one of ${WorldChangeClassificationSchema.options.join(" | ")}
- title: one plain sentence in the user's register. rationale: one or two more if needed.
- settledness: one of ${SettlednessSchema.options.join(" | ")}
- checkReceiptIds: the checkReceiptId values from the citation blocks of arke-world calls you made this turn; [] when you made none. Never invent one and never carry one over from an earlier turn — a receipt from another turn is refused.

### The payload each classification requires

Each classification below shows one complete example, then every field its draft accepts — the example is one instance, not the limit of what you may send. A field marked optional may be left out; one marked "or null to clear it" may be set to null to remove what is there. No other field is accepted, and one unknown field rejects the whole turn.

- ${draftPayloadLine("canon.create")}
  fields: ${draftFieldCatalogue("canon.create")}
- ${draftPayloadLine("canon.amend")}
  target names the entry being amended; the draft carries only what changes, and must carry at least one thing.
  fields: ${draftFieldCatalogue("canon.amend")}
- ${draftPayloadLine("canon.thread")}
  fields: ${draftFieldCatalogue("canon.thread")}
- ${draftPayloadLine("sheet.create")}
  fields: ${draftFieldCatalogue("sheet.create")}
- ${draftPayloadLine("sheet.edit")}
  target names the sheet; the draft carries only what changes. A sheet's version, status, retirement and voice are deliberately absent — those have their own workflows and cannot be reached from here.
  fields: ${draftFieldCatalogue("sheet.edit")}
- ${draftPayloadLine("relationship.change")}
  proseEdits carries the complete new body of each section it touches, never an instruction to append.
  fields: ${draftFieldCatalogue("relationship.change")}
- ${draftPayloadLine("media.image-opportunity")}
  fields: ${draftFieldCatalogue("media.image-opportunity")}
- ${draftPayloadLine("undecided")}
  fields: ${draftFieldCatalogue("undecided")}

### Evidence

EVERY candidate must cite at least one message quotation with "purpose": "intent" — the words in which they asked for it. That one is required and no other kind substitutes for it: a candidate without it is rejected now, and would be dropped at wrap-up even if it were not. Anything else is supporting evidence, added beside it.

The required intent quotation:
${JSON.stringify(exampleMessageEvidence)}
- messageId is a user message's id, shown in brackets beside their words — [msg_...]. Never invent one, and never cite your own replies: your lines carry no id because nothing you said is evidence of what they want.
- start and end are 0-based offsets into that message's text alone (never into this prompt), end exclusive, counted in UTF-16 code units — the units JavaScript's string indexing uses, in which an emoji or other non-BMP character counts as two, not one. Get the quote exactly right and a small miscount is forgiven; get the quote wrong and the turn is not.
- purpose is one of ${MessageEvidencePurposeSchema.options.join(" | ")}. Use "intent" for the ask itself, "settledness" for the words that decided it, "correction" for the words that changed it.

Supporting evidence — the world (only something you read through the arke-world tools this turn):
${JSON.stringify(exampleWorldEvidence)}
- Every arke-world result comes with a second block: {"checkReceiptId": "check_...", "citable": [{"ref": ..., "observedVersion": N, "contentHash": "sha256:..."}]}. Copy ref, observedVersion and contentHash from there, exactly. If a read returned no citable entry, you did not read anything you may quote.
- purpose is one of ${WorldEvidencePurposeSchema.options.join(" | ")}

Supporting evidence — an attachment you were handed:
${JSON.stringify(exampleAttachmentEvidence)}
- attachmentId and contentHash are printed with the document under "What they handed you". Copy both exactly; do not guess either.

### Group operations

A group says "these land together or not at all". members has at least two entries, each {"temporaryId": "..."} or {"candidateId": "cand_...", "revision": N}.

${JSON.stringify(exampleGroupOperation)}

update and withdraw name the group instead: {"op": "update", "groupId": "grp_...", "expectedRevision": N, ...} with the same title, rationale and members; {"op": "withdraw", "groupId": "grp_...", "expectedRevision": N, "reason": "..."}.`;
}
