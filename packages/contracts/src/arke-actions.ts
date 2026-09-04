import { z } from "zod";
import type { ZodType } from "zod";
import type { ClientMessage } from "./frames.js";
import {
  ConversationActionIdSchema,
  ConversationIdSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  SlugSchema,
  TurnIdSchema,
  UlidSchema,
} from "./ids.js";

/** The closed parity classes required by SPEC-041 R-47. */
export const ArkeCommandClassificationSchema = z.enum([
  "supported-by-arke",
  "human-only-control-plane",
  "read-only",
  "out-of-scope-global",
]);
export type ArkeCommandClassification = z.infer<typeof ArkeCommandClassificationSchema>;

/** Arke acts only inside an open creative workspace. */
export const ArkeActionScopeSchema = z.enum(["world", "production"]);
export type ArkeActionScope = z.infer<typeof ArkeActionScopeSchema>;

export const ArkeCardFamilySchema = z.enum([
  "authored-diff",
  "command",
  "destructive",
  "take-review",
  "generation",
  "host-action",
  "setting",
]);
export type ArkeCardFamily = z.infer<typeof ArkeCardFamilySchema>;

/** Existing durable authorities. The common action protocol never replaces one of these. */
export const ArkeActionAuthoritySchema = z.enum([
  "world-store",
  "proposal-manager",
  "bible",
  "reference-kit",
  "voice",
  "production-store",
  "scene-store",
  "chapter-store",
  "frame-run",
  "dispatch-plan",
  "routing",
  "board",
  "take-review",
  "timeline",
  "audio-cut",
  "audio-spine",
  "artifact-store",
  "extraction",
  "bench",
  "job-queue",
  "export",
  "host",
]);
export type ArkeActionAuthority = z.infer<typeof ArkeActionAuthoritySchema>;

export const ArkePermissionReasonSchema = z.enum([
  "authored-change",
  "destructive-change",
  "spend-and-compute",
  "external-network-action",
  "privacy-sensitive",
  "host-file-access",
  "export",
  "world-administration",
]);
export type ArkePermissionReason = z.infer<typeof ArkePermissionReasonSchema>;

/** Records that may have to be read completely before an action can be prepared. */
export const ArkeReadRequirementSchema = z.enum([
  "world-metadata",
  "canon",
  "sheets",
  "bible",
  "art-direction",
  "references",
  "artifacts",
  "voices",
  "production-metadata",
  "series",
  "story",
  "seasons",
  "episodes",
  "chapters",
  "scenes",
  "shots",
  "stage",
  "boards",
  "takes",
  "timeline",
  "audio",
  "subtitles",
  "spine",
  "routing",
  "plans",
  "jobs",
  "exports",
  "bench",
]);
export type ArkeReadRequirement = z.infer<typeof ArkeReadRequirementSchema>;

/** Named seams make an unavailable operation discoverable without pretending it is safe. */
export const ArkeBlockingSeamSchema = z.enum([
  "typed-sheet-target",
  "typed-media-target",
  "typed-world-target",
  "typed-scene-target",
  "typed-chapter-target",
  "typed-routing-command",
  "typed-audio-command",
  "typed-audio-spine-command",
  "typed-artifact-source",
  "durable-generation-quote",
  "coordinator-owned-generation-quote",
  "complete-timeline-read",
  "complete-spine-read",
]);
export type ArkeBlockingSeam = z.infer<typeof ArkeBlockingSeamSchema>;

export type ArkeCapabilitySupport =
  | { readonly state: "available" }
  | {
      readonly state: "blocked";
      readonly blockingSeams: readonly ArkeBlockingSeam[];
      readonly reason: string;
    };

export interface ArkeActionSupport {
  /** Whether a strict, model-safe payload can represent this operation. */
  readonly preparation: ArkeCapabilitySupport;
  /** Whether every record required to fence the payload can currently be read completely. */
  readonly reads: ArkeCapabilitySupport;
  /** Whether the existing authority has an exact semantic command seam. */
  readonly execution: ArkeCapabilitySupport;
}

export type ClientMessageKind = ClientMessage["kind"];
export type ClientMessageOfKind<K extends ClientMessageKind> = Extract<ClientMessage, { kind: K }>;

/** Stable authority and target identifiers cannot smuggle host paths into cards or tombstones. */
export const ConversationActionSemanticIdSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => value.trim() === value && ![...value].some(
    (character) => character === "\\" || character === "/" || character.charCodeAt(0) < 32,
  ), {
    message: "expected a semantic identifier without path separators",
  });

/** Metadata shared by registered client commands and intended authorities with no client seam yet. */
export interface ArkeActionDescriptor<K extends string, TAction extends { kind: K }> {
  readonly kind: K;
  readonly schema: ZodType<TAction>;
  readonly scope: ArkeActionScope;
  readonly cardFamily: ArkeCardFamily;
  readonly authority: ArkeActionAuthority;
  readonly permissionReason: ArkePermissionReason;
  readonly requiredReads: readonly ArkeReadRequirement[];
  readonly support: ArkeActionSupport;
}

export interface ArkeSupportedClientCommand<K extends ClientMessageKind>
  extends ArkeActionDescriptor<K, ClientMessageOfKind<K>> {
  readonly classification: "supported-by-arke";
}

export interface ArkeExcludedClientCommand<K extends ClientMessageKind> {
  readonly kind: K;
  readonly schema: ZodType<ClientMessageOfKind<K>>;
  readonly classification: Exclude<ArkeCommandClassification, "supported-by-arke">;
  readonly reason: string;
}

export type ArkeClientCommandDescriptor<K extends ClientMessageKind = ClientMessageKind> =
  | ArkeSupportedClientCommand<K>
  | ArkeExcludedClientCommand<K>;

/** A coordinator-owned observation supplied to preparation, never a model-authored fence. */
export const ArkeReadObservationSchema = z
  .object({
    requirement: ArkeReadRequirementSchema,
    target: ConversationActionSemanticIdSchema,
    revisionOrDigest: z.string().min(1).max(200),
    complete: z.boolean(),
    /** Coordinator-issued receipt proving this target page was served; absent on legacy intents. */
    receiptId: z.string().regex(/^check_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  })
  .strict();
export type ArkeReadObservation = z.infer<typeof ArkeReadObservationSchema>;

export interface ArkePreparedAction<TPreview> {
  readonly preview: TPreview;
  readonly baseObservations: readonly ArkeReadObservation[];
}

/** Preparation is pure preview work; issue #805 supplies the durable decision envelope around it. */
export interface ArkeActionAdapter<
  K extends string,
  TAction extends { kind: K },
  TPreview,
> {
  readonly descriptor: ArkeActionDescriptor<K, TAction>;
  prepare(
    action: TAction,
    observations: readonly ArkeReadObservation[],
  ): Promise<ArkePreparedAction<TPreview>>;
}

// ---------------------------------------------------------------------------
// Durable conversation actions (SPEC-041 R-11..R-21, R-35..R-45)
// ---------------------------------------------------------------------------

/** The only actor in the current single-user product. It is assigned by the coordinator. */
export const LOCAL_ACTOR_ID = "local-user" as const;
export const LocalActorIdSchema = z.literal(LOCAL_ACTOR_ID);
export type LocalActorId = z.infer<typeof LocalActorIdSchema>;

export const ConversationActionStatusSchema = z.enum([
  "pending",
  "approved",
  "awaiting-host",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "denied",
  "stale",
  "superseded",
]);
export type ConversationActionStatus = z.infer<typeof ConversationActionStatusSchema>;

export const ConversationActionFinalStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "denied",
  "stale",
  "superseded",
]);
export type ConversationActionFinalStatus = z.infer<typeof ConversationActionFinalStatusSchema>;

export const ConversationActionDecisionKindSchema = z.enum(["approve", "deny"]);
export type ConversationActionDecisionKind = z.infer<typeof ConversationActionDecisionKindSchema>;

/** A stable semantic target, never a renderer- or model-supplied host path. */
export const ConversationActionTargetSchema = z
  .object({
    kind: z.string().min(1).max(80),
    id: ConversationActionSemanticIdSchema,
    label: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ConversationActionTarget = z.infer<typeof ConversationActionTargetSchema>;

const ShownLineSchema = z
  .object({ label: z.string().min(1).max(200), detail: z.string().max(4_000).optional() })
  .strict();

export const ArkeAuthoredDiffBodySchema = z
  .object({
    family: z.literal("authored-diff"),
    fields: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            before: z.string().max(20_000).nullable(),
            after: z.string().max(20_000).nullable(),
          })
          .strict(),
      )
      .min(1),
    conflicts: z.array(z.string().min(1).max(1_000)).default([]),
    openChoices: z.array(z.string().min(1).max(1_000)).default([]),
  })
  .strict();

export const ArkeCommandBodySchema = z
  .object({
    family: z.literal("command"),
    commands: z.array(ShownLineSchema).min(1),
    expectedResult: z.string().min(1).max(4_000),
    undoAvailable: z.boolean(),
  })
  .strict();

export const ArkeDestructiveBodySchema = z
  .object({
    family: z.literal("destructive"),
    removed: z.array(z.string().min(1).max(500)).min(1),
    retained: z.array(z.string().min(1).max(500)).default([]),
    dependentChanges: z.array(z.string().min(1).max(1_000)).default([]),
    blockers: z.array(z.string().min(1).max(1_000)).default([]),
    undoAvailable: z.boolean(),
  })
  .strict();

export const ArkeTakeReviewBodySchema = z
  .object({
    family: z.literal("take-review"),
    mediaKind: z.enum(["image", "video", "audio"]),
    mediaId: ConversationActionSemanticIdSchema,
    destination: z.string().min(1).max(500),
    currentSelection: z.string().max(500).nullable(),
    reason: z.string().max(2_000).optional(),
  })
  .strict();

export const ArkeGenerationBodySchema = z
  .object({
    family: z.literal("generation"),
    medium: z.enum(["image", "video", "audio", "document", "board"]),
    purpose: z.string().min(1).max(300),
    prompt: z.string().min(1).max(20_000),
    references: z
      .array(z.object({ id: ConversationActionSemanticIdSchema, role: z.string().min(1).max(200) }).strict())
      .default([]),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    quantity: z.number().int().min(1),
    output: z.string().min(1).max(500),
    cost: z.string().min(1).max(500),
    quoteDigest: Sha256Schema.optional(),
  })
  .strict();

export const ArkeHostActionBodySchema = z
  .object({
    family: z.literal("host-action"),
    action: z.string().min(1).max(500),
    effect: z.string().min(1).max(2_000),
  })
  .strict();

export const ArkeSettingBodySchema = z
  .object({
    family: z.literal("setting"),
    setting: z.string().min(1).max(300),
    current: z.string().max(4_000).nullable(),
    proposed: z.string().max(4_000).nullable(),
    consequences: z.array(z.string().min(1).max(1_000)).default([]),
  })
  .strict();

/** Closed body families prevent an unknown action from becoming an approvable JSON dump. */
export const ConversationActionBodySchema = z.discriminatedUnion("family", [
  ArkeAuthoredDiffBodySchema,
  ArkeCommandBodySchema,
  ArkeDestructiveBodySchema,
  ArkeTakeReviewBodySchema,
  ArkeGenerationBodySchema,
  ArkeHostActionBodySchema,
  ArkeSettingBodySchema,
]);
export type ConversationActionBody = z.infer<typeof ConversationActionBodySchema>;

export const ConversationActionShownProjectionSchema = z
  .object({
    title: z.string().min(1).max(200),
    consequence: z.string().min(1).max(4_000),
    affectedTargets: z.array(ConversationActionTargetSchema).min(1),
    ripples: z.array(z.string().min(1).max(2_000)).default([]),
    permissionReason: ArkePermissionReasonSchema,
    body: ConversationActionBodySchema,
  })
  .strict();
export type ConversationActionShownProjection = z.infer<typeof ConversationActionShownProjectionSchema>;

/** The stable pointer to whichever existing authority owns the payload and execution state. */
export const ConversationActionAuthorityBindingSchema = z
  .object({ kind: ArkeActionAuthoritySchema, id: ConversationActionSemanticIdSchema })
  .strict();
export type ConversationActionAuthorityBinding = z.infer<typeof ConversationActionAuthorityBindingSchema>;

const ConversationActionIntentFields = {
  actionId: ConversationActionIdSchema,
  conversationId: ConversationIdSchema,
  turnId: TurnIdSchema,
  worldId: UlidSchema,
  productionId: SlugSchema.optional(),
  actorId: LocalActorIdSchema,
  scope: ArkeActionScopeSchema,
  actionKind: z.string().min(1).max(120),
  authorityKind: ArkeActionAuthoritySchema,
  cardFamily: ArkeCardFamilySchema,
  targets: z.array(ConversationActionTargetSchema).min(1),
  payloadDigest: Sha256Schema,
  baseObservations: z.array(ArkeReadObservationSchema),
  dependencies: z.array(ConversationActionIdSchema).default([]),
  createdAt: IsoDateTimeSchema,
} as const;

/** Enough durable identity to reconcile preparation without copying an authority's writable payload. */
export const ConversationActionPrepareIntentSchema = z.object(ConversationActionIntentFields).strict();
export type ConversationActionPrepareIntent = z.infer<typeof ConversationActionPrepareIntentSchema>;

export const ConversationActionBindingSchema = z
  .object({
    ...ConversationActionIntentFields,
    authority: ConversationActionAuthorityBindingSchema,
    authorityRevision: z.number().int().min(0),
    previewDigest: Sha256Schema,
    shown: ConversationActionShownProjectionSchema,
    approvalBlockedReason: z.string().min(1).max(1_000).optional(),
    status: z.literal("pending"),
    preparedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.authority.kind !== binding.authorityKind) {
      ctx.addIssue({ code: "custom", path: ["authority", "kind"], message: "authority kind differs from intent" });
    }
    if (binding.shown.body.family !== binding.cardFamily) {
      ctx.addIssue({ code: "custom", path: ["shown", "body", "family"], message: "card body family differs from binding" });
    }
  });
export type ConversationActionBinding = z.infer<typeof ConversationActionBindingSchema>;

export const ConversationActionDecisionSchema = z
  .object({
    requestId: UlidSchema,
    decision: ConversationActionDecisionKindSchema,
    actorId: LocalActorIdSchema,
    expectedConversationSeq: z.number().int().min(0),
    expectedStatus: z.enum(["pending", "stale"]),
    decidedAt: IsoDateTimeSchema,
  })
  .strict();
export type ConversationActionDecision = z.infer<typeof ConversationActionDecisionSchema>;

export const ConversationActionReceiptSchema = z
  .object({
    kind: z.string().min(1).max(100),
    id: ConversationActionSemanticIdSchema,
    summary: z.string().min(1).max(2_000),
    digest: Sha256Schema.optional(),
  })
  .strict();
export type ConversationActionReceipt = z.infer<typeof ConversationActionReceiptSchema>;

/** Deletion retains the durable pointer, not receipt prose that may name a host path. */
export const ConversationActionTombstoneReceiptSchema = ConversationActionReceiptSchema.omit({ summary: true });
export type ConversationActionTombstoneReceipt = z.infer<typeof ConversationActionTombstoneReceiptSchema>;

export const ConversationActionUndoLinkSchema = z
  .object({
    kind: z.string().min(1).max(100),
    id: ConversationActionSemanticIdSchema,
    linkedAt: IsoDateTimeSchema,
  })
  .strict();
export type ConversationActionUndoLink = z.infer<typeof ConversationActionUndoLinkSchema>;

/** The fold overlays append-only lifecycle events on this immutable prepared binding. */
export const ConversationActionRecordSchema = z
  .object({
    ...ConversationActionIntentFields,
    authority: ConversationActionAuthorityBindingSchema,
    authorityRevision: z.number().int().min(0),
    previewDigest: Sha256Schema,
    shown: ConversationActionShownProjectionSchema,
    approvalBlockedReason: z.string().min(1).max(1_000).optional(),
    status: ConversationActionStatusSchema,
    preparedAt: IsoDateTimeSchema,
    decision: ConversationActionDecisionSchema.optional(),
    statusDetail: z.string().max(1_000).optional(),
    receipt: ConversationActionReceiptSchema.optional(),
    supersededBy: ConversationActionIdSchema.optional(),
    undo: ConversationActionUndoLinkSchema.optional(),
  })
  .strict();
export type ConversationActionRecord = z.infer<typeof ConversationActionRecordSchema>;

/** The renderer gets coordinator-derived controls, never authority payload or mutable options. */
export const ConversationActionCardSchema = ConversationActionRecordSchema.extend({
  availableDecisions: z.array(ConversationActionDecisionKindSchema),
  blockedReason: z.string().min(1).max(1_000).optional(),
}).strict();
export type ConversationActionCard = z.infer<typeof ConversationActionCardSchema>;

/** The content-minimising world-scoped audit retained after a conversation is deleted. */
export const ConversationActionTombstoneSchema = z
  .object({
    actionId: ConversationActionIdSchema,
    actorId: LocalActorIdSchema,
    actionKind: z.string().min(1).max(120),
    status: ConversationActionFinalStatusSchema,
    decision: ConversationActionDecisionKindSchema.optional(),
    decidedAt: IsoDateTimeSchema.optional(),
    authority: ConversationActionAuthorityBindingSchema,
    payloadDigest: Sha256Schema,
    previewDigest: Sha256Schema,
    receipt: ConversationActionTombstoneReceiptSchema.optional(),
  })
  .strict();
export type ConversationActionTombstone = z.infer<typeof ConversationActionTombstoneSchema>;

/** The one renderer frame that may cross the conversation permission boundary. */
export const DecideConversationActionSchema = z
  .object({
    kind: z.literal("conversation-action-decide"),
    worldId: UlidSchema,
    conversationId: ConversationIdSchema,
    actionId: ConversationActionIdSchema,
    expectedConversationSeq: z.number().int().min(0),
    expectedStatus: z.enum(["pending", "stale"]),
    decision: ConversationActionDecisionKindSchema,
    requestId: UlidSchema,
  })
  .strict();
export type DecideConversationAction = z.infer<typeof DecideConversationActionSchema>;

export const ConversationActionDecisionRefusalSchema = z.enum([
  "wrong-world",
  "unknown-conversation",
  "wrong-conversation",
  "unknown-action",
  "sequence-mismatch",
  "status-mismatch",
  "actor-mismatch",
  "dependency-blocked",
  "stale",
  "adapter-unavailable",
  "request-conflict",
  "authority-mismatch",
  "validation-refused",
]);
export type ConversationActionDecisionRefusal = z.infer<typeof ConversationActionDecisionRefusalSchema>;

export const ConversationActionDecisionResultSchema = z
  .object({
    worldId: UlidSchema,
    conversationId: ConversationIdSchema,
    actionId: ConversationActionIdSchema,
    requestId: UlidSchema,
    disposition: z.enum(["recorded", "refused"]),
    decision: ConversationActionDecisionKindSchema.optional(),
    status: ConversationActionStatusSchema.optional(),
    reason: ConversationActionDecisionRefusalSchema.optional(),
    detail: z.string().min(1).max(1_000).optional(),
    deduplicated: z.boolean().default(false),
  })
  .strict();
export type ConversationActionDecisionResult = z.infer<typeof ConversationActionDecisionResultSchema>;
