import { z } from "zod";
import { ConversationActionSemanticIdSchema } from "./arke-actions.js";
import { AudioPolicySchema, FailureModesSchema, KeyArtIntentSchema } from "./art-direction.js";
import { BibleEditSchema } from "./bible.js";
import { ModelEditorRequestSchema, ModelSceneEditSchema } from "./editor-request.js";
import {
  ArtifactIdSchema,
  CandidateIdSchema,
  CanonIdSchema,
  CheckReceiptIdSchema,
  SlugSchema,
  ShotIdSchema,
  TakeIdSchema,
  UlidSchema,
} from "./ids.js";
import { STAGED_REFERENCE_KEY } from "./planning.js";
import { CompilationFormatSchema, ReferenceAngleSchema } from "./reference.js";
import {
  CHARACTER_ROLE_MAX,
  SheetKindSchema,
  SheetStatusSchema,
  WorldAuthoredFieldChangesSchema,
} from "./world.js";

const CandidateRevisionSchema = z
  .object({ candidateId: CandidateIdSchema, revision: z.number().int().min(1) })
  .strict();

const CompleteReadIdsSchema = z.array(CheckReceiptIdSchema).min(1).max(8);
const SemanticIdsSchema = z.array(ConversationActionSemanticIdSchema).max(40);
const StagedReferenceKeySchema = z.string().min(1).max(120).regex(STAGED_REFERENCE_KEY);
const SheetSectionChangeSchema = z
  .object({ heading: z.string().min(1).max(120), body: z.string() })
  .strict();
const SettledCanonTypeSchema = z.enum(["rule", "lore", "location", "faction", "timeline", "tone"]);

const CanonChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      entryType: SettledCanonTypeSchema,
      title: z.string().min(1).max(160),
      statement: z.string().trim().min(1),
      links: z.array(z.union([CanonIdSchema, SlugSchema])).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("amend"),
      entryId: CanonIdSchema,
      changes: z
        .object({
          entryType: SettledCanonTypeSchema.optional(),
          title: z.string().min(1).max(160).optional(),
          statement: z.string().trim().min(1).optional(),
          links: z.array(z.union([CanonIdSchema, SlugSchema])).optional(),
        })
        .strict()
        .refine((changes) => Object.keys(changes).length > 0, "a Canon amendment must change at least one field"),
    })
    .strict(),
  z
    .object({
      operation: z.literal("open-thread"),
      title: z.string().min(1).max(160),
      question: z.string().trim().min(1),
      consideredEntryIds: z.array(CanonIdSchema).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("settle-thread"),
      entryId: CanonIdSchema,
      resolvedType: SettledCanonTypeSchema,
      statement: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-status"),
      entryId: CanonIdSchema,
      change: z.discriminatedUnion("status", [
        z.object({ status: z.literal("open") }).strict(),
        z.object({ status: z.literal("settled"), resolvedType: SettledCanonTypeSchema }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-considered-entries"),
      entryId: CanonIdSchema,
      consideredEntryIds: z.array(CanonIdSchema),
    })
    .strict(),
]);

const SheetAuthoredChangesSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().max(CHARACTER_ROLE_MAX).nullable().optional(),
    billing: z.string().max(80).nullable().optional(),
    region: z.string().max(120).nullable().optional(),
    canonRules: z.array(CanonIdSchema).optional(),
    links: z.array(SlugSchema).optional(),
    sections: z.array(SheetSectionChangeSchema).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "a sheet edit must change at least one field");

const SheetChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      sheetType: SheetKindSchema,
      name: z.string().trim().min(1).max(120),
      role: z.string().max(CHARACTER_ROLE_MAX).optional(),
      billing: z.string().max(80).optional(),
      region: z.string().max(120).optional(),
      canonRules: z.array(CanonIdSchema).default([]),
      links: z.array(SlugSchema).default([]),
      sections: z.array(SheetSectionChangeSchema),
      /** A Production Chat guest remains a world sheet owned by that production. */
      productionId: SlugSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("edit"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      changes: SheetAuthoredChangesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("relationship"),
      from: z.object({ sheetType: SheetKindSchema, sheetId: SlugSchema }).strict(),
      to: z.union([
        z.object({ kind: z.literal("sheet"), sheetId: SlugSchema }).strict(),
        z.object({ kind: z.literal("canon"), entryId: CanonIdSchema }).strict(),
      ]),
      linkAction: z.enum(["add", "remove"]),
      proseEdits: z
        .array(
          z
            .object({
              sheetType: SheetKindSchema,
              sheetId: SlugSchema,
              sectionHeading: z.string().min(1).max(120),
              body: z.string(),
            })
            .strict(),
        )
        .default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("rename"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-status"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      status: SheetStatusSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("duplicate"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      newName: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      operation: z.literal("promote-guest"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
    })
    .strict(),
]);

const ArtDirectionChangesSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    masterLook: z.enum(["keep", "clear"]).optional(),
    audio: AudioPolicySchema.optional(),
    failureModes: FailureModesSchema.optional(),
    keyArtIntent: KeyArtIntentSchema
      .refine(
        (intent) => Boolean(intent.subject || intent.moment),
        "key-art intent must name a subject or moment",
      )
      .nullable()
      .optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "an art-direction action must change at least one field");

const ArtifactMetadataChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("add-links"),
      artifactId: ArtifactIdSchema,
      links: SemanticIdsSchema.min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-owner"),
      artifactId: ArtifactIdSchema,
      productionId: SlugSchema.nullable(),
    })
    .strict(),
]);

const ReferenceImportSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("location-view-candidate"), sheetId: SlugSchema }).strict(),
  z.object({ operation: z.literal("main-photo-candidate"), sheetId: SlugSchema }).strict(),
  z.object({ operation: z.literal("main-photo"), sheetId: SlugSchema }).strict(),
  z.object({ operation: z.literal("character-sheet"), sheetId: SlugSchema }).strict(),
]);

const ReferenceResultUseSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("choose-anchor"),
      sheetId: SlugSchema,
      selection: z.discriminatedUnion("source", [
        z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
        z.object({ source: z.literal("candidate"), candidateIndex: z.number().int().min(1) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept-location-view"),
      sheetId: SlugSchema,
      selection: z.discriminatedUnion("source", [
        z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
        z.object({ source: z.literal("candidate"), candidateIndex: z.number().int().min(1) }).strict(),
      ]),
      name: z.string().trim().min(1).max(80),
      establishing: z.boolean().optional(),
      replaceExistingName: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal("accept-character-sheet"), sheetId: SlugSchema, takeId: TakeIdSchema }).strict(),
  z.object({ operation: z.literal("accept-character-look"), sheetId: SlugSchema, takeId: TakeIdSchema }).strict(),
]);

const ReferenceChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("promote-look"), sheetId: SlugSchema, lookId: ConversationActionSemanticIdSchema }).strict(),
  z
    .object({
      operation: z.literal("attach-look"),
      sheetId: SlugSchema,
      lookId: ConversationActionSemanticIdSchema,
      scope: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
          z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: ConversationActionSemanticIdSchema }).strict(),
        ])
        .nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("designate-compilation"),
      sheetId: SlugSchema,
      compilation: z.object({ format: CompilationFormatSchema, compiledAt: z.string().datetime() }).strict(),
    })
    .strict(),
]);

const ReferenceGenerationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("establish-look"), sheetId: SlugSchema, count: z.number().int().min(1).max(8) }).strict(),
  z
    .object({
      operation: z.literal("location-view"),
      sheetId: SlugSchema,
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().max(2_000).optional(),
      count: z.number().int().min(1).max(8),
      establishing: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("main-photo"),
      sheetId: SlugSchema,
      prompt: z.string().trim().min(1).max(2_000),
      count: z.number().int().min(1).max(8),
      identityReferenceIds: SemanticIdsSchema.max(4),
    })
    .strict(),
  z.object({ operation: z.literal("character-sheet"), sheetId: SlugSchema, styleOverride: z.string().trim().min(1).max(4_000).optional() }).strict(),
  z
    .object({
      operation: z.literal("character-looks"),
      sheetId: SlugSchema,
      lookKind: z.enum(["costume", "pose-expression", "condition-age"]),
      mode: z.enum(["stay-close", "push-it"]),
      prompt: z.string().trim().min(1).max(2_000),
      count: z.number().int().min(1).max(8),
    })
    .strict(),
  z.object({ operation: z.literal("missing-tiles"), sheetId: SlugSchema, group: z.enum(["head", "body"]) }).strict(),
  z.object({ operation: z.literal("regenerate-tile"), sheetId: SlugSchema, angle: ReferenceAngleSchema }).strict(),
]);

const VoiceSelectionSchema = z
  .object({
    provider: ConversationActionSemanticIdSchema,
    model: ConversationActionSemanticIdSchema,
    voiceId: ConversationActionSemanticIdSchema,
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const VoiceClipReviewActionSchema = z
  .object({
    kind: z.literal("voice-clip-review"),
    productionId: SlugSchema,
    takeId: TakeIdSchema,
    review: z.discriminatedUnion("decision", [
      z.object({ decision: z.literal("accept"), shotId: ShotIdSchema }).strict(),
      z
        .object({
          decision: z.literal("reject"),
          shotId: ShotIdSchema.optional(),
          citation: z
            .object({ sheet: SlugSchema, field: z.string().trim().min(1).max(200), note: z.string().trim().min(1).max(1_000).optional() })
            .strict(),
        })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ReferenceImportActionSchema = z
  .object({ kind: z.literal("reference-import"), change: ReferenceImportSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceResultUseActionSchema = z
  .object({ kind: z.literal("reference-result-use"), change: ReferenceResultUseSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceReviewActionSchema = z
  .object({
    kind: z.literal("reference-review"),
    takeId: TakeIdSchema,
    decision: z.literal("reject"),
    field: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(1_000).optional(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceChangeActionSchema = z
  .object({ kind: z.literal("reference-change"), change: ReferenceChangeSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceTileLockActionSchema = z
  .object({
    kind: z.literal("reference-tile-lock"),
    sheetId: SlugSchema,
    angle: ReferenceAngleSchema,
    name: z.string().trim().min(1).max(120).optional(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceCompileActionSchema = z
  .object({ kind: z.literal("reference-compile"), sheetId: SlugSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceStyleActionSchema = z
  .object({ kind: z.literal("reference-style"), sheetId: SlugSchema, style: z.string().trim().min(1).max(500).nullable(), checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceGenerationActionSchema = z
  .object({ kind: z.literal("reference-generation"), request: ReferenceGenerationSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceImageTargetSchema = z.discriminatedUnion("surface", [
  z.object({ surface: z.literal("world-image") }).strict(),
  z.object({ surface: z.literal("master-look") }).strict(),
  z.object({ surface: z.literal("staged-reference"), key: StagedReferenceKeySchema }).strict(),
]);
const ReferenceImageImportActionSchema = z
  .object({ kind: z.literal("reference-image-import"), target: ReferenceImageTargetSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceWorldImageResultUseActionSchema = z
  .object({
    kind: z.literal("reference-world-image-result-use"),
    candidateIndex: z.number().int().min(1),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceMasterLookResultUseActionSchema = z
  .object({
    kind: z.literal("reference-master-look-result-use"),
    candidateIndex: z.number().int().min(1),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceImageDiscardActionSchema = z
  .object({ kind: z.literal("reference-image-discard"), target: ReferenceImageTargetSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();

const WorldMetadataModelActionSchema = z.object({ kind: z.literal("world-metadata"), changes: WorldAuthoredFieldChangesSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const CanonModelActionSchema = z.object({ kind: z.literal("canon"), change: CanonChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const CanonRetireModelActionSchema = z.object({ kind: z.literal("canon-retire"), entryId: CanonIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const CanonRestoreModelActionSchema = z.object({ kind: z.literal("canon-restore"), entryId: CanonIdSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict();
const SheetModelActionSchema = z.object({ kind: z.literal("sheet"), change: SheetChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const SheetRetireModelActionSchema = z.object({ kind: z.literal("sheet-retire"), sheetType: SheetKindSchema, sheetId: SlugSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const SheetRestoreModelActionSchema = z.object({ kind: z.literal("sheet-restore"), sheetType: SheetKindSchema, sheetId: SlugSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict();
const ArtDirectionModelActionSchema = z.object({ kind: z.literal("art-direction"), changes: ArtDirectionChangesSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const ArtDirectionRestoreModelActionSchema = z.object({ kind: z.literal("art-direction-restore"), version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict();

export const ModelWorldChatActionSchema = z.discriminatedUnion("kind", [
  WorldMetadataModelActionSchema,
  CanonModelActionSchema,
  CanonRetireModelActionSchema,
  CanonRestoreModelActionSchema,
  SheetModelActionSchema,
  SheetRetireModelActionSchema,
  SheetRestoreModelActionSchema,
  ArtDirectionModelActionSchema,
  ArtDirectionRestoreModelActionSchema,
  z
    .object({
      kind: z.literal("artifact-import"),
      source: z.enum(["files", "folder"]),
      links: SemanticIdsSchema.default([]),
      productionId: SlugSchema.nullable().optional(),
      allowLarge: z.boolean().optional(),
      supersedes: ArtifactIdSchema.optional(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("artifact-metadata"), change: ArtifactMetadataChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("artifact-extraction"), artifactId: ArtifactIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("artifact-extraction-stop"), artifactId: ArtifactIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z
    .object({
      kind: z.literal("artifact-extraction-review"),
      artifactId: ArtifactIdSchema,
      candidateHash: z.string().regex(/^[a-f0-9]{16}$/),
      decision: z.enum(["accept", "reject"]),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("artifact-reference"), artifactId: ArtifactIdSchema, key: StagedReferenceKeySchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  ReferenceImportActionSchema,
  ReferenceResultUseActionSchema,
  ReferenceReviewActionSchema,
  ReferenceChangeActionSchema,
  ReferenceTileLockActionSchema,
  ReferenceCompileActionSchema,
  ReferenceStyleActionSchema,
  ReferenceGenerationActionSchema,
  ReferenceImageImportActionSchema,
  ReferenceWorldImageResultUseActionSchema,
  ReferenceMasterLookResultUseActionSchema,
  ReferenceImageDiscardActionSchema,
  z
    .object({
      kind: z.literal("voice-assignment"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      voice: VoiceSelectionSchema.nullable(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice-audition"),
      sheetId: SlugSchema,
      voice: VoiceSelectionSchema,
      text: z.string().trim().min(1).max(2_000).optional(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice-clone"),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(1_000),
      sheetId: SlugSchema.optional(),
      recordingGesture: z.literal("required"),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  VoiceClipReviewActionSchema,
  z.object({ kind: z.literal("world-archive"), checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("world-export"), checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z
    .object({
      kind: z.literal("production-style"),
      productionId: SlugSchema,
      style: z.string().trim().min(1).max(4_000).nullable(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
]);
export type ModelWorldChatAction = z.infer<typeof ModelWorldChatActionSchema>;

const preparedAction = <K extends string, T extends z.ZodTypeAny>(kind: K, action: T) => z
  .object({ kind: z.literal(kind), worldId: UlidSchema, productionId: SlugSchema.optional(), action })
  .strict();

export const WorldChatWorldMetadataActionSchema = preparedAction(
  "world-chat-world-metadata",
  WorldMetadataModelActionSchema,
);
export const WorldChatCanonActionSchema = preparedAction("world-chat-canon", CanonModelActionSchema);
export const WorldChatCanonRetireActionSchema = preparedAction("world-chat-canon-retire", CanonRetireModelActionSchema);
export const WorldChatCanonRestoreActionSchema = preparedAction("world-chat-canon-restore", CanonRestoreModelActionSchema);
export const WorldChatSheetActionSchema = preparedAction("world-chat-sheet", SheetModelActionSchema);
export const WorldChatSheetRetireActionSchema = preparedAction("world-chat-sheet-retire", SheetRetireModelActionSchema);
export const WorldChatSheetRestoreActionSchema = preparedAction("world-chat-sheet-restore", SheetRestoreModelActionSchema);
export const WorldChatArtDirectionActionSchema = preparedAction("world-chat-art-direction", ArtDirectionModelActionSchema);
export const WorldChatArtDirectionRestoreActionSchema = preparedAction("world-chat-art-direction-restore", ArtDirectionRestoreModelActionSchema);
export const WorldChatArtifactImportActionSchema = preparedAction("world-chat-artifact-import", ModelWorldChatActionSchema.options[9]);
export const WorldChatArtifactMetadataActionSchema = preparedAction("world-chat-artifact-metadata", ModelWorldChatActionSchema.options[10]);
export const WorldChatArtifactExtractionActionSchema = preparedAction("world-chat-artifact-extraction", ModelWorldChatActionSchema.options[11]);
export const WorldChatArtifactExtractionStopActionSchema = preparedAction("world-chat-artifact-extraction-stop", ModelWorldChatActionSchema.options[12]);
export const WorldChatArtifactExtractionReviewActionSchema = preparedAction("world-chat-artifact-extraction-review", ModelWorldChatActionSchema.options[13]);
export const WorldChatArtifactReferenceActionSchema = preparedAction("world-chat-artifact-reference", ModelWorldChatActionSchema.options[14]);
export const WorldChatReferenceImportActionSchema = preparedAction("world-chat-reference-import", ReferenceImportActionSchema);
export const WorldChatReferenceResultUseActionSchema = preparedAction("world-chat-reference-result-use", ReferenceResultUseActionSchema);
export const WorldChatReferenceReviewActionSchema = preparedAction("world-chat-reference-review", ReferenceReviewActionSchema);
export const WorldChatReferenceChangeActionSchema = preparedAction("world-chat-reference-change", ReferenceChangeActionSchema);
export const WorldChatReferenceTileLockActionSchema = preparedAction("world-chat-reference-tile-lock", ReferenceTileLockActionSchema);
export const WorldChatReferenceCompileActionSchema = preparedAction("world-chat-reference-compile", ReferenceCompileActionSchema);
export const WorldChatReferenceStyleActionSchema = preparedAction("world-chat-reference-style", ReferenceStyleActionSchema);
export const WorldChatReferenceGenerationActionSchema = preparedAction("world-chat-reference-generation", ReferenceGenerationActionSchema);
export const WorldChatReferenceImageImportActionSchema = preparedAction("world-chat-reference-image-import", ReferenceImageImportActionSchema);
export const WorldChatReferenceWorldImageResultUseActionSchema = preparedAction("world-chat-reference-world-image-result-use", ReferenceWorldImageResultUseActionSchema);
export const WorldChatReferenceMasterLookResultUseActionSchema = preparedAction("world-chat-reference-master-look-result-use", ReferenceMasterLookResultUseActionSchema);
export const WorldChatReferenceImageDiscardActionSchema = preparedAction("world-chat-reference-image-discard", ReferenceImageDiscardActionSchema);
export const WorldChatVoiceAssignmentActionSchema = preparedAction("world-chat-voice-assignment", ModelWorldChatActionSchema.options[27]);
export const WorldChatVoiceAuditionActionSchema = preparedAction("world-chat-voice-audition", ModelWorldChatActionSchema.options[28]);
export const WorldChatVoiceCloneActionSchema = preparedAction("world-chat-voice-clone", ModelWorldChatActionSchema.options[29]);
export const WorldChatVoiceClipReviewActionSchema = preparedAction("world-chat-voice-clip-review", VoiceClipReviewActionSchema);
export const WorldChatWorldArchiveActionSchema = preparedAction("world-chat-world-archive", ModelWorldChatActionSchema.options[31]);
export const WorldChatWorldExportActionSchema = preparedAction("world-chat-world-export", ModelWorldChatActionSchema.options[32]);
export const WorldChatProductionStyleActionSchema = preparedAction("world-chat-production-style", ModelWorldChatActionSchema.options[33]);

export type WorldChatWorldMetadataAction = z.infer<typeof WorldChatWorldMetadataActionSchema>;
export type WorldChatCanonAction = z.infer<typeof WorldChatCanonActionSchema>;
export type WorldChatCanonRetireAction = z.infer<typeof WorldChatCanonRetireActionSchema>;
export type WorldChatCanonRestoreAction = z.infer<typeof WorldChatCanonRestoreActionSchema>;
export type WorldChatSheetAction = z.infer<typeof WorldChatSheetActionSchema>;
export type WorldChatSheetRetireAction = z.infer<typeof WorldChatSheetRetireActionSchema>;
export type WorldChatSheetRestoreAction = z.infer<typeof WorldChatSheetRestoreActionSchema>;
export type WorldChatArtDirectionAction = z.infer<typeof WorldChatArtDirectionActionSchema>;
export type WorldChatArtDirectionRestoreAction = z.infer<typeof WorldChatArtDirectionRestoreActionSchema>;
export type WorldChatArtifactImportAction = z.infer<typeof WorldChatArtifactImportActionSchema>;
export type WorldChatArtifactMetadataAction = z.infer<typeof WorldChatArtifactMetadataActionSchema>;
export type WorldChatArtifactExtractionAction = z.infer<typeof WorldChatArtifactExtractionActionSchema>;
export type WorldChatArtifactExtractionStopAction = z.infer<typeof WorldChatArtifactExtractionStopActionSchema>;
export type WorldChatArtifactExtractionReviewAction = z.infer<typeof WorldChatArtifactExtractionReviewActionSchema>;
export type WorldChatArtifactReferenceAction = z.infer<typeof WorldChatArtifactReferenceActionSchema>;
export type WorldChatReferenceImportAction = z.infer<typeof WorldChatReferenceImportActionSchema>;
export type WorldChatReferenceResultUseAction = z.infer<typeof WorldChatReferenceResultUseActionSchema>;
export type WorldChatReferenceReviewAction = z.infer<typeof WorldChatReferenceReviewActionSchema>;
export type WorldChatReferenceChangeAction = z.infer<typeof WorldChatReferenceChangeActionSchema>;
export type WorldChatReferenceTileLockAction = z.infer<typeof WorldChatReferenceTileLockActionSchema>;
export type WorldChatReferenceCompileAction = z.infer<typeof WorldChatReferenceCompileActionSchema>;
export type WorldChatReferenceStyleAction = z.infer<typeof WorldChatReferenceStyleActionSchema>;
export type WorldChatReferenceGenerationAction = z.infer<typeof WorldChatReferenceGenerationActionSchema>;
export type WorldChatReferenceImageImportAction = z.infer<typeof WorldChatReferenceImageImportActionSchema>;
export type WorldChatReferenceWorldImageResultUseAction = z.infer<typeof WorldChatReferenceWorldImageResultUseActionSchema>;
export type WorldChatReferenceMasterLookResultUseAction = z.infer<typeof WorldChatReferenceMasterLookResultUseActionSchema>;
export type WorldChatReferenceImageDiscardAction = z.infer<typeof WorldChatReferenceImageDiscardActionSchema>;
export type WorldChatVoiceAssignmentAction = z.infer<typeof WorldChatVoiceAssignmentActionSchema>;
export type WorldChatVoiceAuditionAction = z.infer<typeof WorldChatVoiceAuditionActionSchema>;
export type WorldChatVoiceCloneAction = z.infer<typeof WorldChatVoiceCloneActionSchema>;
export type WorldChatVoiceClipReviewAction = z.infer<typeof WorldChatVoiceClipReviewActionSchema>;
export type WorldChatWorldArchiveAction = z.infer<typeof WorldChatWorldArchiveActionSchema>;
export type WorldChatWorldExportAction = z.infer<typeof WorldChatWorldExportActionSchema>;
export type WorldChatProductionStyleAction = z.infer<typeof WorldChatProductionStyleActionSchema>;

/** Existing World Chat outputs after coordinator validation, before an authority prepares them. */
export const WorldChatProposalActionSchema = z
  .object({
    kind: z.literal("world-chat-proposal"),
    worldId: UlidSchema,
    candidate: CandidateRevisionSchema,
    members: z.array(CandidateRevisionSchema).min(1),
  })
  .strict();
export type WorldChatProposalAction = z.infer<typeof WorldChatProposalActionSchema>;

export const WorldChatBibleActionSchema = z
  .object({
    kind: z.literal("world-chat-bible-edit"),
    worldId: UlidSchema,
    baseVersion: z.number().int().min(1),
    edits: z.array(BibleEditSchema).min(1),
  })
  .strict();
export type WorldChatBibleAction = z.infer<typeof WorldChatBibleActionSchema>;

export const WorldChatSceneActionSchema = z
  .object({
    kind: z.literal("world-chat-scene-edit"),
    worldId: UlidSchema,
    productionId: SlugSchema,
    sceneId: z.string().min(1),
    baseVersion: z.number().int().min(1),
    edit: ModelSceneEditSchema,
  })
  .strict();
export type WorldChatSceneAction = z.infer<typeof WorldChatSceneActionSchema>;

export const WorldChatEditorRequestActionSchema = z
  .object({
    kind: z.literal("world-chat-editor-request"),
    worldId: UlidSchema,
    productionId: SlugSchema,
    request: ModelEditorRequestSchema,
  })
  .strict();
export type WorldChatEditorRequestAction = z.infer<typeof WorldChatEditorRequestActionSchema>;

export const WorldChatPreparedActionSchema = z.discriminatedUnion("kind", [
  WorldChatProposalActionSchema,
  WorldChatBibleActionSchema,
  WorldChatSceneActionSchema,
  WorldChatEditorRequestActionSchema,
  WorldChatWorldMetadataActionSchema,
  WorldChatCanonActionSchema,
  WorldChatCanonRetireActionSchema,
  WorldChatCanonRestoreActionSchema,
  WorldChatSheetActionSchema,
  WorldChatSheetRetireActionSchema,
  WorldChatSheetRestoreActionSchema,
  WorldChatArtDirectionActionSchema,
  WorldChatArtDirectionRestoreActionSchema,
  WorldChatArtifactImportActionSchema,
  WorldChatArtifactMetadataActionSchema,
  WorldChatArtifactExtractionActionSchema,
  WorldChatArtifactExtractionStopActionSchema,
  WorldChatArtifactExtractionReviewActionSchema,
  WorldChatArtifactReferenceActionSchema,
  WorldChatReferenceImportActionSchema,
  WorldChatReferenceResultUseActionSchema,
  WorldChatReferenceReviewActionSchema,
  WorldChatReferenceChangeActionSchema,
  WorldChatReferenceTileLockActionSchema,
  WorldChatReferenceCompileActionSchema,
  WorldChatReferenceStyleActionSchema,
  WorldChatReferenceGenerationActionSchema,
  WorldChatReferenceImageImportActionSchema,
  WorldChatReferenceWorldImageResultUseActionSchema,
  WorldChatReferenceMasterLookResultUseActionSchema,
  WorldChatReferenceImageDiscardActionSchema,
  WorldChatVoiceAssignmentActionSchema,
  WorldChatVoiceAuditionActionSchema,
  WorldChatVoiceCloneActionSchema,
  WorldChatVoiceClipReviewActionSchema,
  WorldChatWorldArchiveActionSchema,
  WorldChatWorldExportActionSchema,
  WorldChatProductionStyleActionSchema,
]);
export type WorldChatPreparedAction = z.infer<typeof WorldChatPreparedActionSchema>;
