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

/** The existing Arke Player fit, shared with the explicitly chosen EPUB reading profile. */
export async function fitReadingImage(source: string, destination: string, keepsAlpha: boolean, ffmpeg: FfmpegRunner, signal: AbortSignal): Promise<void> {
  const { maxEdge, jpegQuality } = STORY_EPUB_READING_PROFILE;
  const fit = `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`;
  await ffmpeg.run(["-y", "-i", source, "-vf", fit, "-frames:v", "1", "-update", "1", ...(keepsAlpha ? [] : ["-q:v", String(jpegQuality)]), destination], () => {}, signal);
}
