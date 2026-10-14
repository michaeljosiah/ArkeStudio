import { z } from "zod";
import { AudioTranscriptComparisonSchema, FullSha256Schema } from "./audio.js";

export const AGENT_AUDIO_SCHEMA_VERSION = 80;
export const AGENT_TRANSCRIPT_PROFILE = "arke-stt-16khz-mono-v1";
export const AGENT_TRANSCRIPT_LIMITS = Object.freeze({ characters: 12000, words: 1000, calls: 4, timeoutMs: 120000 });
export const AgentTranscriptTextSchema = z.string().trim().min(1).max(AGENT_TRANSCRIPT_LIMITS.characters)
  .refine(text => text.split(/\s+/u).length <= AGENT_TRANSCRIPT_LIMITS.words, "Speech text exceeds its word budget");
const time = z.number().finite().min(0);
export const AgentSpeechTranscriptSchema = z.object({
  streamIndex: z.number().int().min(0).max(255),
  derivative: z.object({ profile: z.literal(AGENT_TRANSCRIPT_PROFILE), hash: FullSha256Schema,
    byteLength: z.number().int().positive().max(2_000_000), sampleRate: z.literal(16000), channels: z.literal(1),
    format: z.literal("pcm-s16le-wav"), durationSec: z.number().finite().positive().max(60) }).strict(),
  engine: z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict(),
  text: AgentTranscriptTextSchema,
  wordTimeOrigin: z.literal("inspection-interval-start"),
  confidence: z.literal("uncalibrated-word-probabilities"),
  words: z.array(z.object({ text: z.string().min(1).max(500), startSec: time, endSec: time,
    probability: z.number().finite().min(0).max(1),
    sourceStartSec: time, sourceEndSec: time, viewStartSec: time, viewEndSec: time }).strict()).min(1).max(AGENT_TRANSCRIPT_LIMITS.words),
  contentReview: z.object({ basis: z.literal("recognized-speech-text"), expectedText: AgentTranscriptTextSchema,
    expectedTextHash: FullSha256Schema, comparison: AudioTranscriptComparisonSchema }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.words.reduce((count, word) => count + word.text.length, 0) > AGENT_TRANSCRIPT_LIMITS.characters) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Timed speech text exceeds its character budget" });
  }
  let previous = 0;
  for (const word of value.words) {
    if (word.endSec <= word.startSec || word.startSec < previous || word.endSec > value.derivative.durationSec + .000001) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Recognition word bounds must be ordered and inside decoded audio" });
    }
    previous = word.startSec;
  }
  const comparison = value.contentReview?.comparison;
  if (comparison && (comparison.status !== "compared" || comparison.audioHash !== value.derivative.hash ||
    comparison.targetTextHash !== value.contentReview!.expectedTextHash || comparison.observedText !== value.text ||
    comparison.transcriber.id !== value.engine.id || comparison.transcriber.version !== value.engine.version)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Speech comparison must cite the recognized derivative and engine" });
  }
});
export type AgentSpeechTranscript = z.infer<typeof AgentSpeechTranscriptSchema>;
