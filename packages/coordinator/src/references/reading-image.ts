import { STORY_EPUB_READING_PROFILE } from "@arke-studio/contracts";
import type { FfmpegRunner } from "../takes/export.js";

/** A PNG's alpha channel or tRNS chunk must survive reading-size exports. */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return false;
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= view.length;) {
    const length = view.readUInt32BE(at), type = view.toString("latin1", at + 4, at + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + length;
  }
  return false;
}

/** Whether a WebP carries alpha: the VP8X alpha flag, or a lossless image's alpha bit (SPEC-058 R-6). */
export function webpHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.length < 30) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") return false;
  const chunk = view.toString("latin1", 12, 16);
  if (chunk === "VP8X") return (view[20]! & 0x10) !== 0;
  if (chunk === "VP8L") return ((view.readUInt32LE(21) >>> 28) & 1) === 1;
  return false;
}

/** The existing Arke Player fit, shared with the explicitly chosen EPUB reading profile. */
export async function fitReadingImage(source: string, destination: string, keepsAlpha: boolean, ffmpeg: FfmpegRunner, signal: AbortSignal, maxEdge: number = STORY_EPUB_READING_PROFILE.maxEdge): Promise<void> {
  const { jpegQuality } = STORY_EPUB_READING_PROFILE;
  const fit = `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`;
  await ffmpeg.run(["-y", "-i", source, "-vf", fit, "-frames:v", "1", "-update", "1", ...(keepsAlpha ? [] : ["-q:v", String(jpegQuality)]), destination], () => {}, signal);
}
