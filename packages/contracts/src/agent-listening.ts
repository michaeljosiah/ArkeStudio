import { z } from "zod";
import { FullSha256Schema } from "./audio.js";

/** SPEC-050 R-70..R-74: subjective listening is separate from ASR and signal QC. */
export const AGENT_LISTENING_SCHEMA_VERSION = 81;
export const AGENT_LISTENING_LIMITS = Object.freeze({ seconds: 30, calls: 2, characters: 8000, timeoutMs: 180_000 });
export const AgentListeningFocusSchema = z.enum(["music", "emotion", "voice-delivery"]);
export const AgentListeningFocusesSchema = z.array(AgentListeningFocusSchema).min(1).max(3)
  .refine(value => new Set(value).size === value.length, "Listening focuses must be unique");
export type AgentListeningFocus = z.infer<typeof AgentListeningFocusSchema>;
export const AgentListeningEngineSchema = z.object({ id: z.literal("local-qwen2-audio-v1"),
  model: z.literal("Qwen2-Audio-7B-Instruct"), modelHash: FullSha256Schema,
  runtime: z.string().min(1).max(200) }).strict();
export const AgentListeningResultSchema = z.object({ engine: AgentListeningEngineSchema,
  review: z.string().trim().min(1).max(AGENT_LISTENING_LIMITS.characters) }).strict();
export type AgentListeningResult = z.infer<typeof AgentListeningResultSchema>;
export const AgentAudioListeningSchema = z.object({ streamIndex: z.number().int().min(0).max(255),
  focuses: AgentListeningFocusesSchema,
  derivative: z.object({ profile: z.literal("arke-listening-16khz-mono-v1"), hash: FullSha256Schema,
    byteLength: z.number().int().min(46).max(960044), durationSec: z.number().finite().positive().max(30),
    sampleRate: z.literal(16000), channels: z.literal(1), format: z.literal("pcm-s16le-wav") }).strict()
    .refine(value => Math.abs(value.byteLength - (44 + value.durationSec * 32000)) < .000001, "Listening WAV size must match its PCM duration"),
  engine: AgentListeningEngineSchema, review: AgentListeningResultSchema.shape.review,
  basis: z.literal("audio-model-interpretation"), timing: z.literal("no-measured-event-times") }).strict();
export type AgentAudioListening = z.infer<typeof AgentAudioListeningSchema>;
