import type { ManifestModel } from "./manifest.js";
import { z } from "zod";
import { AudioAssetProvenanceSchema, AudioAttestationSchema, AudioRangeSchema } from "./audio.js";
import { ArtifactIdSchema, IsoDateTimeSchema, SlugSchema, TakeIdSchema } from "./ids.js";

export const VoiceSampleSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy-character-sample"), sheetId: SlugSchema, range: AudioRangeSchema.optional() }).strict(),
  z.object({ kind: z.literal("artifact"), artifactId: ArtifactIdSchema, range: AudioRangeSchema.optional() }).strict(),
  z.object({ kind: z.literal("production-take"), productionId: SlugSchema, takeId: TakeIdSchema, range: AudioRangeSchema }).strict(),
]);
export const CharacterVoiceSampleSchema = z.object({
  schemaVersion: z.literal(1), file: z.string().regex(/^voice\/sha256-[a-f0-9]{64}\.wav$/),
  operationId: z.string().uuid(),
  provenance: AudioAssetProvenanceSchema, designatedAt: IsoDateTimeSchema,
  warningCodes: z.array(z.string()), attestations: z.array(AudioAttestationSchema),
  acknowledgementId: z.string().min(1).optional(),
}).strict();
export type CharacterVoiceSample = z.infer<typeof CharacterVoiceSampleSchema>;

export const VoiceSampleReviewSchema = z.object({
  operationId: z.string().uuid(), sheetId: SlugSchema,
  sourceFile: z.string().min(1), preparedFile: z.string().min(1),
  provenance: AudioAssetProvenanceSchema,
}).strict();
export type VoiceSampleReview = z.infer<typeof VoiceSampleReviewSchema>;

/** Only routes verified for imagery + generated speech. Model data still owns price/durations. */
export function supportsCharacterSpeakingVideo(model: ManifestModel): boolean {
  return model.provider === "fal" && ["seedance-2.0", "seedance-2.0-fast"].includes(model.id) &&
    model.accepts.referenceImages > 0 && model.limits.soundChoice === true;
}
