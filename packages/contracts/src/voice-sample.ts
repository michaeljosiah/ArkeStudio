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

/**
 * What a speaking sample actually needs of a route: it must carry the character's face, and its
 * output must have sound. Both are declared capabilities.
 *
 * Sound is two declarations rather than one, because offering a switch and emitting sound are
 * different facts (issue 863). The cloud routes publish `generate_audio` and say `soundChoice`;
 * H3 publishes no switch and simply always makes sound, and had to say so before it could be
 * admitted — a route that always makes sound answers "will there be a voice" more completely than
 * one that merely could be asked.
 *
 * This used to also pin one provider and two model ids, and that clause was the whole bar in
 * practice — a route could satisfy both capabilities and still be told "No verified speech-video
 * route is currently available" for not being on the list (issue 858). Whether the speech is any
 * *good* is a separate, declared judgement: the row's `speechVideo`.
 *
 * An unverified row is excluded for the same reason it carries no references anywhere else: its
 * declared count was never checked, so dispatch drops the face and the sample would be of nobody.
 */
export function supportsCharacterSpeakingVideo(model: ManifestModel): boolean {
  return model.capability === "video" && model.unverified !== true &&
    model.accepts.referenceImages > 0 &&
    (model.limits.soundChoice === true || model.limits.alwaysSound === true);
}

/**
 * Verified routes first, then untested ones, each group in catalogue order — a picker renders
 * this list as it comes. Untested routes are offered rather than hidden, and the surface that
 * offers them has to say so.
 */
export function characterSpeakingVideoRoutes(models: readonly ManifestModel[]): ManifestModel[] {
  const able = models.filter(supportsCharacterSpeakingVideo);
  return [...able.filter(m => m.speechVideo === "verified"), ...able.filter(m => m.speechVideo !== "verified")];
}
