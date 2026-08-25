/**
 * Landed-media sanitisation (SPEC-021 §2.10, R-14). ComfyUI's save nodes embed the prompt
 * graph and workflow into output metadata server-side — PNG text chunks, WebP metadata chunks,
 * MP4 metadata boxes — so a managed launch flag cannot cover a user-directed engine, and the
 * bytes are cleaned here, before anything lands.
 *
 * The containers handled are a closed set because the recipes are Arke-authored: PNG and WebP
 * for images, MP4 for video, and FLAC for cloned speech. Anything else is refused with the container named — an unknown
 * container from a recipe is a recipe bug to fix, not a leak to permit.
 */

export type SanitizeResult = { ok: true; data: Uint8Array; strippedBytes: number } | { ok: false; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(data: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((b, i) => data[offset + i] === b);
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function u32(data: Uint8Array, offset: number): number {
  return (data[offset]! << 24 | data[offset + 1]! << 16 | data[offset + 2]! << 8 | data[offset + 3]!) >>> 0;
}

function u32le(data: Uint8Array, offset: number): number {
  return (data[offset]! | data[offset + 1]! << 8 | data[offset + 2]! << 16 | data[offset + 3]! << 24) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG: drop every text chunk. tEXt/zTXt/iTXt is where `prompt` and `workflow` live, and no
// text chunk is load-bearing for a take.
// ---------------------------------------------------------------------------

const PNG_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);

function sanitizePng(data: Uint8Array): SanitizeResult {
  const parts: Uint8Array[] = [data.subarray(0, 8)];
  let offset = 8;
  let stripped = 0;
  while (offset + 8 <= data.length) {
    const length = u32(data, offset);
    const type = ascii(data, offset + 4, 4);
    const total = 12 + length; // length + type + payload + crc
    if (offset + total > data.length) return { ok: false, reason: "png: a chunk overruns the file" };
    if (PNG_TEXT_CHUNKS.has(type)) stripped += total;
    else parts.push(data.subarray(offset, offset + total));
    offset += total;
    if (type === "IEND") break;
  }
  return { ok: true, data: concat(parts), strippedBytes: stripped };
}

// ---------------------------------------------------------------------------
// WebP: a RIFF container; EXIF and XMP chunks carry the workflow. The RIFF size and the VP8X
// flags are corrected so the survivor is a well-formed file, not a truncation.
// ---------------------------------------------------------------------------

function sanitizeWebp(data: Uint8Array): SanitizeResult {
  if (data.length < 12 || ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "WEBP") {
    return { ok: false, reason: "webp: not a RIFF/WEBP container" };
  }
  const chunks: Array<{ id: string; body: Uint8Array }> = [];
  let offset = 12;
  let stripped = 0;
  while (offset + 8 <= data.length) {
    const id = ascii(data, offset, 4);
    const size = u32le(data, offset + 4);
    const padded = size + (size % 2); // RIFF chunks are word-aligned
    if (offset + 8 + padded > data.length) return { ok: false, reason: "webp: a chunk overruns the file" };
    if (id === "EXIF" || id === "XMP ") stripped += 8 + padded;
    else chunks.push({ id, body: data.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + padded;
  }
  const parts: Uint8Array[] = [];
  let riffSize = 4;
  for (const chunk of chunks) {
    let body = chunk.body;
    if (chunk.id === "VP8X" && body.length >= 1) {
      // Clear the EXIF (bit 3) and XMP (bit 2) flags to match the chunks no longer present.
      body = body.slice();
      body[0] = body[0]! & ~0b0000_1100;
    }
    const header = new Uint8Array(8);
    header.set([...chunk.id].map((c) => c.charCodeAt(0)));
    writeU32le(header, 4, body.length);
    parts.push(header, body);
    riffSize += 8 + body.length + (body.length % 2);
    if (body.length % 2 === 1) parts.push(new Uint8Array([0]));
  }
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  writeU32le(head, 4, riffSize);
  head.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return { ok: true, data: concat([head, ...parts]), strippedBytes: stripped };
}

// ---------------------------------------------------------------------------
// MP4: drop `udta`, `meta` and `uuid` boxes, wherever they sit at the top level or inside
// `moov`/`trak`. Removing bytes that precede `mdat` shifts every chunk offset, so `stco` and
// `co64` tables are rewritten by exactly the bytes removed before the old `mdat` position —
// which handles both layouts: a trailing `moov` needs no correction and gets delta 0.
// ---------------------------------------------------------------------------

const MP4_STRIP = new Set(["udta", "meta", "uuid"]);

interface Mp4Box {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

function* mp4Boxes(data: Uint8Array, start: number, end: number): Generator<Mp4Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32(data, offset);
    const type = ascii(data, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit size. Files this large never reach here (takes are verified before), but parse honestly.
      if (offset + 16 > end) return;
      const hi = u32(data, offset + 8);
      const lo = u32(data, offset + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset; // to end of enclosing box
    }
    if (size < headerSize || offset + size > end) return;
    yield { type, start: offset, size, headerSize };
    offset += size;
  }
}

/** Containers whose children are themselves boxes, walked when rebuilding. */
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function rebuildMp4Box(data: Uint8Array, box: Mp4Box, removed: { bytes: number }): Uint8Array | null {
  if (MP4_STRIP.has(box.type)) {
    removed.bytes += box.size;
    return null;
  }
  if (!MP4_CONTAINERS.has(box.type)) {
    return data.subarray(box.start, box.start + box.size);
  }
  const children: Uint8Array[] = [];
  for (const child of mp4Boxes(data, box.start + box.headerSize, box.start + box.size)) {
    const rebuilt = rebuildMp4Box(data, child, removed);
    if (rebuilt !== null) children.push(rebuilt);
  }
  const bodySize = children.reduce((sum, c) => sum + c.length, 0);
  const header = data.slice(box.start, box.start + box.headerSize);
  if (box.headerSize === 8) writeU32(header, 0, 8 + bodySize);
  else {
    // 64-bit header: keep the marker, rewrite the extended size.
    writeU32(header, 0, 1);
    const total = 16 + bodySize;
    writeU32(header, 8, Math.floor(total / 2 ** 32));
    writeU32(header, 12, total >>> 0);
  }
  return concat([header, ...children]);
}

function adjustChunkOffsets(box: Uint8Array, delta: number): void {
  // Walk the rebuilt moov for stco/co64 and subtract the bytes removed before mdat.
  const walk = (start: number, end: number): void => {
    for (const child of mp4Boxes(box, start, end)) {
      if (child.type === "stco" && child.size >= 16) {
        const count = u32(box, child.start + 12);
        for (let i = 0; i < count; i++) {
          const at = child.start + 16 + i * 4;
          if (at + 4 > child.start + child.size) break;
          writeU32(box, at, Math.max(0, u32(box, at) - delta));
        }
      } else if (child.type === "co64" && child.size >= 16) {
        const count = u32(box, child.start + 12);
        for (let i = 0; i < count; i++) {
          const at = child.start + 16 + i * 8;
          if (at + 8 > child.start + child.size) break;
          const value = u32(box, at) * 2 ** 32 + u32(box, at + 4) - delta;
          writeU32(box, at, Math.floor(value / 2 ** 32));
          writeU32(box, at + 4, value >>> 0);
        }
      } else if (MP4_CONTAINERS.has(child.type)) {
        walk(child.start + child.headerSize, child.start + child.size);
      }
    }
  };
  walk(0, box.length);
}

function sanitizeMp4(data: Uint8Array): SanitizeResult {
  const top = [...mp4Boxes(data, 0, data.length)];
  if (top.length === 0 || top[0]!.type !== "ftyp") return { ok: false, reason: "mp4: no ftyp box" };
  const mdatStart = top.find((b) => b.type === "mdat")?.start ?? Number.POSITIVE_INFINITY;
  const rebuilt: Array<{ box: Uint8Array; wasMoov: boolean; originalStart: number }> = [];
  let strippedTotal = 0;
  let removedBeforeMdat = 0;
  for (const box of top) {
    const removed = { bytes: 0 };
    const result = rebuildMp4Box(data, box, removed);
    strippedTotal += removed.bytes;
    if (box.start < mdatStart) removedBeforeMdat += removed.bytes;
    if (result !== null) rebuilt.push({ box: result.slice(), wasMoov: box.type === "moov", originalStart: box.start });
  }
  if (removedBeforeMdat > 0) {
    for (const entry of rebuilt) {
      if (entry.wasMoov) adjustChunkOffsets(entry.box, removedBeforeMdat);
    }
  }
  return { ok: true, data: concat(rebuilt.map((e) => e.box)), strippedBytes: strippedTotal };
}

// ---------------------------------------------------------------------------
// FLAC: preserve STREAMINFO and audio frames, remove every metadata block that can carry text or
// pictures. ComfyUI stores prompt/workflow JSON in Vorbis comments; rebuilding the metadata chain
// also makes the final-block bit truthful after those blocks are removed.
// ---------------------------------------------------------------------------

function sanitizeFlac(data: Uint8Array): SanitizeResult {
  if (data.length < 8 || ascii(data, 0, 4) !== "fLaC") {
    return { ok: false, reason: "flac: bad signature" };
  }
  const kept: Array<{ type: number; body: Uint8Array }> = [];
  let offset = 4;
  let last = false;
  let stripped = 0;
  while (!last) {
    if (offset + 4 > data.length) return { ok: false, reason: "flac: incomplete metadata header" };
    const type = data[offset]! & 0x7f;
    last = (data[offset]! & 0x80) !== 0;
    const size = data[offset + 1]! << 16 | data[offset + 2]! << 8 | data[offset + 3]!;
    const end = offset + 4 + size;
    if (end > data.length) return { ok: false, reason: "flac: a metadata block overruns the file" };
    if (type === 0) {
      if (kept.length > 0 || size !== 34) return { ok: false, reason: "flac: invalid STREAMINFO block" };
      kept.push({ type, body: data.subarray(offset + 4, end) });
    } else {
      stripped += 4 + size;
    }
    offset = end;
  }
  if (kept.length !== 1 || offset + 2 > data.length) return { ok: false, reason: "flac: no audio frame" };
  const metadata = new Uint8Array(4 + kept[0]!.body.length);
  metadata[0] = 0x80; // STREAMINFO is now the sole and therefore final metadata block.
  metadata[1] = 0;
  metadata[2] = 0;
  metadata[3] = 34;
  metadata.set(kept[0]!.body, 4);
  return {
    ok: true,
    data: concat([new TextEncoder().encode("fLaC"), metadata, data.subarray(offset)]),
    strippedBytes: stripped,
  };
}

// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function writeU32le(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Sanitise one landed ComfyUI artifact by its bytes, never its extension — the magic decides.
 * Unknown containers refuse with the container named (§2.10).
 */
export function sanitizeComfyUiMedia(name: string, data: Uint8Array): SanitizeResult {
  if (data.length >= 4 && ascii(data, 0, 4) === "fLaC") return sanitizeFlac(data);
  if (startsWith(data, PNG_SIGNATURE)) return sanitizePng(data);
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    return sanitizeWebp(data);
  }
  if (data.length >= 12 && ascii(data, 4, 4) === "ftyp") return sanitizeMp4(data);
  const jpeg = data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
  const container = jpeg
    ? "jpeg"
    : data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3
      ? "webm/matroska"
      : "unknown";
  return {
    ok: false,
    reason: `"${name}" is a ${container} container the sanitiser does not handle — it was refused rather than landed with possible embedded workflow metadata`,
  };
}
