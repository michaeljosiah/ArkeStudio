import { z } from "zod";
import {
  ArtifactIdSchema,
  CandidateGroupIdSchema,
  CandidateIdSchema,
  CanonIdSchema,
  ChatAttachmentIdSchema,
  ChatEventIdSchema,
  CheckReceiptIdSchema,
  ConversationIdSchema,
  ConversationActionIdSchema,
  EpisodeIdSchema,
  FrameRunIdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  SceneIdSchema,
  SessionIdSchema,
  Sha256Schema,
  ShotIdSchema,
  SlugSchema,
  TakeIdSchema,
  TurnIdSchema,
} from "./ids.js";
import { BIBLE_EDIT_BOUNDS, BibleEditRecordSchema, BibleEditSchema, type BibleEdit } from "./bible.js";
import {
  EDITOR_REQUEST_BOUNDS,
  ModelEditorRequestSchema,
  ModelSceneEditSchema,
  SCENE_EDIT_BOUNDS,
  type ModelEditorRequest,
  type ModelSceneEdit,
} from "./editor-request.js";
import { ShotAudioSchema, ShotFramingSchema } from "./scene.js";
import { SHEET_SHAPES } from "./sheet-shapes.js";
import {
  ConversationActionBindingSchema,
  ConversationActionCardSchema,
  ConversationActionDecisionSchema,
  ConversationActionPrepareIntentSchema,
  ConversationActionReceiptSchema,
  ConversationActionStatusSchema,
  ConversationActionUndoLinkSchema,
} from "./arke-actions.js";

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
  "pending-actions",
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
  /**
   * Production scopes (SPEC-023 R-20, issue #400): the Development thread enters at the
   * production, an episode thread at one episode, a scene thread at one scene. Same store, same
   * events, same wrap-up — only the entry context and the candidates differ.
   */
  z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
  z
    .object({ kind: z.literal("episode"), productionId: SlugSchema, episodeId: EpisodeIdSchema })
    .strict(),
  z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: SceneIdSchema }).strict(),
]);
export type WorldChatContext = z.infer<typeof WorldChatContextSchema>;

/**
 * The conversation's initiative mode (Scope §04; SPEC-023 R-21): how eagerly the studio
 * proposes. Assist waits to be asked, Collaborate offers as it goes, Develop drives. The mode
 * changes initiative, never acceptance authority — wrap-up and the gate are identical in all
 * three.
 */
export const WorldChatInitiativeSchema = z.enum(["assist", "collaborate", "develop"]);
export type WorldChatInitiative = z.infer<typeof WorldChatInitiativeSchema>;

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
  /*
   * The production records a conversation can be about (SPEC-023 R-20). A proposition's subject
   * is its own target, so these must be exactly the `target` shapes the `development.*` payloads
   * declare below — a season names its production, an episode names itself, a scene names itself,
   * a series names itself.
   *
   * They were missing until 2026-08-21, which meant every `development.*` proposition the studio
   * made was rejected when it was written: `subjectOf` returns the draft's target under a cast,
   * so a target this union does not admit produced a candidate that failed its own schema. Found
   * by driving a season conversation in the installed app — the failure was reachable no other
   * way, because the propositions this breaks are the only ones a production thread can make.
   */
  z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
  z
    .object({ kind: z.literal("episode"), productionId: SlugSchema, episodeId: EpisodeIdSchema.optional() })
    .strict(),
  z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: SceneIdSchema }).strict(),
  /** A shot inside a scene; `shotId` absent means the shot this proposition would add. */
  z
    .object({
      kind: z.literal("shot"),
      productionId: SlugSchema,
      sceneId: SceneIdSchema,
      shotId: ShotIdSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("series"), seriesId: SlugSchema }).strict(),
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

/**
 * The harness tools a turn asked for and was refused, by name, deduplicated (SPEC-005 R-10b).
 *
 * Names, not sentences, and not the adapter's own summary. The name is what survives a change of
 * wording, and the wording is the coordinator's to choose — R-16 forbids showing a harness tool
 * name to a person and #70 R-18 forbids rendering an adapter summary at all, so a refusal reaches
 * the screen only through `refusalLabel`.
 *
 * Recorded at all because a refusal is the one piece of a turn that contradicts the answer. An
 * agent that reported running a shell command it never ran (#506) was believed because nothing
 * else on the screen had anything to say about it.
 */
/** Enough to show a turn reached for several different things; a bound, not an expectation. */
export const REFUSED_TOOLS_MAX = 20;
export const RefusedToolsSchema = z.array(z.string().min(1).max(120)).max(REFUSED_TOOLS_MAX);

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
  /** Reading a page from the web, kept as an attachment so its quotes stay checkable. */
  "fetch-url",
  /*
   * The production read (round 3, 2026-08-22): an episode thread asked for its season and got
   * nothing back, because no tool served production records at all — the model was briefed on
   * the shape and blind to the direction. Widening the enum keeps every stored receipt readable.
   */
  "get-production",
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
    /**
     * The world look this proposition was drafted against, for the one classification that
     * replaces it whole (§6.2).
     *
     * An `art-direction.change` carries the entire description, so it is only safe to write while
     * the look it was written from is still the look on disk. Without this the draft would be
     * materialised against whatever is current at wrap-up and staged with that as its base — not
     * stale by any test the gate applies, and silently replacing an edit made in between.
     */
    basedOnArtDirectionVersion: z.number().int().min(1).optional(),
    /**
     * The same look, identified by its words rather than its number.
     *
     * The version is not enough on its own. A world with no art-direction file still has a look,
     * derived from its name, tone, genre and logline, and that derivation is always v1 — so
     * editing the world's tone rewrites the description every image is generated from while the
     * number stays where it was, and a draft pinned only to the number passes every staleness test
     * and replaces words it was never shown.
     */
    basedOnArtDirectionLook: Sha256Schema.optional(),
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
  "art-direction.change",
  "media.image-opportunity",
  /** SPEC-023 R-20 (issue #400): production-scoped propositions for the Development layer. */
  "development.overview",
  "development.season",
  "development.episode",
  "development.scene-script",
  /**
   * A shot, changed by the conversation that is about it. Until this existed the scene thread
   * could describe a shot at length and then hand the person back to the storyboard to type it
   * in — the one place the workspace stopped being the conversation.
   */
  "development.shot",
  "development.series",
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

/**
 * The world's look, changed in words (#70 §6.2).
 *
 * Without this a conversation about the art style had nowhere to go. The nearest classification
 * was `canon.create`, so "let's make it painterly and Arcane-inspired" became a Canon entry
 * titled "Visual art direction" — true as lore, read by nothing that generates an image, and
 * indistinguishable from success. The studio agreed and wrote the wrong thing.
 *
 * Only the description is the model's to give. `masterLook` is a visual asset and a conversation
 * has none to offer; it is deliberately not carried over from the previous look either, because
 * an image of the look being replaced is not an illustration of the one replacing it.
 */
const ArtDirectionChangePayload = {
  classification: z.literal("art-direction.change"),
  draft: z
    .object({
      /** The whole look, as it should now read — never an instruction to adjust the old one. */
      description: z.string().trim().min(1).max(4000),
    })
    .strict(),
} as const;

export const MediaOpportunityMediumSchema = z.enum(["image", "video"]);
export type MediaOpportunityMedium = z.infer<typeof MediaOpportunityMediumSchema>;

export const MediaOpportunityPurposeSchema = z.enum([
  "world-key-art",
  "character-main-photo",
  "character-look",
  "concept-image",
  "concept-video",
  "shot-video",
]);
export type MediaOpportunityPurpose = z.infer<typeof MediaOpportunityPurposeSchema>;

const MediaOpportunityDraftSchema = z
  .object({
    /** Defaulted so image opportunities already persisted before video support still parse. */
    medium: MediaOpportunityMediumSchema.default("image"),
    target: WorldChatEntityRefSchema,
    purpose: MediaOpportunityPurposeSchema,
    brief: z.string().min(1).max(4000),
    reason: z.string().max(1000),
    dependencies: z.array(
      z.union([
        PendingRefSchema,
        z.object({ proposalId: ProposalIdSchema, targetPath: z.string().optional() }).strict(),
      ]),
    ),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const videoPurpose = draft.purpose === "concept-video" || draft.purpose === "shot-video";
    if (draft.medium === "video" && !videoPurpose) {
      ctx.addIssue({ code: "custom", path: ["purpose"], message: "a video needs a video purpose" });
    }
    if (draft.medium === "image" && videoPurpose) {
      ctx.addIssue({ code: "custom", path: ["purpose"], message: "an image needs an image purpose" });
    }
  });

const ImageOpportunityPayload = {
  classification: z.literal("media.image-opportunity"),
  draft: MediaOpportunityDraftSchema,
} as const;

/**
 * The Development payloads (SPEC-023 R-20, issue #400). Each draft is the record as it should
 * now read — never an instruction to adjust the old one — because the JSON gate lane merges and
 * conflicts at field level, and an instruction has nothing to merge. Season defaults are absent
 * on purpose: they are creation-time values a form owns, and a conversation must not be able to
 * retune an episode envelope by describing it.
 */
const DevelopmentOverviewPayload = {
  classification: z.literal("development.overview"),
  target: z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
  draft: z
    .object({
      logline: z.string().min(1).max(500).optional(),
      spine: z.string().min(1).max(4000).optional(),
      acts: z
        .array(z.object({ title: z.string().min(1).max(200), summary: z.string().max(1000).optional() }).strict())
        .max(12)
        .optional(),
      targetLength: z.string().min(1).max(120).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, "an overview draft must carry at least one field"),
} as const;

const DevelopmentSeasonPayload = {
  classification: z.literal("development.season"),
  target: z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
  draft: z
    .object({
      question: z.string().min(1).max(500).optional(),
      ending: z.string().min(1).max(1000).optional(),
      direction: z.string().min(1).max(2000).optional(),
      arcs: z
        .array(
          z
            .object({ id: SlugSchema, title: z.string().min(1).max(200), note: z.string().max(500).optional() })
            .strict(),
        )
        .max(20)
        .optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, "a season draft must carry at least one field"),
} as const;

const DevelopmentEpisodePayload = {
  classification: z.literal("development.episode"),
  target: z
    .object({
      kind: z.literal("episode"),
      productionId: SlugSchema,
      /** Absent to create a new episode; present to amend the one named. */
      episodeId: EpisodeIdSchema.optional(),
    })
    .strict(),
  draft: z
    .object({
      title: z.string().min(1).max(200).optional(),
      order: z.number().int().min(1).optional(),
      promise: z
        .object({
          opens: z.string().max(500).optional(),
          turn: z.string().max(500).optional(),
          closes: z.string().max(500).optional(),
        })
        .strict()
        .optional(),
      scenes: z.array(SceneIdSchema).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, "an episode draft must carry at least one field"),
} as const;

const ScriptBlockDraftSchema = z
  .object({
    id: z.string().regex(/^blk_[a-z0-9-]+$/, "expected blk_<slug>"),
    kind: z.enum(["action", "dialogue"]),
    speaker: SlugSchema.optional(),
    text: z.string().min(1).max(2000),
  })
  .strict();

const DevelopmentSceneScriptPayload = {
  classification: z.literal("development.scene-script"),
  target: z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: SceneIdSchema }).strict(),
  draft: z
    .object({
      /** The whole ordered block list as it should now read (SPEC-023 R-13). */
      blocks: z.array(ScriptBlockDraftSchema).min(1).max(200),
    })
    .strict(),
} as const;

/**
 * A shot as the conversation would have it read (SPEC-023 R-20; epic #242's lesson 8, "the
 * working document is the product").
 *
 * What is here is what a conversation legitimately settles: the words, the camera, the sound,
 * how long it runs, how it should feel. What is deliberately absent is everything that is not a
 * creative decision — `id` and `number` are identity and position, minted once and moved only by
 * the storyboard's drag; `covers` is a digest computed at citation time; and `promptOverride` is
 * production output whose whole meaning is that a person typed it in the sheet, so a proposition
 * writing one would forge that provenance.
 */
const ShotDraftSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    /** `@slug` mentions are live sheet references, resolved at prompt assembly. */
    description: z.string().max(4000).optional(),
    camera: z.string().max(600).optional(),
    audio: ShotAudioSchema.optional(),
    durationSec: z.number().positive().max(600).optional(),
    intent: z.string().max(600).optional(),
    beats: z
      .array(z.object({ span: z.string().min(1).max(40), text: z.string().min(1).max(400) }).strict())
      .max(20)
      .optional(),
    framing: ShotFramingSchema.optional(),
    continuity: z
      .object({
        openOnPrevious: z.boolean().optional(),
        // SPEC-019 R-50. Admitted here as well as on the screen because a story author writing a
        // scene is exactly who knows a shot carries straight on from the one before it, and a key
        // this strict object omits is not a dropped field — it refuses the whole turn.
        continuesPrevious: z.boolean().optional(),
        keepOut: z.string().max(600).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const DevelopmentShotPayload = {
  classification: z.literal("development.shot"),
  target: z
    .object({
      kind: z.literal("shot"),
      productionId: SlugSchema,
      sceneId: SceneIdSchema,
      /** Absent to add a shot at the end of the scene; present to amend the one named. */
      shotId: ShotIdSchema.optional(),
    })
    .strict(),
  /**
   * A new shot needs enough to be a shot: the schema requires a title and a description at
   * creation, because a shot with neither is a placeholder the storyboard already offers a
   * button for. An amendment may carry one field.
   */
  draft: ShotDraftSchema.refine((d) => Object.keys(d).length > 0, "a shot draft must carry at least one field"),
} as const;

const DevelopmentSeriesPayload = {
  classification: z.literal("development.series"),
  target: z.object({ kind: z.literal("series"), seriesId: SlugSchema }).strict(),
  draft: z
    .object({
      title: z.string().min(1).max(200).optional(),
      engine: z.string().min(1).max(2000).optional(),
      continuity: z.string().min(1).max(4000).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, "a series draft must carry at least one field"),
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

/** The fifteen things a proposition can be, as the coordinator stores them. */
export const WorldChangeCandidateSchema = z.discriminatedUnion("classification", [
  CandidateBaseSchema.extend(CanonCreatePayload).strict(),
  CandidateBaseSchema.extend(CanonAmendPayload).strict(),
  CandidateBaseSchema.extend(CanonThreadPayload).strict(),
  CandidateBaseSchema.extend(SheetCreatePayload).strict(),
  CandidateBaseSchema.extend(SheetEditPayload).strict(),
  CandidateBaseSchema.extend(RelationshipChangePayload).strict(),
  CandidateBaseSchema.extend(ArtDirectionChangePayload).strict(),
  CandidateBaseSchema.extend(ImageOpportunityPayload).strict(),
  CandidateBaseSchema.extend(DevelopmentOverviewPayload).strict(),
  CandidateBaseSchema.extend(DevelopmentSeasonPayload).strict(),
  CandidateBaseSchema.extend(DevelopmentEpisodePayload).strict(),
  CandidateBaseSchema.extend(DevelopmentSceneScriptPayload).strict(),
  CandidateBaseSchema.extend(DevelopmentShotPayload).strict(),
  CandidateBaseSchema.extend(DevelopmentSeriesPayload).strict(),
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
    /**
     * Where this came from, when it did not come from the person (2026-08-22).
     *
     * Research had to answer one question before it could exist: what IS a fetched page to a
     * system where every citation carries an observed version and a content hash? The answer is
     * that it is an attachment — the one thing here that is already hashed, already quotable and
     * already checkable months later, because the bytes were kept. So a page the studio reads
     * online is stored exactly like a document somebody dropped in, and this records the one
     * thing that differs: the address it was read from, and when.
     *
     * The web moves and this does not. A quotation stays verifiable against what was actually
     * read, not against whatever the page says today.
     */
    source: z
      .object({ url: z.string().url().max(2000), fetchedAt: IsoDateTimeSchema })
      .strict()
      .optional(),
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
    reason: z.enum([
      "tentative",
      "undecided",
      "target-missing",
      "invalid",
      "look-moved",
      "look-already-proposed",
      "role-too-long",
      "unknown-section",
      "changes-nothing",
    ]),
  })
  .strict();
export type WorldChatNotCarried = z.infer<typeof WorldChatNotCarriedSchema>;

export const BenchOutcomeReportSchema = z
  .object({
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    rows: z
      .array(
        z
          .object({
            shotId: ShotIdSchema,
            shotNumber: z.number().int().min(1),
            productionTakeId: TakeIdSchema,
            artifactId: ArtifactIdSchema.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type BenchOutcomeReport = z.infer<typeof BenchOutcomeReportSchema>;

/** The durable join from an Arke narration to the frame run whose live fold supplies its rows. */
export const FrameRunOutcomeReportSchema = z
  .object({
    runId: FrameRunIdSchema,
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
  })
  .strict();
export type FrameRunOutcomeReport = z.infer<typeof FrameRunOutcomeReportSchema>;

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
      initiative: WorldChatInitiativeSchema.optional(),
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
      /**
       * Tools this turn was refused, absent when there were none — which is almost every turn.
       *
       * Optional rather than defaulted, for the same reason `bibleEdit` is: every turn already on
       * disk was written without it, and a field that appears only when it has something to say
       * keeps the log readable.
       */
      refusedTools: RefusedToolsSchema.optional(),
      candidates: z.array(WorldChangeCandidateSchema),
      groups: z.array(CandidateGroupSchema),
      tombstones: z.array(CandidateTombstoneSchema),
      /** Defaults keep every turn written before SPEC-041 readable. */
      actionPrepareIntents: z.array(ConversationActionPrepareIntentSchema).optional(),
      /**
       * The Bible edit this turn landed, if it made one (master §4.5).
       *
       * Recorded with the reply for the same reason the propositions are: the reply says "I've
       * written that down", and a crash that kept the sentence but lost the record of which
       * version it produced would leave the conversation describing an edit nobody could find
       * or undo. The file itself is already committed by then — this is the pointer to it.
       */
      bibleEdit: BibleEditRecordSchema.optional(),
    })
    .strict(),
  /** A filing outcome narrated by Arke without pretending a model turn produced it. */
  z
    .object({
      type: z.literal("bench.outcome-recorded"),
      message: WorldChatMessageSchema,
      sessionId: SessionIdSchema,
      takeId: TakeIdSchema,
      report: BenchOutcomeReportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("frame-run.outcome-recorded"),
      message: WorldChatMessageSchema,
      report: FrameRunOutcomeReportSchema,
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
  z
    .object({
      type: z.literal("media.handoff-created"),
      candidateId: CandidateIdSchema,
      candidateRevision: z.number().int().min(1),
      sessionId: SessionIdSchema,
      medium: MediaOpportunityMediumSchema,
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
      /**
       * Proposals this attempt staged and then could not take back (R-42a).
       *
       * A failed wrap-up rolls its own staging back, and a discard that will not go leaves a
       * proposal on the approvals screen belonging to a conversation that says it created
       * nothing. This event is the only durable trace of it: the intent closes here, so startup
       * recovery — which reconciles by open intent — would otherwise never look. Absent on the
       * ordinary failure, where everything went.
       *
       * Each carries the propositions it was made from, rather than only its id. The proposal's
       * own manifest says the same thing, but recovery has to work in the case where that
       * manifest is gone and the log never learned what became of it — and without the
       * candidate ids there is no way to leave those propositions in an honest state.
       */
      leftovers: z
        .array(
          z
            .object({
              proposalId: ProposalIdSchema,
              candidateIds: z.array(CandidateIdSchema),
            })
            .strict(),
        )
        .optional(),
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
  /**
   * One point being written, from the moment it is decided until it has landed (#70, revised).
   *
   * A save was designed without a durable record: it stages at most a group, and a crash between
   * staging and accepting leaves what a waiting proposal already is. That reasoning covered the
   * proposal and nothing around it. Without a record, nothing can see a save in flight — so a
   * second window can delete the conversation while one is allocating, and the change lands in a
   * world whose conversation is gone; a crash after acceptance but before the resolution is
   * written leaves a point that is neither on the rail nor waiting anywhere; and recovery has
   * nothing to reconcile against. The pair costs one append each side and answers all three.
   */
  z
    .object({
      type: z.literal("save.intent-recorded"),
      requestId: z.string().min(1),
      candidateIds: z.array(CandidateIdSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("save.settled"),
      requestId: z.string().min(1),
      /** Empty when the save was refused before anything was staged. */
      proposalIds: z.array(ProposalIdSchema),
    })
    .strict(),
  z.object({ type: z.literal("deletion.intent-recorded"), requestId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("action.prepare-intent"), intent: ConversationActionPrepareIntentSchema }).strict(),
  z.object({ type: z.literal("action.prepared"), binding: ConversationActionBindingSchema }).strict(),
  z
    .object({
      type: z.literal("action.prepare-failed"),
      actionId: ConversationActionIdSchema,
      detail: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("action.decision-recorded"),
      actionId: ConversationActionIdSchema,
      decision: ConversationActionDecisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("action.status-changed"),
      actionId: ConversationActionIdSchema,
      expectedStatus: ConversationActionStatusSchema,
      status: ConversationActionStatusSchema,
      detail: z.string().min(1).max(1_000).optional(),
      receipt: ConversationActionReceiptSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("action.superseded"),
      actionId: ConversationActionIdSchema,
      supersededBy: ConversationActionIdSchema,
      detail: z.string().min(1).max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("action.undo-linked"),
      actionId: ConversationActionIdSchema,
      undo: ConversationActionUndoLinkSchema,
    })
    .strict(),
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
    initiative: WorldChatInitiativeSchema.optional(),
    /** Live propositions. Zero for a conversation that produced nothing. */
    pointCount: z.number().int().min(0),
    /** Proposals from its wrap-up that are still awaiting a decision. */
    openProposalCount: z.number().int().min(0),
    /** Cards still requiring attention or execution. Absent in pre-SPEC-041 snapshots. */
    pendingActionCount: z.number().int().min(0).optional(),
    reopened: z.boolean().optional(),
    /** What its wrap-up could not carry, so the approvals screen can say so. */
    notCarried: z.array(WorldChatNotCarriedSchema).default([]),
    /** Why deleting is refused for now (R-50). Absent when it can be deleted. */
    deletionBlock: WorldChatDeletionBlockSchema.optional(),
  })
  .strict();
export type WorldChatSummary = z.infer<typeof WorldChatSummarySchema>;

export const WorldChatMediaHandoffSchema = z
  .object({
    candidateRevision: z.number().int().min(1),
    sessionId: SessionIdSchema,
    medium: MediaOpportunityMediumSchema,
  })
  .strict();
export type WorldChatMediaHandoff = z.infer<typeof WorldChatMediaHandoffSchema>;

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
    initiative: WorldChatInitiativeSchema.optional(),
    seq: z.number().int().min(0),
    /** Set when a sent-back proposal reopened this conversation. Survives checkpointing. */
    reopened: z.boolean().optional(),
    messages: z.array(WorldChatMessageSchema),
    /** True when older messages exist before `messages[0]`. */
    hasMore: z.boolean(),
    candidates: z.array(WorldChangeCandidateSchema),
    actions: z.array(ConversationActionCardSchema).default([]),
    /** Bench sessions prepared from media candidates, keyed by candidate id. */
    mediaHandoffs: z.record(CandidateIdSchema, WorldChatMediaHandoffSchema).default({}),
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
    /**
     * Bible edits this conversation made, by the studio message that made them (master §4.5).
     *
     * A map rather than a field on the message, because the message is the durable record of
     * what was *said* and this is a record of what was *done* to a file outside the conversation.
     * Folding them together would put a pointer to world state inside the transcript, and the
     * transcript is the one thing here that never holds any.
     */
    bibleEdits: z.record(MessageIdSchema, BibleEditRecordSchema).default({}),
    /**
     * Tools each studio reply was refused, by the message that was written despite them.
     *
     * A map for the same reason `bibleEdits` is one, pointing the other way: this is a record of
     * what did NOT happen, and it belongs beside the sentence that may claim otherwise.
     */
    refusals: z.record(MessageIdSchema, RefusedToolsSchema).default({}),
    /** Production filing rows, by the narration message they sit beside. */
    benchOutcomes: z.record(MessageIdSchema, BenchOutcomeReportSchema).default({}),
    /** Frame-run anchors, by narration message; report rows are joined from live frameRuns. */
    frameRunOutcomes: z.record(MessageIdSchema, FrameRunOutcomeReportSchema).default({}),
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
  ModelCandidateCommonSchema.extend(ArtDirectionChangePayload).strict(),
  ModelCandidateCommonSchema.extend(ImageOpportunityPayload).strict(),
  ModelCandidateCommonSchema.extend(DevelopmentOverviewPayload).strict(),
  ModelCandidateCommonSchema.extend(DevelopmentSeasonPayload).strict(),
  ModelCandidateCommonSchema.extend(DevelopmentEpisodePayload).strict(),
  ModelCandidateCommonSchema.extend(DevelopmentSceneScriptPayload).strict(),
  ModelCandidateCommonSchema.extend(DevelopmentShotPayload).strict(),
  ModelCandidateCommonSchema.extend(DevelopmentSeriesPayload).strict(),
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
    /**
     * Edits to the author's Bible, applied by the coordinator when the turn lands (master §4.5).
     *
     * Here rather than on the retrieval tool surface, which is read-only by contract (#70 §9.2)
     * and confines the harness to its scratch directory (§18.3). Both stay true: the model
     * describes the edit, the coordinator performs it, and the one path that writes the file is
     * also the path that versions and snapshots it.
     *
     * Defaulted rather than required, so a turn that touches nothing may omit it entirely.
     */
    bibleEdits: z.array(BibleEditSchema).max(BIBLE_EDIT_BOUNDS.edits).default([]),
    /**
     * Editor requests this turn stages (SPEC-039 R-27, issue 684): exact timeline commands the
     * coordinator validates against the live base and writes as pending records. The reply is
     * prose about them; the record is what a person accepts or rejects. Defaulted like the bible
     * edits, so a turn that asks for nothing omits it.
     */
    editorRequests: z.array(ModelEditorRequestSchema).max(EDITOR_REQUEST_BOUNDS.perTurn).default([]),
    /**
     * Scene edits this turn makes (SPEC-036 R-38): a rename the coordinator lands at once
     * through the header's own version-fenced write, with no card — a title is a label, and the
     * person is looking at it. Only in a scene thread. Defaulted like the others.
     */
    sceneEdits: z.array(ModelSceneEditSchema).max(SCENE_EDIT_BOUNDS.perTurn).default([]),
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
    /**
     * The revision this point is showing.
     *
     * Sent back when it is saved or rejected, so a point corrected by talking since is refused
     * rather than written as it was — the same guard wrap-up applies to the whole conversation,
     * at the size a single decision now works on.
     */
    revision: z.number().int().min(1),
    /**
     * Set when this point lands together with others.
     *
     * Saving or rejecting one of these acts on all of them, so the rail has to know which points
     * share a fate before it offers a decision on any of them.
     */
    groupId: z.string().min(1).optional(),
    /** Present only for a media opportunity; the client may offer this reviewed handoff. */
    media: z
      .object({
        medium: MediaOpportunityMediumSchema,
        purpose: MediaOpportunityPurposeSchema,
        brief: z.string().min(1).max(4000),
        reason: z.string().max(1000),
        sessionId: SessionIdSchema.optional(),
        blockedReason: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorldChatPoint = z.infer<typeof WorldChatPointSchema>;

export const WorldChatTranscriptMessageSchema = z
  .object({
    id: MessageIdSchema,
    /** Present on current projections so a durable card can remain beside the turn that made it. */
    turnId: TurnIdSchema.optional(),
    role: z.enum(["user", "studio"]),
    text: z.string(),
    /** Persisted receipts, already worded for a person: "read Maren Kest v4". */
    receipts: z.array(z.string().max(200)),
    /**
     * What this turn tried to do and was refused, worded for a person: "run a command on your
     * computer". Empty on almost every turn.
     *
     * Beside the reply rather than in the working line, because the working line is gone by the
     * time the reply is read — and the reply is the thing it contradicts (#506).
     */
    refusals: z.array(z.string().max(200)).default([]),
    /**
     * The Bible edit this reply made, if it made one (master §4.5).
     *
     * Beside the message rather than in the understanding rail, and that placement is the point.
     * The rail holds propositions, which are waiting for a yes; this already happened. Putting
     * them together would make "I changed your bible" and "I propose changing Canon" read as the
     * same kind of offer, and only one of them is an offer at all.
     */
    bibleEdit: BibleEditRecordSchema.optional(),
    benchOutcome: BenchOutcomeReportSchema.optional(),
    frameRunOutcome: FrameRunOutcomeReportSchema.optional(),
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
    initiative: WorldChatInitiativeSchema.default("collaborate"),
    messages: z.array(WorldChatTranscriptMessageSchema),
    /** True when older messages exist before the first one here. */
    hasMore: z.boolean().default(false),
    points: z.array(WorldChatPointSchema),
    actions: z.array(ConversationActionCardSchema).default([]),
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
      /*
       * A heading this kind of sheet actually has.
       *
       * It read "History" until 2026-08-23, and a character sheet has no History. `sheetBody`
       * writes the shape's headings and only those, so a section under any other one was set on
       * the map and never read — the proposition was materialised, staged, accepted, versioned
       * and change-logged, and the sheet afterwards said exactly what it had said before. The
       * example is the shape most models copy, so this one taught the failure.
       */
      sections: [{ heading: "Relationships", body: "Raised by her aunt Sera after the drowning year." }],
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
  "art-direction.change": {
    classification: "art-direction.change",
    title: "The world takes a painterly, hand-animated look",
    rationale: "They asked for the art style itself to change, not for a note about it.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      description:
        "Painterly and hand-animated: visible brushwork, sculpted faces, dramatic key light and bold colour scripting, with salt-bleached harbour tones.",
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
      medium: "image",
      target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
      purpose: "character-look",
      brief: "Maren at the harbour rail at slack water, bells above her, late light.",
      reason: "The conversation settled her look; an image would hold it.",
      dependencies: [],
    },
  },
  "development.overview": {
    classification: "development.overview",
    target: { kind: "production", productionId: "saltlight" },
    title: "The overview finds its spine",
    rationale: "The logline and spine were settled in this thread.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      logline: "One night on the Vigil, the verse rises early.",
      spine: "The watch answers the water, and the water answers back.",
    },
  },
  "development.season": {
    classification: "development.season",
    target: { kind: "production", productionId: "bell-watch-season-1" },
    title: "The season question is who answers",
    rationale: "The question and ending separated from the Series engine.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      question: "Who is ringing the drowned bell?",
      ending: "Maren answers the bell herself, from under the water.",
    },
  },
  "development.episode": {
    classification: "development.episode",
    target: { kind: "episode", productionId: "bell-watch-season-1" },
    title: "Episode three: the missing night",
    rationale: "The promise was agreed; the scenes come from this thread.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      title: "The missing night",
      order: 3,
      promise: { opens: "The ledger page for the 14th is gone.", closes: "The bell rings once, from under the water." },
    },
  },
  "development.scene-script": {
    classification: "development.scene-script",
    target: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" },
    title: "The verse rises gets its blocks",
    rationale: "The action and the one line were settled here.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      blocks: [
        { id: "blk_the-empty-page", kind: "action", text: "Maren opens the ledger to the 14th." },
        { id: "blk_at-bells", kind: "dialogue", speaker: "maren-kest", text: "That page was here at bells." },
      ],
    },
  },
  "development.shot": {
    classification: "development.shot",
    target: { kind: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" },
    title: "Maren holds the rail a beat longer",
    rationale: "They asked for the pause before she looks up; the rest of the shot stands.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: {
      description: "@maren-kest grips the rail of @the-vigil and does not look up for a long moment.",
      durationSec: 6,
      intent: "Held, not slow — she is deciding whether to have heard it.",
    },
  },
  "development.series": {
    classification: "development.series",
    target: { kind: "series", seriesId: "bell-watch" },
    title: "The engine is the nightly answer",
    rationale: "Season two needs it stated once, on the Series.",
    settledness: "settled",
    evidence: [exampleMessageEvidence],
    checkReceiptIds: [],
    draft: { engine: "Every episode, the night watch answers one bell it should not have heard." },
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

/**
 * The example is the strongest instruction in this prompt, so it demonstrates the voice rather
 * than the shape alone: a reaction, a weighed choice with a recommendation, something offered
 * that was not asked for, and one question that would actually unblock the next turn. An
 * acknowledgement here — "noted", "I've recorded that" — teaches the model to file and say
 * nothing, which is what it did (2026-08-22).
 */
const exampleTurnResult = {
  reply:
    "The aunt raising her is the better version, and it costs you nothing you had — a guardian who chose the job is sentimental, and one who inherited it resents the child in front of her without ever being a villain about it. Worth knowing which way you want the bells to go, though, because the two answers pull the story apart. If the aunt tends them, the child grows up inside the ritual and the loss is hers to carry; if the town rotates the duty, the aunt is one more person who shows up when it is her week, and the bells stay bigger than the family. I would take the second — it keeps the harbour a place rather than a household. Either way there is a scene in the first time she is left to ring them alone. Who taught her the count?",
  candidateOperations: [
    { op: "create", temporaryId: "t1", candidate: exampleDrafts["canon.create"] },
    { op: "create", temporaryId: "t2", candidate: exampleDrafts["canon.thread"] },
  ],
  groupOperations: [],
  bibleEdits: [],
  editorRequests: [],
  sceneEdits: [],
} satisfies WorldChatTurnResult;

/** Shaped exactly as the coordinator accepts it; the guide prints this object (issue 684). */
const exampleEditorRequest = {
  summary: "Swap the two harbour shots and tighten the bell close-up by half a second",
  commands: [
    { kind: "move-to-order", clipId: "cl_harbour-wide", index: 0 },
    { kind: "trim", clipId: "cl_bell-close", edge: "end", deltaFrames: -12 },
  ],
} satisfies ModelEditorRequest;

/** Shaped exactly as the coordinator accepts it (SPEC-036 R-38). */
const exampleSceneEdit = { kind: "rename", title: "The tide answers" } satisfies ModelSceneEdit;

const exampleBibleEdits = {
  "set-section": {
    op: "set-section",
    heading: "The tides",
    text: "The tide is the world's clock and its accountant. Nothing in the harbour is owed on a day; it is owed on a tide.",
  },
  "append-to-section": {
    op: "append-to-section",
    heading: "The tides",
    text: "Maren counts in tides without noticing she is doing it.",
  },
  "remove-section": { op: "remove-section", heading: "Old notes on the bells" },
} satisfies Record<string, BibleEdit>;

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
  bibleEdits: exampleBibleEdits,
} as const;

/**
 * The headings a sheet actually has, said to the model that writes them.
 *
 * A sheet's prose is a fixed set of sections per kind, not free text: `sheetBody` walks the shape
 * and writes those headings and no others. Nothing anywhere told the model so — not the schema,
 * which takes any string up to 120 characters, and not the examples, one of which named a heading
 * that does not exist — and a section under an invented heading is dropped in silence, after the
 * proposition has been materialised, staged, accepted, versioned and change-logged.
 *
 * Read off `SHEET_SHAPES` rather than written out, so adding a section stays the data change the
 * table exists to make it. Wrap-up now holds back a proposition that names a heading off this
 * list, and this is what makes that refusal avoidable rather than a trap.
 */
function sheetSectionRule(): string {
  const lines = Object.values(SHEET_SHAPES).map(
    (shape) => `  - ${shape.type}: ${shape.sections.map((s) => `"${s.heading}"`).join(", ")}`,
  );
  return `  Sections are a fixed set per kind, and a heading outside it is not written anywhere — use one of these exactly, punctuation included, and put anything that fits none of them in the nearest one that does:
${lines.join("\n")}`;
}

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
  "art-direction.change": ArtDirectionChangePayload,
  "media.image-opportunity": ImageOpportunityPayload,
  "development.overview": DevelopmentOverviewPayload,
  "development.season": DevelopmentSeasonPayload,
  "development.episode": DevelopmentEpisodePayload,
  "development.scene-script": DevelopmentSceneScriptPayload,
  "development.shot": DevelopmentShotPayload,
  "development.series": DevelopmentSeriesPayload,
  undecided: UndecidedPayload,
} as const satisfies Record<WorldChangeClassification, { draft: z.ZodTypeAny }>;

/** The object under a draft schema, past any `.refine()` wrapping it. */
function draftObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null {
  let inner = schema;
  while (inner instanceof z.ZodEffects) inner = inner.innerType();
  return inner instanceof z.ZodObject ? inner : null;
}

/** An object shape as a short signature: `{kind:"canon", entryId}`. */
/**
 * A nested object's shape, with each key's type (2026-08-22).
 *
 * This used to render key names alone — `{openOnPrevious, keepOut}` — which told a model what a
 * field is called and nothing about what may go in it. Driven against a real season: the story
 * author wrote `continuity.openOnPrevious` as a sentence describing what the shot opens on, a
 * boolean field took a string, and the whole turn was refused after the model had done all the
 * work. That is the same whole-turn rejection `describeField` exists to prevent, one level
 * further in, and the fix is the same: say the type.
 *
 * `depth` stops the recursion paying for itself twice over. Three levels reaches the deepest
 * shape here — a link’s pending-entity `ref` — and anything past that renders as bare names
 * rather than growing the prompt without bound.
 */
function shapeSignature(schema: z.ZodTypeAny, depth = 0): string {
  const object = draftObject(schema);
  if (!object) return "value";
  const keys = Object.entries(object.shape).map(([key, field]) => {
    if (field instanceof z.ZodLiteral) return `${key}:${JSON.stringify(field.value)}`;
    if (depth >= 2) return key;
    const { inner, optional } = unwrapField(field as z.ZodTypeAny);
    const type = inner instanceof z.ZodObject ? shapeSignature(inner, depth + 1) : fieldType(field as z.ZodTypeAny);
    return `${key}: ${type}${optional ? "?" : ""}`;
  });
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
    // Called, not passed: `map(shapeSignature)` hands it the element's index as its second
    // argument, which is the depth counter — so every branch after the first rendered as bare
    // names while the first was typed.
    return (inner.options as z.ZodTypeAny[]).map((option) => shapeSignature(option)).join(" or ");
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

{"reply": "...", "candidateOperations": [...], "groupOperations": [...], "bibleEdits": [...], "editorRequests": [...], "sceneEdits": [...]}

reply is plain prose for the person (at most ${TURN_RESULT_BOUNDS.reply} characters). candidateOperations holds at most ${TURN_RESULT_BOUNDS.candidateOperations} operations, groupOperations at most ${TURN_RESULT_BOUNDS.groupOperations}, bibleEdits at most ${BIBLE_EDIT_BOUNDS.edits}, editorRequests at most ${EDITOR_REQUEST_BOUNDS.perTurn}, sceneEdits at most ${SCENE_EDIT_BOUNDS.perTurn}; all are [] when there is nothing to record.

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
${sheetSectionRule()}
- ${draftPayloadLine("relationship.change")}
  proseEdits carries the complete new body of each section it touches, never an instruction to append.
  fields: ${draftFieldCatalogue("relationship.change")}
- ${draftPayloadLine("art-direction.change")}
  Use this — never canon.create — when they want the world to LOOK different. It changes the world look itself, which is what every image is generated from; a Canon entry describing a style changes nothing anyone can see. description is the whole look as it should now read, not an adjustment to the old one.
  fields: ${draftFieldCatalogue("art-direction.change")}
- ${draftPayloadLine("media.image-opportunity")}
  Use this for media the person could generate. medium is image or video. Use concept-image for a free image, concept-video for a free video, and shot-video when the target is a shot. The Studio proposes the brief; it never claims the media already exists.
  fields: ${draftFieldCatalogue("media.image-opportunity")}
- ${draftPayloadLine("development.overview")}
  The production's structured overview as it should now read. Only in a production, episode or scene conversation.
  fields: ${draftFieldCatalogue("development.overview")}
- ${draftPayloadLine("development.season")}
  The season's question, ending, direction and arcs. The episode envelope's defaults are a form's to change, never a conversation's.
  fields: ${draftFieldCatalogue("development.season")}
- ${draftPayloadLine("development.episode")}
  target.episodeId absent creates a new episode; present amends the one named. scenes is the whole ordered membership when carried.
  fields: ${draftFieldCatalogue("development.episode")}
- ${draftPayloadLine("development.scene-script")}
  blocks is the whole ordered script as it should now read; block ids are stable and shots cite them, so keep an existing block's id when only its text changes.
  fields: ${draftFieldCatalogue("development.scene-script")}
- ${draftPayloadLine("development.shot")}
  One shot inside a scene. target.shotId present amends that shot; absent adds a shot at the end of the scene. Carry only the fields that change — an amendment is not a rewrite, and a field you omit is left exactly as it is. The shot's id and its number are not yours to set: identity is minted once and the storyboard's drag is what reorders. Write description with @mentions for every character and location it shows, camera as a complete value naming a fixture the location supports and what the camera faces before the size and movement, and audio as an object, never a sentence.
  fields: ${draftFieldCatalogue("development.shot")}
- ${draftPayloadLine("development.series")}
  The thin Series record: engine and continuity only. Recurring cast stays in world sheets — a Series that describes characters is a second world.
  fields: ${draftFieldCatalogue("development.series")}
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

### Bible edits

The bible is the author's own document about their world — their thinking, in their words. It is shown to you in full under "The author's bible", or that section says the world has none yet. It is NOT canon: nothing in it is settled, grounded answers do not come from it, and a candidate may never cite it as evidence. Other generation paths may use it only as non-binding creative intent.

You may edit it, and edits land immediately — there is no accept step. Every edit cuts a version and can be undone, which is why it needs no permission; it is not a licence to tidy. Edit it when they ask you to, or when writing something down is plainly the point of what they just said. Never append to it as a routine end to a turn: it is loaded whole on every turn, so a document you add to reflexively is one that grows until it costs them.

op is one of set-section | append-to-section | remove-section | replace-document.

- set-section replaces that section's body, or adds the section at the end when the heading is new: ${JSON.stringify(exampleBibleEdits["set-section"])}
- append-to-section adds to the end of a section that already exists: ${JSON.stringify(exampleBibleEdits["append-to-section"])}
- remove-section takes one out: ${JSON.stringify(exampleBibleEdits["remove-section"])}
- replace-document rewrites the whole thing: {"op": "replace-document", "text": "..."}

heading matches the \`## \` headings shown to you, ignoring case and surrounding space. append-to-section and remove-section are refused when the heading is not there, and a refusal rejects the whole turn — so use set-section when you are adding something new. Prefer a section-scoped edit to replace-document: restating a long document to change one line loses the parts you were not thinking about.

Where the bible and Canon disagree, Canon is what the world has decided. Say so rather than choosing — and never quietly edit the bible to agree with Canon unless they ask you to.

### Editor requests

Only in a production, episode or scene thread, and only when the person asks for a change to the cut: an editor request stages exact timeline commands for them to accept or reject on a card beside the timeline. Nothing you write in reply changes the timeline. Only their Accept does, and it applies every command or none, as one undoable step. The timeline you may address is described in the thread's context — its clip ids, tracks and frames. A request naming a clip that is not there, or one that cannot apply, is refused, and a refusal rejects the whole turn, so name only what you were shown.

${JSON.stringify(exampleEditorRequest)}

summary says what moves, what goes and what comes, in their terms — never "improve the cut". kind is one of move-adjacent (clipId, direction earlier|later) | move-to-order (clipId, index from 0) | move-to-frame (clipId, startFrame) | trim (clipId, edge start|end, deltaFrames — negative shortens) | split (clipId, atFrame, newClipId) | duplicate (clipId, newClipId) | delete (clipId) | ripple-delete (clipId) | switch-take (shotId, takeId) | set-clip-gain (clipId, gainDb) | set-track (trackId, then any of name, muted, solo, order). Frames count from zero at the production's frame rate. A newClipId is one you invent, cl_ followed by letters, digits and dashes. Do not repeat a request that is already pending; say that it is waiting for their decision.

### Scene edits

Only in a scene thread, and only that scene: a scene edit renames it, and it lands at once — no card, no accept step — because a title is a label the person is looking at. Rename when they ask for a name, or when the scene is still called Untitled and what they have said makes its name plain; otherwise leave the name alone. The title reads in the header as \`Scene 7 · The tide answers\`, so give the name only, short and in their register. A rename against a scene that changed while you were answering is refused, and a refusal rejects the whole turn.

${JSON.stringify(exampleSceneEdit)}

### Group operations

A group says "these land together or not at all". members has at least two entries, each {"temporaryId": "..."} or {"candidateId": "cand_...", "revision": N}.

${JSON.stringify(exampleGroupOperation)}

update and withdraw name the group instead: {"op": "update", "groupId": "grp_...", "expectedRevision": N, ...} with the same title, rationale and members; {"op": "withdraw", "groupId": "grp_...", "expectedRevision": N, "reason": "..."}.`;
}
