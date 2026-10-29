import { open } from "node:fs/promises";
import { toExtendedLength } from "../world/paths.js";

/**
 * What an MP4 holds, read from its own boxes (ISO/IEC 14496-12): the brand, the length, and each
 * track's codec and the picture's size. Export → Arke Player ships a story's clip as made when it
 * is already H.264 with AAC in MP4, at most 1080 on its short side, and re-encodes it only when it
 * is not (SPEC-058 R-79). The measurement is here rather than in the host's ffprobe because the
 * answer decides what bytes ship: an export cannot be one thing with ffprobe installed and another
 * without, and a story's clip is always an MP4 the Studio made or was given.
 *
 * Null for a file that is not an MP4 at all, which is then re-encoded like any clip that does not fit.
 */

export interface Mp4Info {
  /** `ftyp`'s major brand: `isom`, `mp42`, and `qt  ` for a QuickTime movie. */
  brand: string;
  /** The movie's length, from `mvhd`; null when it does not say. */
  durationMs: number | null;
  /** The first picture track: its sample entry (`avc1`, `hvc1`, …) and its size. */
  video: { codec: string; width: number; height: number } | null;
  /** Every sound track: its sample entry, and whether that is AAC. */
  audio: Array<{ codec: string; aac: boolean }>;
}

/** A movie box larger than this is not one a clip has; it is not read whole. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

interface Box {
  type: string;
  /** Where the box's content starts and ends in its buffer. */
  start: number;
  end: number;
}

/** The boxes inside [buffer] from [from] to [to]; a box that runs past its parent stops the walk. */
function boxes(buffer: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buffer: Buffer, parent: Box, type: string) => boxes(buffer, parent.start, parent.end).find((box) => box.type === type);

/** An `esds` descriptor's length: up to four bytes, seven bits each. */
function descriptorLength(buffer: Buffer, at: number, end: number): { length: number; next: number } | null {
  let length = 0;
  for (let i = 0; i < 4; i++) {
    if (at >= end) return null;
    const byte = buffer[at++]!;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { length, next: at };
  }
  return { length, next: at };
}

/**
 * Whether an `mp4a` entry's `esds` names AAC: its DecoderConfigDescriptor's object type is MPEG-4
 * audio (0x40) or MPEG-2 AAC (0x66 – 0x68), and not MP3 (0x6B), which also rides as `mp4a`.
 */
function esdsIsAac(buffer: Buffer, esds: Box): boolean {
  let at = esds.start + 4;
  if (buffer[at] !== 0x03) return false;
  const es = descriptorLength(buffer, at + 1, esds.end);
  if (es === null) return false;
  at = es.next + 2;
  const flags = buffer[at++] ?? 0;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + (buffer[at] ?? 0);
  if (flags & 0x20) at += 2;
  if (buffer[at] !== 0x04) return false;
  const config = descriptorLength(buffer, at + 1, esds.end);
  if (config === null) return false;
  const objectType = buffer[config.next];
  return objectType === 0x40 || objectType === 0x66 || objectType === 0x67 || objectType === 0x68;
}

/** Reads the boxes of an MP4's `moov`, which are all the export needs. */
export function readMp4Moov(brand: string, moov: Buffer): Mp4Info {
  const root: Box = { type: "moov", start: 0, end: moov.length };
  let durationMs: number | null = null;
  const mvhd = child(moov, root, "mvhd");
  if (mvhd !== undefined && mvhd.end - mvhd.start >= 20) {
    const version = moov[mvhd.start]!;
    const timescale = version === 1 ? moov.readUInt32BE(mvhd.start + 20) : moov.readUInt32BE(mvhd.start + 12);
    const duration = version === 1 ? Number(moov.readBigUInt64BE(mvhd.start + 24)) : moov.readUInt32BE(mvhd.start + 16);
    if (timescale > 0 && duration > 0 && duration !== 0xffffffff) durationMs = Math.round((duration / timescale) * 1000);
  }
  let video: Mp4Info["video"] = null;
  const audio: Mp4Info["audio"] = [];
  for (const trak of boxes(moov, root.start, root.end).filter((box) => box.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    const hdlr = mdia === undefined ? undefined : child(moov, mdia, "hdlr");
    const handler = hdlr === undefined || hdlr.end - hdlr.start < 12 ? "" : moov.toString("latin1", hdlr.start + 8, hdlr.start + 12);
    const minf = mdia === undefined ? undefined : child(moov, mdia, "minf");
    const stbl = minf === undefined ? undefined : child(moov, minf, "stbl");
    const stsd = stbl === undefined ? undefined : child(moov, stbl, "stsd");
    if (stsd === undefined) continue;
    const entry = boxes(moov, stsd.start + 8, stsd.end)[0];
    if (entry === undefined) continue;
    if (handler === "vide" && video === null && entry.end - entry.start >= 28) {
      video = { codec: entry.type, width: moov.readUInt16BE(entry.start + 24), height: moov.readUInt16BE(entry.start + 26) };
    } else if (handler === "soun") {
      let aac = false;
      if (entry.type === "mp4a" && entry.end - entry.start >= 28) {
        // A QuickTime sound entry of version 1 or 2 is longer before its own boxes begin.
        const version = moov.readUInt16BE(entry.start + 8);
        const children = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
        const esds = boxes(moov, children, entry.end).find((box) => box.type === "esds");
        aac = esds !== undefined && esdsIsAac(moov, esds);
      }
      audio.push({ codec: entry.type, aac });
    }
  }
  return { brand, durationMs, video, audio };
}

/** Reads [file]'s `ftyp` and `moov`; null when it is no MP4, or its movie box cannot be read. */
export async function readMp4Info(file: string): Promise<Mp4Info | null> {
  const handle = await open(toExtendedLength(file), "r").catch(() => null);
  if (handle === null) return null;
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let brand: string | null = null;
    let at = 0;
    for (let count = 0; at + 8 <= size && count < 64; count++) {
      const { bytesRead } = await handle.read(header, 0, 16, at);
      if (bytesRead < 8) return null;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - at;
      }
      if (boxSize < headerSize || at + boxSize > size) return null;
      // An MP4 opens with its brand; anything else is not one.
      if (count === 0 && type !== "ftyp") return null;
      if (type === "ftyp") {
        const brandBytes = Buffer.alloc(4);
        await handle.read(brandBytes, 0, 4, at + headerSize);
        brand = brandBytes.toString("latin1");
      }
      if (type === "moov") {
        const length = boxSize - headerSize;
        if (brand === null || length > MAX_MOOV_BYTES) return null;
        const moov = Buffer.alloc(length);
        const read = await handle.read(moov, 0, length, at + headerSize);
        if (read.bytesRead !== length) return null;
        return readMp4Moov(brand, moov);
      }
      at += boxSize;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** The short side a story's clip may have on a phone (SPEC-058 R-79). */
export const STORY_CLIP_SHORT_SIDE = 1080;

/**
 * What a clip needs to be a story's (R-79): shipped as made; its streams copied into an MP4, with
 * sound that is not AAC made AAC; or its picture re-encoded as H.264 at most 1080 on its short side.
 */
export function clipFit(info: Mp4Info | null): "as-made" | "remux" | "encode" {
  if (info === null || info.video === null) return "encode";
  const { codec, width, height } = info.video;
  const picture = (codec === "avc1" || codec === "avc3") && width > 0 && height > 0 && Math.min(width, height) <= STORY_CLIP_SHORT_SIDE;
  if (!picture) return "encode";
  return info.brand !== "qt  " && info.audio.every((track) => track.aac) ? "as-made" : "remux";
}
