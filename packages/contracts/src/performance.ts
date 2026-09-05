import { z } from "zod";
import { prefixedIdSchema, SlugSchema, SceneIdSchema, ShotIdSchema, IsoDateTimeSchema, JobIdSchema } from "./ids.js";
import { AudioAssetProvenanceSchema, AudioTranscriptComparisonSchema, AudioAttestationSchema, FullSha256Schema } from "./audio.js";
import { TakeCostSchema } from "./take.js";
import { VoiceAssignmentSchema } from "./world.js";
import { orderedShots, type SceneRecord } from "./scene-flow.js";

export const PerformanceIdSchema = prefixedIdSchema("pf");
export const PerformanceTargetSchema = z.object({
  productionId: SlugSchema, sceneId: SceneIdSchema, sceneVersion: z.number().int().positive(), shotId: ShotIdSchema,
  speakerSheetId: SlugSchema, blockId: z.string().min(1).optional(), authoredTextHash: FullSha256Schema,
}).strict();
export const PerformanceRecordBaseSchema = z.object({
  id: PerformanceIdSchema, target: PerformanceTargetSchema,
  file: z.string().regex(/^sha256-[a-f0-9]{64}\.wav$/), provenance: AudioAssetProvenanceSchema,
  createdAt: IsoDateTimeSchema,
  captureAcknowledgement: z.object({ basis: z.enum(["self", "authorized", "licensed"]), statementVersion: z.literal(1), at: IsoDateTimeSchema }).strict(),
  transcript: AudioTranscriptComparisonSchema.optional(), wordingConfirmedAt: IsoDateTimeSchema.optional(),
}).strict();
export const ScratchPerformanceSchema = PerformanceRecordBaseSchema.extend({ kind: z.literal("scratch"), recordedAt: IsoDateTimeSchema }).strict();
export const SpeechToSpeechPerformanceSchema = PerformanceRecordBaseSchema.extend({
  kind: z.literal("speech-to-speech"), sourcePerformanceId: PerformanceIdSchema, sourcePerformanceHash: FullSha256Schema,
  jobId: JobIdSchema, voiceAssignment: VoiceAssignmentSchema,
  conversion: z.object({ provider: z.literal("elevenlabs"), model: z.string().min(1),
    retention: z.enum(["provider-history", "zero-retention"]), preservesTiming: z.boolean(), preservesProsody: z.boolean() }).strict(),
  cost: TakeCostSchema,
}).strict();
export const PerformanceRecordSchema = z.discriminatedUnion("kind", [ScratchPerformanceSchema, SpeechToSpeechPerformanceSchema]);
export type PerformanceRecord = z.infer<typeof PerformanceRecordSchema>;
export type PerformanceTarget = z.infer<typeof PerformanceTargetSchema>;

export const PerformanceConversionInputSchema = z.object({
  sourcePerformanceId: PerformanceIdSchema, sourceHash: FullSha256Schema, outputPerformanceId: PerformanceIdSchema,
  target: PerformanceTargetSchema, voiceAssignment: VoiceAssignmentSchema,
  acknowledgementId: z.string().min(1), warningCodes: z.array(z.string()), attestations: z.array(AudioAttestationSchema),
  wordingConfirmedAt: IsoDateTimeSchema, retention: z.enum(["provider-history", "zero-retention"]),
}).strict();

/** Stable script blocks win when coverage exists. Multiple lines require an explicit block choice. */
export function resolvePerformanceLine(scene: SceneRecord, shotId: string, blockId?: string):
  { ok: true; text: string; speakerSheetId: string; blockId?: string } | { ok: false; reason: string } {
  const shot = orderedShots(scene).find(s => s.id === shotId);
  if (!shot) return { ok: false, reason: "This shot is no longer in the scene." };
  if (shot.covers?.length) {
    const blocks = shot.covers.map(c => scene.script?.blocks.find(b => b.id === c.blockId));
    if (blocks.some(b => !b)) return { ok: false, reason: "Repair this shot's missing script coverage first." };
    const dialogue = blocks.filter(b => b?.kind === "dialogue" && (blockId === undefined || b.id === blockId));
    const line = dialogue[0];
    if (dialogue.length !== 1 || !line?.speaker) return { ok: false, reason: "Choose one covered dialogue block with a named speaker." };
    return { ok: true, text: line.text, speakerSheetId: line.speaker, blockId: line.id };
  }
  if (blockId !== undefined || !["dialogue", "vo"].includes(shot.audio?.kind ?? "") || !shot.audio?.speaker || !shot.audio.line?.trim()) {
    return { ok: false, reason: "This shot needs one authored spoken line and a named character." };
  }
  return { ok: true, text: shot.audio.line, speakerSheetId: shot.audio.speaker };
}

export const PerformancePurgeSchema = z.object({
  performanceId: PerformanceIdSchema, purgedAt: IsoDateTimeSchema,
  reason: z.enum(["user-request", "capture-discarded"]),
}).strict();

export function performanceLineKey(target: Pick<PerformanceTarget, "sceneId" | "shotId" | "blockId">): string {
  return `${target.sceneId}/${target.shotId}/${target.blockId ?? "legacy"}`;
}
export const PerformanceReviewDecisionSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), ts: IsoDateTimeSchema,
  performanceId: PerformanceIdSchema, target: PerformanceTargetSchema,
  decision: z.enum(["accept", "reject"]), by: z.literal("user"), note: z.string().max(1000).optional(),
}).strict();
export const PerformanceSelectionSchema = z.object({
  performanceId: PerformanceIdSchema.nullable(), target: PerformanceTargetSchema,
  selectedAt: IsoDateTimeSchema, selectedBy: z.literal("user"),
}).strict();
export const PerformanceSelectionsSchema = z.record(z.string().min(1).max(300), PerformanceSelectionSchema);
export const PerformanceReviewStateSchema = z.object({
  reviews: z.array(PerformanceReviewDecisionSchema), selections: PerformanceSelectionsSchema,
  reviewHash: z.string().nullable(), selectionHash: z.string().nullable(),
}).strict();
export function emptyPerformanceReviewState(): z.infer<typeof PerformanceReviewStateSchema> {
  return { reviews: [], selections: {}, reviewHash: null, selectionHash: null };
}
export type PerformanceReviewState = z.infer<typeof PerformanceReviewStateSchema>;
