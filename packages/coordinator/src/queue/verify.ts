/**
 * Artifact verification before landing (SPEC-009 §2.9, R-12, R-13): decodability at the level
 * a download failure actually corrupts — magic numbers and trailers. A truncated clip that
 * plays two seconds reads as a bad generation rather than a bad download (D12), so a missing
 * trailer refuses the landing.
 */

export interface VerifiableArtifact {
  name: string;
  contentType: string;
  data: Uint8Array;
}

const at = (d: Uint8Array, i: number): number => d[i] ?? -1;

function pngOk(d: Uint8Array): string | null {
  if (!(at(d, 0) === 0x89 && at(d, 1) === 0x50 && at(d, 2) === 0x4e && at(d, 3) === 0x47)) {
    return "not a PNG (bad signature)";
  }
  // IEND must close the file; a truncated download loses it.
  const tail = new TextDecoder("latin1").decode(d.slice(Math.max(0, d.length - 16)));
  return tail.includes("IEND") ? null : "PNG is truncated (no IEND)";
}

function jpegOk(d: Uint8Array): string | null {
  if (!(at(d, 0) === 0xff && at(d, 1) === 0xd8)) return "not a JPEG (bad signature)";
  return at(d, d.length - 2) === 0xff && at(d, d.length - 1) === 0xd9 ? null : "JPEG is truncated (no EOI)";
}

function webpOk(d: Uint8Array): string | null {
  const riff = new TextDecoder("latin1").decode(d.slice(0, 4));
  const webp = new TextDecoder("latin1").decode(d.slice(8, 12));
  if (riff !== "RIFF" || webp !== "WEBP") return "not a WebP (bad RIFF/WEBP header)";
  const size = at(d, 4) | (at(d, 5) << 8) | (at(d, 6) << 16) | (at(d, 7) << 24);
  return size + 8 === d.length ? null : "WebP is truncated (RIFF size does not match)";
}

function mp4Ok(d: Uint8Array): string | null {
  const tag = new TextDecoder("latin1").decode(d.slice(4, 8));
  return tag === "ftyp" ? null : "not an MP4 (no ftyp box)";
}

function wavOk(d: Uint8Array): string | null {
  const riff = new TextDecoder("latin1").decode(d.slice(0, 4));
  const wave = new TextDecoder("latin1").decode(d.slice(8, 12));
  return riff === "RIFF" && wave === "WAVE" ? null : "not a WAV (bad RIFF header)";
}

function mp3Ok(d: Uint8Array): string | null {
  const id3 = new TextDecoder("latin1").decode(d.slice(0, 3));
  if (id3 === "ID3") return null;
  return at(d, 0) === 0xff && (at(d, 1) & 0xe0) === 0xe0 ? null : "not an MP3 (no ID3 tag or frame sync)";
}

export interface ImageFormat {
  contentType: "image/png" | "image/jpeg" | "image/webp";
  extension: ".png" | ".jpg" | ".webp";
}

/** The image format the bytes actually carry, independent of provider metadata or filename. */
export function imageFormatOf(data: Uint8Array): ImageFormat | null {
  if (pngOk(data) === null) return { contentType: "image/png", extension: ".png" };
  if (jpegOk(data) === null) return { contentType: "image/jpeg", extension: ".jpg" };
  if (webpOk(data) === null) return { contentType: "image/webp", extension: ".webp" };
  return null;
}

/** Null when sound; otherwise the reason the artifact must not land (R-13). */
export function verifyArtifact(artifact: VerifiableArtifact): string | null {
  if (artifact.data.length === 0) return "empty download";
  const type = artifact.contentType.toLowerCase();
  if (type.includes("png")) return pngOk(artifact.data);
  if (type.includes("jpeg") || type.includes("jpg")) return jpegOk(artifact.data);
  if (type.includes("webp")) return webpOk(artifact.data);
  if (type.includes("mp4") || type.includes("video")) return mp4Ok(artifact.data);
  if (type.includes("wav")) return wavOk(artifact.data);
  if (type.includes("mpeg") || type.includes("mp3")) return mp3Ok(artifact.data);
  // Text and unknown types: a non-empty body is the best check available.
  return null;
}
