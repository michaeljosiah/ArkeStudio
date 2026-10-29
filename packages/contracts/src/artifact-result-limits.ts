import { z } from "zod";

/** Private receipt ceilings and bounded transfer policy (SPEC-062 R-9/R-10).
 * These are supported result ceilings, never predictions of a provider's output size. */
export const ARTIFACT_RESULT_LIMITS = Object.freeze({
  maxFiles: 64,
  maxFileBytes: 1024 ** 3,
  maxTotalBytes: 4 * 1024 ** 3,
  maxManifestBytes: 128 * 1024,
  maxRemoteMetadataBytes: 1024 * 1024,
  maxReadChunks: 128 * 1024,
});
/** Saved receipts use support ceilings, so lowering preferences cannot strand accepted bytes. */
export const ARTIFACT_RESULT_HARD_LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 2 * 1024 ** 3,
  maxTotalBytes: 8 * 1024 ** 3, maxManifestBytes: 512 * 1024 });
export const ArtifactTransferSettingsSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).default(64),
  maxFileMiB: z.number().int().min(1).max(2048).default(1024),
  maxTotalMiB: z.number().int().min(1).max(8192).default(4096),
  timeoutMinutes: z.number().int().min(1).max(240).default(30),
}).strict().refine(value => value.maxFileMiB <= value.maxTotalMiB, "The total result limit must cover one file.");
export type ArtifactTransferSettings = z.infer<typeof ArtifactTransferSettingsSchema>;
export function artifactTransferLimits(settings: ArtifactTransferSettings = ArtifactTransferSettingsSchema.parse({})) {
  const parsed = ArtifactTransferSettingsSchema.parse(settings);
  return { maxFiles: parsed.maxFiles, maxFileBytes: parsed.maxFileMiB * 1024 ** 2,
    maxTotalBytes: parsed.maxTotalMiB * 1024 ** 2, timeoutMs: parsed.timeoutMinutes * 60_000 };
}
export const ARTIFACT_RETRIEVAL_HELD_MESSAGE = "The provider completed, but its result exceeds Arke's result transfer limits. Its provider identity is retained. Review Advanced recovery settings or the provider result before closing Arke; no generation was repeated.";

/** Bytes the next file may retain after earlier files already consumed the response budget. */
export function artifactResultReadLimit(receivedBytes: number, limits: { maxFileBytes: number; maxTotalBytes: number } = ARTIFACT_RESULT_LIMITS): number {
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || receivedBytes > limits.maxTotalBytes) throw new Error("Invalid artifact transfer accounting.");
  return Math.min(limits.maxFileBytes, limits.maxTotalBytes - receivedBytes);
}
