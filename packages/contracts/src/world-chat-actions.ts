import { z } from "zod";
import { BibleEditSchema } from "./bible.js";
import { ModelEditorRequestSchema, ModelSceneEditSchema } from "./editor-request.js";
import { CandidateIdSchema, SlugSchema, UlidSchema } from "./ids.js";

const CandidateRevisionSchema = z
  .object({ candidateId: CandidateIdSchema, revision: z.number().int().min(1) })
  .strict();

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
]);
export type WorldChatPreparedAction = z.infer<typeof WorldChatPreparedActionSchema>;
