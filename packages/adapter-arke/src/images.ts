/**
 * What an image costs in a vision model's prompt, estimated from its dimensions (issue 1247).
 *
 * Vision encoders differ: some take a fixed few hundred tokens whatever the size, others tile
 * or patch the image and grow with it — a large screenshot can become thousands of tokens. None
 * is known here, so the estimate takes the growing kind at its most expensive common rate, one
 * token per 16×16 pixels, and never less than a fixed-cost encoder's charge. The ceiling is the
 * most a dynamic-resolution encoder is usually allowed to spend on one image. An image whose
 * size cannot be read is charged the ceiling: it is the case where being wrong costs the
 * instructions, so it is never the case to be optimistic about.
 */
const PIXELS_PER_TOKEN_SIDE = 16;
const MIN_IMAGE_TOKENS = 768;
export const MAX_IMAGE_TOKENS = 16_384;

export function imageTokens(base64: string): number {
  const size = imageSize(Buffer.from(base64, "base64"));
  if (!size) return MAX_IMAGE_TOKENS;
  const patches = Math.ceil(size.width / PIXELS_PER_TOKEN_SIDE) * Math.ceil(size.height / PIXELS_PER_TOKEN_SIDE);
  return Math.min(MAX_IMAGE_TOKENS, Math.max(MIN_IMAGE_TOKENS, patches));
}

/** Width and height from the header of the four formats a confined read returns as images. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  // PNG: the IHDR chunk is first, and holds both as big-endian 32-bit integers.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") {
    return sized(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  // GIF: the logical screen size, little-endian, straight after the signature.
  if (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "GIF") return sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8X") return sized(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    if (chunk === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return sized(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    if (chunk === "VP8 ") return sized(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    return null;
  }
  // JPEG: walk the markers to the first start-of-frame, which carries height then width.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      // Fill bytes before a marker.
      if (marker === 0xff) { at++; continue; }
      const length = bytes.readUInt16BE(at + 2);
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return sized(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5));
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}

function sized(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}
