export const FOUNDING_IMAGES_SCHEMA_VERSION = 30;
import { z } from "zod";

export const GenesisImageTargetSchema = z.string().regex(/^(character|location):[a-z0-9][a-z0-9-]*$/);
export const GenesisImageIntentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80),
  target: GenesisImageTargetSchema,
  prompt: z.string().min(1).max(8000),
  references: z.array(z.string().regex(/^[^/\\]+\.(png|jpg|jpeg|webp)$/i)).max(8).default([]),
}).strict();
export type GenesisImageIntent = z.infer<typeof GenesisImageIntentSchema>;
export const GenesisImageCandidateSchema = z.object({
  id: z.string().min(1), file: z.string().regex(/^media\/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$/),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), label: z.string(),
  source: z.enum(["upload", "generated"]),
  target: GenesisImageTargetSchema.optional(),
  jobId: z.string().optional(), prompt: z.string().optional(), provider: z.string().optional(), model: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(), estimatedMicroUsd: z.number().int().min(0).optional(),
  createdAt: z.string().datetime(),
}).strict();
export type GenesisImageCandidate = z.infer<typeof GenesisImageCandidateSchema>;
export const GenesisImageSelectionSchema = z.object({
  target: GenesisImageTargetSchema, candidate: GenesisImageCandidateSchema,
}).strict();
export type GenesisImageSelection = z.infer<typeof GenesisImageSelectionSchema>;
export const GenesisImagePlanSchema = z.object({
  intent: GenesisImageIntentSchema, title: z.string(), role: z.enum(["Main photo", "Establishing view"]),
  digest: z.string(), model: z.string(), provider: z.string(), modelName: z.string(), prompt: z.string(),
  output: z.record(z.string(), z.unknown()), references: z.array(GenesisImageCandidateSchema),
  estimatedMicroUsd: z.number().int().min(0),
}).strict();
export type GenesisImagePlan = z.infer<typeof GenesisImagePlanSchema>;
export const GenesisImagesSchema = z.object({
  plans: z.array(GenesisImagePlanSchema), candidates: z.array(GenesisImageCandidateSchema),
  selections: z.array(GenesisImageSelectionSchema), rejected: z.array(z.string()), problems: z.array(z.string()),
}).strict();
export type GenesisImages = z.infer<typeof GenesisImagesSchema>;
