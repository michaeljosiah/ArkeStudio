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
export const CandidateEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      messageId: MessageIdSchema,
      quote: z.string().min(1).max(2000),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      purpose: z.enum(["intent", "settledness", "correction"]),
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
      purpose: z.enum(["supports", "amendment-target", "duplicate", "context"]),
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

const RelationshipChangePayload = {
  classification: z.literal("relationship.change"),
  draft: z
    .object({
      from: WorldChatLinkRefSchema,
      to: WorldChatLinkRefSchema,
      linkAction: z.enum(["add", "remove", "unchanged"]),
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

const ImageOpportunityPayload = {
  classification: z.literal("media.image-opportunity"),
  draft: z
    .object({
      target: WorldChatEntityRefSchema,
      purpose: z.enum(["world-key-art", "character-main-photo", "character-look"]),
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
      notCarried: z.array(
        z
          .object({
            candidateId: CandidateIdSchema,
            summary: z.string().min(1).max(300),
            reason: z.enum(["tentative", "undecided", "target-missing", "invalid"]),
          })
          .strict(),
      ),
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
    summary: z.string().max(8000).optional(),
    proposalIds: z.array(ProposalIdSchema),
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
export const WorldChatTurnResultSchema = z
  .object({
    reply: z.string().max(8000),
    candidateOperations: z.array(ModelCandidateOperationSchema).max(12),
    groupOperations: z.array(ModelGroupOperationSchema).max(6),
  })
  .strict();
export type WorldChatTurnResult = z.infer<typeof WorldChatTurnResultSchema>;
