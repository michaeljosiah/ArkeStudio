import { z } from "zod";
import { SlugSchema, UlidSchema } from "./ids.js";
import { EffectVersionRefSchema, EffectHumanIntentSchema, EffectReviewGrantSchema, EffectApplyReceiptSchema } from "./editor-effect-proposal.js";

/** Authenticated editor route only. Model action schemas never reference this union. */
export const EffectReviewOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), ref: EffectVersionRefSchema }).strict(),
  z.object({ kind: z.literal("edit"), ref: EffectVersionRefSchema, intent: EffectHumanIntentSchema, reviewId: z.string().min(1).max(160).optional() }).strict(),
  z.object({ kind: z.literal("history"), ref: EffectVersionRefSchema, direction: z.enum(["undo", "redo"]), reviewId: z.string().min(1).max(160).optional() }).strict(),
  z.object({ kind: z.literal("update"), ref: EffectVersionRefSchema }).strict(),
  z.object({ kind: z.literal("retry"), ref: EffectVersionRefSchema }).strict(),
  z.object({ kind: z.literal("discard"), ref: EffectVersionRefSchema }).strict(),
  z.object({ kind: z.literal("apply"), ref: EffectVersionRefSchema, reviewId: z.string().min(1).max(160) }).strict(),
]);
export const EffectReviewCommandSchema = z.object({ kind: z.literal("editor-effect-proposal"), worldId: UlidSchema,
  productionId: SlugSchema, requestId: z.string().min(1).max(128), operation: EffectReviewOperationSchema }).strict();
export type EffectReviewCommand = z.infer<typeof EffectReviewCommandSchema>;
export type EffectReviewOperation = z.infer<typeof EffectReviewOperationSchema>;
export const EffectReviewResultSchema = z.object({ type: z.literal("editor-effect.proposal-result"), at: z.string(),
  worldId: UlidSchema, productionId: SlugSchema, requestId: z.string().min(1).max(128),
  outcome: z.enum(["reviewed", "updated", "applied", "discarded", "refused"]), ref: EffectVersionRefSchema.optional(),
  grant: EffectReviewGrantSchema.optional(), receipt: EffectApplyReceiptSchema.optional(), reason: z.string().max(1000).optional() }).strict();
export type EffectReviewResult = z.infer<typeof EffectReviewResultSchema>;
