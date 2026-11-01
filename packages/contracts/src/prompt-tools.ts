import { z } from "zod";
import { BenchModeSchema, BenchParamsSchema } from "./bench.js";
import { SlugSchema, SceneIdSchema, ShotIdSchema, SessionIdSchema, TakeIdSchema } from "./ids.js";

const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PromptCapabilitySchema = z.enum(["image", "video"]);
export const PromptTargetSchema = z.object({ productionId: SlugSchema, sceneId: SceneIdSchema, shotId: ShotIdSchema,
  capability: PromptCapabilitySchema }).strict();
export type PromptTarget = z.infer<typeof PromptTargetSchema>;
export const PromptOverrideSnapshotSchema = z.object({ text: z.string().min(1).max(200_000), capability: PromptCapabilitySchema.optional(),
  sheetVersions: z.record(SlugSchema, z.number().int().positive()) }).strict();
export const ShotPromptHistorySchema = z.object({
  target: PromptTargetSchema, currentVersion: z.number().int().positive(), currentHash: Hash,
  assembledBody: z.string().max(200_000), assembledHash: Hash,
  currentBody: z.string().max(200_000), currentOverride: PromptOverrideSnapshotSchema.nullable(), partial: z.boolean(),
  entries: z.array(z.object({ version: z.number().int().positive(), hash: Hash.optional(),
    prompt: PromptOverrideSnapshotSchema.nullable().optional(), unavailable: z.boolean() }).strict()).max(101),
}).strict();
export type ShotPromptHistory = z.infer<typeof ShotPromptHistorySchema>;
export const PromptComposerDraftSchema = z.object({ mode: BenchModeSchema, provider: z.string().max(256), model: z.string().max(256),
  params: BenchParamsSchema, brief: z.string().max(200_000) }).strict();
export const PromptInspectSourceSchema = z.discriminatedUnion("kind", [
  PromptTargetSchema.extend({ kind: z.literal("shot") }).strict(),
  z.object({ kind: z.literal("bench"), sessionId: SessionIdSchema, composer: PromptComposerDraftSchema }).strict(),
  z.object({ kind: z.literal("take"), sessionId: SessionIdSchema, takeId: TakeIdSchema }).strict(),
]);
export type PromptInspectSource = z.infer<typeof PromptInspectSourceSchema>;
export const PromptInspectionSchema = z.object({
  source: z.enum(["saved-shot", "generator-draft", "frozen-request"]), identity: z.string().min(1).max(256),
  capability: PromptCapabilitySchema, provider: z.string().max(256), model: z.string().max(256),
  prompt: z.string().min(1).max(200_000), quantity: z.number().int().positive(),
  controls: z.array(z.object({ label: z.string().max(100), value: z.string().max(1000) }).strict()).max(20),
  references: z.array(z.object({ field: z.string().max(100), index: z.number().int().positive().optional(),
    subject: z.string().max(300), role: z.string().max(600), file: z.string().max(2000).optional(),
    hash: z.string().max(100).optional(), sheetVersion: z.number().int().positive().optional(), sent: z.boolean(), reason: z.string().max(1000).optional(),
  }).strict()).max(128),
  notices: z.array(z.string().max(1000)).max(20),
}).strict();
export type PromptInspection = z.infer<typeof PromptInspectionSchema>;
export const PromptToolsResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("history"), history: ShotPromptHistorySchema }).strict(),
  z.object({ kind: z.literal("inspection"), inspection: PromptInspectionSchema }).strict(),
  z.object({ kind: z.literal("restored"), version: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("failed"), reason: z.string().min(1).max(1000) }).strict(),
]);
export type PromptToolsResult = z.infer<typeof PromptToolsResultSchema>;
