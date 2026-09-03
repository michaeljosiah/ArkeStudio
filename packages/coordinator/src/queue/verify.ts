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

export function mp4Problem(d: Uint8Array): string | null {
  let offset = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMdat = false;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  while (offset < d.length) {
    if (offset + 8 > d.length) return "MP4 is truncated (incomplete box header)";
    const declared = view.getUint32(offset, false);
    const tag = new TextDecoder("latin1").decode(d.slice(offset + 4, offset + 8));
    let header = 8;
    let size = declared;
    if (declared === 1) {
      if (offset + 16 > d.length) return "MP4 is truncated (incomplete extended box header)";
      const extended = view.getBigUint64(offset + 8, false);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return "MP4 box is too large to verify";
      size = Number(extended);
      header = 16;
    } else if (declared === 0) {
      size = d.length - offset;
    }
    if (size < header) return "MP4 has an invalid box size";
    if (offset + size > d.length) return `MP4 is truncated (${tag || "unknown"} box is incomplete)`;
    if (offset === 0 && tag !== "ftyp") return "not an MP4 (no ftyp box)";
    hasFtyp ||= tag === "ftyp";
    hasMoov ||= tag === "moov";
    hasMdat ||= tag === "mdat";
    offset += size;
  }
  if (!hasFtyp) return "not an MP4 (no ftyp box)";
  if (!hasMoov) return "MP4 is incomplete (no moov box)";
  if (!hasMdat) return "MP4 is incomplete (no mdat box)";
  return null;
}

export function wavProblem(d: Uint8Array): string | null {
  const riff = new TextDecoder("latin1").decode(d.slice(0, 4));
  const wave = new TextDecoder("latin1").decode(d.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") return "not a WAV (bad RIFF header)";
  if (d.length < 20) return "WAV is truncated (no complete chunks)";
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (view.getUint32(4, true) + 8 !== d.length) return "WAV is truncated (RIFF size does not match)";
  let offset = 12;
  let fmt = false;
  let audio = false;
  while (offset < d.length) {
    if (offset + 8 > d.length) return "WAV is truncated (incomplete chunk header)";
    const id = new TextDecoder("latin1").decode(d.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > d.length) return "WAV is truncated (chunk exceeds RIFF size)";
    if (id === "fmt ") {
      if (size < 16) return "WAV has an invalid fmt chunk";
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const byteRate = view.getUint32(offset + 16, true);
      const blockAlign = view.getUint16(offset + 20, true);
      if (channels === 0 || sampleRate === 0 || byteRate === 0 || blockAlign === 0) {
        return "WAV has invalid audio parameters";
      }
      fmt = true;
    }
    if (id === "data" && size > 0) audio = true;
    offset = end + (size % 2);
  }
  if (offset !== d.length) return "WAV is truncated (missing chunk padding)";
  if (!fmt) return "WAV has no fmt chunk";
  return audio ? null : "WAV has no audio data";
}

function mp3BitrateKbps(version: number, layer: number, index: number): number {
  if (index <= 0 || index >= 15) return 0;
  const mpeg1 = version === 3;
  const table = mpeg1
    ? layer === 3
      ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
      : layer === 2
        ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
        : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : layer === 3
      ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  return table[index] ?? 0;
}

function mp3FrameLength(d: Uint8Array, offset: number): number {
  if (offset + 4 > d.length || at(d, offset) !== 0xff || (at(d, offset + 1) & 0xe0) !== 0xe0) return 0;
  const version = (at(d, offset + 1) >> 3) & 0x03;
  const layer = (at(d, offset + 1) >> 1) & 0x03;
  const bitrateIndex = at(d, offset + 2) >> 4;
  const sampleRateIndex = (at(d, offset + 2) >> 2) & 0x03;
  const padding = (at(d, offset + 2) >> 1) & 1;
  if (version === 1 || layer === 0 || sampleRateIndex === 3) return 0;
  const bitrate = mp3BitrateKbps(version, layer, bitrateIndex) * 1000;
  const baseRates = [44100, 48000, 32000];
  const divisor = version === 3 ? 1 : version === 2 ? 2 : 4;
  const sampleRate = Math.floor(baseRates[sampleRateIndex]! / divisor);
  if (bitrate === 0 || sampleRate === 0) return 0;
  if (layer === 3) return Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  const coefficient = layer === 1 && version !== 3 ? 72 : 144;
  return Math.floor((coefficient * bitrate) / sampleRate + padding);
}

export function flacProblem(d: Uint8Array): string | null {
  if (d.length < 8 || new TextDecoder("latin1").decode(d.slice(0, 4)) !== "fLaC") {
    return "not FLAC (bad signature)";
  }
  let offset = 4;
  let first = true;
  let last = false;
  let totalSamples = 0n;
  while (!last) {
    if (offset + 4 > d.length) return "FLAC is truncated (incomplete metadata header)";
    const type = at(d, offset) & 0x7f;
    last = (at(d, offset) & 0x80) !== 0;
    const size = (at(d, offset + 1) << 16) | (at(d, offset + 2) << 8) | at(d, offset + 3);
    if (first && (type !== 0 || size !== 34)) return "FLAC has no valid STREAMINFO block";
    if (type === 127) return "FLAC contains an invalid metadata block";
    offset += 4;
    if (offset + size > d.length) return "FLAC is truncated (metadata block exceeds file)";
    if (first) {
      const view = new DataView(d.buffer, d.byteOffset + offset, size);
      const minBlock = view.getUint16(0, false);
      const maxBlock = view.getUint16(2, false);
      const packedHigh = view.getUint32(10, false);
      const packedLow = view.getUint32(14, false);
      const sampleRate = packedHigh >>> 12;
      const channels = ((packedHigh >>> 9) & 0x07) + 1;
      const bitsPerSample = ((packedHigh >>> 4) & 0x1f) + 1;
      totalSamples = (BigInt(packedHigh & 0x0f) << 32n) | BigInt(packedLow);
      if (
        minBlock < 16 ||
        maxBlock < minBlock ||
        sampleRate === 0 ||
        sampleRate > 655350 ||
        channels > 8 ||
        bitsPerSample < 4 ||
        bitsPerSample > 32
      )
        return "FLAC has invalid STREAMINFO values";
    }
    offset += size;
    first = false;
  }
  if (offset + 2 > d.length) return "FLAC is truncated (no audio frame)";
  let frames = 0;
  let decodedSamples = 0n;
  while (offset < d.length) {
    const header = flacFrameHeader(d, offset);
    if (header === null)
      return frames === 0 ? "FLAC has no valid audio frame" : "FLAC has an invalid frame header";
    let next = -1;
    for (let candidate = header.end + 2; candidate + 6 <= d.length; candidate += 1) {
      if (flacFrameHeader(d, candidate) === null) continue;
      if (flacFrameCrcOk(d, offset, candidate)) {
        next = candidate;
        break;
      }
    }
    if (next === -1) {
      if (!flacFrameCrcOk(d, offset, d.length)) return "FLAC is truncated or has a corrupt audio frame";
      frames += 1;
      decodedSamples += BigInt(header.blockSize);
      offset = d.length;
    } else {
      frames += 1;
      decodedSamples += BigInt(header.blockSize);
      offset = next;
    }
  }
  if (frames === 0) return "FLAC has no audio frames";
  if (totalSamples !== 0n && decodedSamples !== totalSamples) {
    return "FLAC is truncated or inconsistent (decoded sample count does not match STREAMINFO)";
  }
  return null;
}

interface FlacFrameHeader {
  end: number;
  blockSize: number;
}

function flacFrameHeader(d: Uint8Array, start: number): FlacFrameHeader | null {
  if (start + 6 > d.length || at(d, start) !== 0xff || (at(d, start + 1) & 0xfe) !== 0xf8) return null;
  const blockCode = at(d, start + 2) >> 4;
  const sampleRateCode = at(d, start + 2) & 0x0f;
  const channelAssignment = at(d, start + 3) >> 4;
  const sampleSizeCode = (at(d, start + 3) >> 1) & 0x07;
  if (
    blockCode === 0 ||
    sampleRateCode === 15 ||
    channelAssignment > 10 ||
    sampleSizeCode === 3 ||
    sampleSizeCode === 7 ||
    (at(d, start + 3) & 1) !== 0
  )
    return null;
  let cursor = start + 4;
  const first = at(d, cursor);
  let numberBytes = 1;
  if ((first & 0x80) !== 0) {
    let mask = 0x80;
    numberBytes = 0;
    while ((first & mask) !== 0) {
      numberBytes += 1;
      mask >>= 1;
    }
    if (numberBytes < 2 || numberBytes > 7) return null;
    for (let index = 1; index < numberBytes; index += 1) {
      if ((at(d, cursor + index) & 0xc0) !== 0x80) return null;
    }
  }
  cursor += numberBytes;
  let blockSize: number;
  if (blockCode === 1) {
    blockSize = 192;
  } else if (blockCode >= 2 && blockCode <= 5) {
    blockSize = 576 << (blockCode - 2);
  } else if (blockCode === 6) {
    if (cursor >= d.length) return null;
    blockSize = at(d, cursor) + 1;
    cursor += 1;
  } else if (blockCode === 7) {
    if (cursor + 2 > d.length) return null;
    blockSize = ((at(d, cursor) << 8) | at(d, cursor + 1)) + 1;
    if (blockSize > 65535) return null;
    cursor += 2;
  } else {
    blockSize = 256 << (blockCode - 8);
  }
  cursor += sampleRateCode === 12 ? 1 : sampleRateCode === 13 || sampleRateCode === 14 ? 2 : 0;
  if (cursor >= d.length) return null;
  return flacCrc8(d, start, cursor) === at(d, cursor) ? { end: cursor + 1, blockSize } : null;
}

function flacCrc8(d: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let index = start; index < end; index += 1) {
    crc ^= d[index]!;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function flacFrameCrcOk(d: Uint8Array, start: number, end: number): boolean {
  if (end - start < 8) return false;
  let crc = 0;
  for (let index = start; index < end - 2; index += 1) {
    crc ^= d[index]! << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc === ((at(d, end - 2) << 8) | at(d, end - 1));
}

interface Mp3Declaration {
  kind: "Xing" | "Info" | "VBRI";
  frames: number | null;
  bytes: number | null;
}

function mp3Uint32(d: Uint8Array, offset: number): number {
  return (
    ((at(d, offset) << 24) | (at(d, offset + 1) << 16) | (at(d, offset + 2) << 8) | at(d, offset + 3)) >>> 0
  );
}

function mp3TagAt(d: Uint8Array, offset: number, tag: string): boolean {
  if (offset < 0 || offset + tag.length > d.length) return false;
  for (let index = 0; index < tag.length; index += 1) {
    if (at(d, offset + index) !== tag.charCodeAt(index)) return false;
  }
  return true;
}

function mp3Declaration(d: Uint8Array, frameStart: number, frameLength: number): Mp3Declaration | null {
  const frameEnd = frameStart + frameLength;
  const version = (at(d, frameStart + 1) >> 3) & 0x03;
  const layer = (at(d, frameStart + 1) >> 1) & 0x03;
  if (layer !== 1 || (version !== 0 && version !== 2 && version !== 3)) return null;

  const mono = at(d, frameStart + 3) >> 6 === 3;
  const xingOffset = version === 3 ? (mono ? 21 : 36) : mono ? 13 : 21;
  const xingAt = frameStart + xingOffset;
  const xingKind = mp3TagAt(d, xingAt, "Xing") ? "Xing" : mp3TagAt(d, xingAt, "Info") ? "Info" : null;
  if (xingKind !== null && xingAt + 8 <= frameEnd) {
    const flags = mp3Uint32(d, xingAt + 4);
    let cursor = xingAt + 8;
    let frames: number | null = null;
    let bytes: number | null = null;
    if ((flags & 1) !== 0 && cursor + 4 <= frameEnd) {
      frames = mp3Uint32(d, cursor);
      cursor += 4;
    }
    if ((flags & 2) !== 0 && cursor + 4 <= frameEnd) bytes = mp3Uint32(d, cursor);
    return { kind: xingKind, frames, bytes };
  }

  const vbriAt = frameStart + 36;
  if (!mp3TagAt(d, vbriAt, "VBRI") || vbriAt + 18 > frameEnd) return null;
  const versionHigh = at(d, vbriAt + 4);
  const versionLow = at(d, vbriAt + 5);
  if (versionHigh !== 0 || versionLow !== 1) return null;
  return {
    kind: "VBRI",
    bytes: mp3Uint32(d, vbriAt + 10),
    frames: mp3Uint32(d, vbriAt + 14),
  };
}

function mp3Ok(d: Uint8Array): string | null {
  let offset = 0;
  const id3 = new TextDecoder("latin1").decode(d.slice(0, 3));
  if (id3 === "ID3") {
    if (d.length < 10 || d.slice(6, 10).some((byte) => (byte & 0x80) !== 0))
      return "MP3 has an invalid ID3 header";
    const tagSize = (at(d, 6) << 21) | (at(d, 7) << 14) | (at(d, 8) << 7) | at(d, 9);
    offset = 10 + tagSize;
    if (offset > d.length) return "MP3 is truncated (ID3 tag exceeds file)";
  }
  const audioStart = offset;
  let frames = 0;
  let audioEnd = d.length;
  let declaration: Mp3Declaration | null = null;
  while (offset < d.length) {
    // ID3v1 is the only ordinary trailer: it is exactly 128 bytes and begins with TAG.
    if (
      d.length - offset === 128 &&
      at(d, offset) === 0x54 &&
      at(d, offset + 1) === 0x41 &&
      at(d, offset + 2) === 0x47
    ) {
      audioEnd = offset;
      break;
    }
    const frameLength = mp3FrameLength(d, offset);
    if (frameLength === 0) {
      return frames === 0
        ? "not an MP3 (no complete frame header)"
        : "MP3 has invalid data after an audio frame";
    }
    if (offset + frameLength > d.length) return "MP3 is truncated (frame exceeds file)";
    if (frames === 0) declaration = mp3Declaration(d, offset, frameLength);
    frames += 1;
    offset += frameLength;
  }
  if (frames === 0) return "not an MP3 (no audio frames)";
  if (declaration !== null) {
    if (declaration.bytes !== null) {
      // Xing/Info and VBRI byte totals cover the MPEG stream from the declaration frame.
      // Unlike their duration-oriented frame counts, this is an exact truncation witness.
      if (audioEnd - audioStart !== declaration.bytes) {
        return `MP3 is truncated or inconsistent (audio byte length does not match ${declaration.kind})`;
      }
    } else if (declaration.frames !== null) {
      // Xing was never formally standardised: common writers exclude this metadata frame,
      // while others include it, and some leave encoder-delay/end-padding frames outside the
      // duration count. Including the metadata frame in the walk tolerates only that one-frame
      // convention difference; beyond it the declaration is a lower bound, not an exact EOF.
      // Extra complete frames do not prove corruption, but fewer walked frames prove a cut.
      if (frames < declaration.frames) {
        return `MP3 is truncated (frame count is below ${declaration.kind} declaration)`;
      }
    }
  }
  // Without a declared count or byte length, a clean frame-boundary EOF carries no evidence
  // that another complete frame ever existed. Do not manufacture an expected duration.
  return null;
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
  if (type.includes("mp4") || type.includes("video")) return mp4Problem(artifact.data);
  if (type.includes("wav")) return wavProblem(artifact.data);
  if (type.includes("flac")) return flacProblem(artifact.data);
  if (type.includes("mpeg") || type.includes("mp3")) return mp3Ok(artifact.data);
  // Text and unknown types: a non-empty body is the best check available.
  return null;
}
