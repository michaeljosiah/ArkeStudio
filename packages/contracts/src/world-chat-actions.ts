import { z } from "zod";
import { AudioPolicySchema, FailureModesSchema, KeyArtIntentSchema } from "./art-direction.js";
import { BibleEditSchema } from "./bible.js";
import { ModelEditorRequestSchema, ModelSceneEditSchema } from "./editor-request.js";
import { CandidateIdSchema, CanonIdSchema, CheckReceiptIdSchema, SlugSchema, UlidSchema } from "./ids.js";
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

export const ModelWorldChatActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world-metadata"), changes: WorldAuthoredFieldChangesSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("canon"), change: CanonChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("canon-retire"), entryId: CanonIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("canon-restore"), entryId: CanonIdSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("sheet"), change: SheetChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("sheet-retire"), sheetType: SheetKindSchema, sheetId: SlugSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("sheet-restore"), sheetType: SheetKindSchema, sheetId: SlugSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("art-direction"), changes: ArtDirectionChangesSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("art-direction-restore"), version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict(),
]);
export type ModelWorldChatAction = z.infer<typeof ModelWorldChatActionSchema>;

const preparedAction = <K extends string, T extends z.ZodTypeAny>(kind: K, action: T) => z
  .object({ kind: z.literal(kind), worldId: UlidSchema, action })
  .strict();

export const WorldChatWorldMetadataActionSchema = preparedAction(
  "world-chat-world-metadata",
  ModelWorldChatActionSchema.options[0],
);
export const WorldChatCanonActionSchema = preparedAction("world-chat-canon", ModelWorldChatActionSchema.options[1]);
export const WorldChatCanonRetireActionSchema = preparedAction("world-chat-canon-retire", ModelWorldChatActionSchema.options[2]);
export const WorldChatCanonRestoreActionSchema = preparedAction("world-chat-canon-restore", ModelWorldChatActionSchema.options[3]);
export const WorldChatSheetActionSchema = preparedAction("world-chat-sheet", ModelWorldChatActionSchema.options[4]);
export const WorldChatSheetRetireActionSchema = preparedAction("world-chat-sheet-retire", ModelWorldChatActionSchema.options[5]);
export const WorldChatSheetRestoreActionSchema = preparedAction("world-chat-sheet-restore", ModelWorldChatActionSchema.options[6]);
export const WorldChatArtDirectionActionSchema = preparedAction("world-chat-art-direction", ModelWorldChatActionSchema.options[7]);
export const WorldChatArtDirectionRestoreActionSchema = preparedAction("world-chat-art-direction-restore", ModelWorldChatActionSchema.options[8]);

export type WorldChatWorldMetadataAction = z.infer<typeof WorldChatWorldMetadataActionSchema>;
export type WorldChatCanonAction = z.infer<typeof WorldChatCanonActionSchema>;
export type WorldChatCanonRetireAction = z.infer<typeof WorldChatCanonRetireActionSchema>;
export type WorldChatCanonRestoreAction = z.infer<typeof WorldChatCanonRestoreActionSchema>;
export type WorldChatSheetAction = z.infer<typeof WorldChatSheetActionSchema>;
export type WorldChatSheetRetireAction = z.infer<typeof WorldChatSheetRetireActionSchema>;
export type WorldChatSheetRestoreAction = z.infer<typeof WorldChatSheetRestoreActionSchema>;
export type WorldChatArtDirectionAction = z.infer<typeof WorldChatArtDirectionActionSchema>;
export type WorldChatArtDirectionRestoreAction = z.infer<typeof WorldChatArtDirectionRestoreActionSchema>;

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
]);
export type WorldChatPreparedAction = z.infer<typeof WorldChatPreparedActionSchema>;
