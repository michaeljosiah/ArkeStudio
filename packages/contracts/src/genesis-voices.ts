import { z } from "zod";
import { VoiceCandidateSchema } from "./voice.js";

export const FOUNDING_VOICES_SCHEMA_VERSION = 38;
export const GenesisVoiceIdentitySchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), voiceId: z.string().min(1),
}).strict();
export const GenesisVoiceIntentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100),
  target: z.string().regex(/^character:[a-z0-9][a-z0-9-]*$/),
  voice: GenesisVoiceIdentitySchema, text: z.string().trim().min(1).max(1000),
}).strict();
export const GenesisVoicePlanSchema = z.object({
  intent: GenesisVoiceIntentSchema, title: z.string(), voice: VoiceCandidateSchema,
  text: z.string(), estimatedMicroUsd: z.number().int().nonnegative(),
  format: z.enum(["wav", "mp3", "flac"]), digest: z.string(), transfer: z.string(),
}).strict();
export const GenesisVoiceCandidateSchema = z.object({
  id: z.string(), plan: GenesisVoicePlanSchema,
  file: z.string().regex(/^media\/[a-f0-9]{64}\.(wav|mp3|flac)$/),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), createdAt: z.string(),
  jobId: z.string().optional(),
}).strict();
export const GenesisVoicesSchema = z.object({
  catalogue: z.array(VoiceCandidateSchema), plans: z.array(GenesisVoicePlanSchema),
  candidates: z.array(GenesisVoiceCandidateSchema),
  selections: z.array(GenesisVoiceCandidateSchema), rejected: z.array(z.string()),
  problems: z.array(z.string()),
  attempts: z.record(z.object({ digest: z.string(), status: z.enum(["running", "completed", "failed"]), detail: z.string().optional() }).strict()),
}).strict();
export type GenesisVoicePlan = z.infer<typeof GenesisVoicePlanSchema>;
export type GenesisVoiceCandidate = z.infer<typeof GenesisVoiceCandidateSchema>;
export type GenesisVoices = z.infer<typeof GenesisVoicesSchema>;
