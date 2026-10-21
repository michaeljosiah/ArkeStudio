/** Archive, extraction and independent installation coexist until the copy is complete. */
export function storyDownloadRequiredBytes(source: { bytes: number; unpackedBytes: number }, retainedBytes = 0): number {
  const required = source.bytes + source.unpackedBytes * 2 + 64 * 1024 * 1024;
  if (![source.bytes, source.unpackedBytes, retainedBytes, required].every(Number.isSafeInteger) ||
      source.bytes <= 0 || source.unpackedBytes <= 0 || retainedBytes < 0 || retainedBytes > source.bytes) {
    throw new Error("Invalid story download size.");
  }
  return required - retainedBytes;
}
