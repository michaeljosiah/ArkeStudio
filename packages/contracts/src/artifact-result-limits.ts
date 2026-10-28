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
export const ARTIFACT_RETRIEVAL_HELD_MESSAGE = "The provider completed, but its result exceeds Arke's supported transfer or receipt limits. Its provider identity is retained. Review the provider result before closing Arke; no generation was repeated.";

/** Bytes the next file may retain after earlier files already consumed the response budget. */
export function artifactResultReadLimit(receivedBytes: number): number {
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || receivedBytes > ARTIFACT_RESULT_LIMITS.maxTotalBytes) throw new Error("Invalid artifact transfer accounting.");
  return Math.min(ARTIFACT_RESULT_LIMITS.maxFileBytes, ARTIFACT_RESULT_LIMITS.maxTotalBytes - receivedBytes);
}
