import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flacProblem, mp4Problem, verifyArtifact } from "../../src/queue/verify.js";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function flacCrc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function flacCrc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function flacFrame(frameNumber: number, blockSize: number): Uint8Array {
  // Fixed-block stream, 8 kHz mono, 8-bit samples, uncommon block size, constant-zero subframe.
  const headerWithoutCrc = Uint8Array.from([0xff, 0xf8, 0x64, 0x02, frameNumber, blockSize - 1]);
  const header = concat(headerWithoutCrc, Uint8Array.of(flacCrc8(headerWithoutCrc)));
  const frameWithoutCrc = concat(header, Uint8Array.of(0x00, 0x00));
  const crc = flacCrc16(frameWithoutCrc);
  return concat(frameWithoutCrc, Uint8Array.of(crc >>> 8, crc & 0xff));
}

function flacFile(totalSamples: bigint, frames: Uint8Array[]): Uint8Array {
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 16, false);
  view.setUint16(2, 16, false);
  const packed = (8_000n << 44n) | (7n << 36n) | totalSamples;
  view.setUint32(10, Number(packed >> 32n), false);
  view.setUint32(14, Number(packed & 0xffffffffn), false);
  return concat(
    new TextEncoder().encode("fLaC"),
    Uint8Array.of(0x80, 0, 0, streamInfo.length),
    streamInfo,
    ...frames,
  );
}

const MP3_FRAME_LENGTH = 417;

function mp3Frame(): Uint8Array {
  const frame = new Uint8Array(MP3_FRAME_LENGTH);
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono. Zero side information/main data is silence.
  frame.set([0xff, 0xfb, 0x90, 0xc0]);
  return frame;
}

function writeAscii(data: Uint8Array, offset: number, value: string): void {
  data.set(new TextEncoder().encode(value), offset);
}

function writeUint32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value, false);
}

function xingMp3(
  kind: "Xing" | "Info",
  declaredFrameCount: number,
  flags = 3,
  physicalAudioFrameCount = declaredFrameCount,
): Uint8Array {
  const declaration = mp3Frame();
  const tagAt = 21; // MPEG-1 mono side information ends here.
  writeAscii(declaration, tagAt, kind);
  writeUint32(declaration, tagAt + 4, flags);
  let cursor = tagAt + 8;
  if ((flags & 1) !== 0) {
    writeUint32(declaration, cursor, declaredFrameCount);
    cursor += 4;
  }
  if ((flags & 2) !== 0) {
    writeUint32(declaration, cursor, (physicalAudioFrameCount + 1) * MP3_FRAME_LENGTH);
  }
  return concat(declaration, ...Array.from({ length: physicalAudioFrameCount }, () => mp3Frame()));
}

function vbriMp3(audioFrameCount: number): Uint8Array {
  const declaration = mp3Frame();
  const tagAt = 36;
  writeAscii(declaration, tagAt, "VBRI");
  new DataView(declaration.buffer).setUint16(tagAt + 4, 1, false);
  writeUint32(declaration, tagAt + 10, (audioFrameCount + 1) * MP3_FRAME_LENGTH);
  writeUint32(declaration, tagAt + 14, audioFrameCount + 1); // VBRI includes its info frame.
  const view = new DataView(declaration.buffer);
  view.setUint16(tagAt + 18, 1, false); // one TOC entry
  view.setUint16(tagAt + 20, 1, false); // byte scale
  view.setUint16(tagAt + 22, 2, false); // bytes per entry
  view.setUint16(tagAt + 24, audioFrameCount, false);
  view.setUint16(tagAt + 26, (audioFrameCount + 1) * MP3_FRAME_LENGTH, false);
  return concat(declaration, ...Array.from({ length: audioFrameCount }, () => mp3Frame()));
}

function mp3Problem(data: Uint8Array): string | null {
  return verifyArtifact({ name: "speech.mp3", contentType: "audio/mpeg", data });
}

describe("audio structural verification", () => {
  it("rejects a FLAC cut exactly between complete frames when STREAMINFO declares more samples", () => {
    const frames = [flacFrame(0, 16), flacFrame(1, 16)];
    const complete = flacFile(32n, frames);
    const cutAtFrameBoundary = complete.subarray(0, complete.length - frames[1]!.length);

    assert.equal(flacProblem(complete), null);
    assert.match(flacProblem(cutAtFrameBoundary) ?? "", /truncated.*sample count.*STREAMINFO/i);
  });

  it("does not invent a FLAC sample total when STREAMINFO marks it unknown", () => {
    assert.equal(flacProblem(flacFile(0n, [flacFrame(0, 16)])), null);
  });

  for (const kind of ["Xing", "Info"] as const) {
    it(`rejects an MP3 cut at a complete-frame boundary using its ${kind} totals`, () => {
      const complete = xingMp3(kind, 3);
      const cutAtFrameBoundary = complete.subarray(0, complete.length - MP3_FRAME_LENGTH);

      assert.equal(mp3Problem(complete), null);
      assert.match(mp3Problem(cutAtFrameBoundary) ?? "", /truncated.*audio byte length/i);
    });
  }

  it("accepts Xing/Info encoder priming frames beyond the declared duration", () => {
    for (const kind of ["Xing", "Info"] as const) {
      // Mirrors a short real-world response: 37 duration frames but 40 complete physical
      // frames after the metadata frame because encoder delay/end padding remains in-stream.
      assert.equal(mp3Problem(xingMp3(kind, 37, 1, 40)), null, `${kind}, frame declaration only`);
      assert.equal(mp3Problem(xingMp3(kind, 37, 3, 40)), null, `${kind}, authoritative byte total`);
    }
  });

  it("bounds Xing header-count ambiguity and still rejects a definite frame-boundary cut", () => {
    // This writer includes the metadata frame: four declared means it plus three audio frames.
    const complete = xingMp3("Xing", 4, 1, 3);
    const definiteCut = complete.subarray(0, complete.length - MP3_FRAME_LENGTH);

    assert.equal(mp3Problem(complete), null);
    assert.match(mp3Problem(definiteCut) ?? "", /truncated.*frame count/i);
  });

  it("checks a Xing byte-length declaration even when no frame count is present", () => {
    const complete = xingMp3("Xing", 3, 2);
    const cutAtFrameBoundary = complete.subarray(0, complete.length - MP3_FRAME_LENGTH);

    assert.equal(mp3Problem(complete), null);
    assert.match(mp3Problem(cutAtFrameBoundary) ?? "", /truncated.*audio byte length/i);
  });

  it("rejects an MP3 cut at a complete-frame boundary using its VBRI totals", () => {
    const complete = vbriMp3(3);
    const cutAtFrameBoundary = complete.subarray(0, complete.length - MP3_FRAME_LENGTH);

    assert.equal(mp3Problem(complete), null);
    assert.match(mp3Problem(cutAtFrameBoundary) ?? "", /truncated.*(?:frame count|audio byte length)/i);
  });

  it("does not pretend to detect a boundary cut when an MP3 declares no expected length", () => {
    const complete = concat(mp3Frame(), mp3Frame(), mp3Frame());
    const indistinguishableBoundaryCut = complete.subarray(0, complete.length - MP3_FRAME_LENGTH);

    assert.equal(mp3Problem(complete), null);
    assert.equal(mp3Problem(indistinguishableBoundaryCut), null);
  });
});

describe("MP4 structural verification", () => {
  const box = (tag: string, payload = new Uint8Array()) => {
    const bytes = new Uint8Array(8 + payload.length);
    new DataView(bytes.buffer).setUint32(0, bytes.length, false);
    writeAscii(bytes, 4, tag);
    bytes.set(payload, 8);
    return bytes;
  };

  it("requires complete top-level file, movie, and media boxes", () => {
    const complete = concat(box("ftyp", new TextEncoder().encode("isom")), box("moov"), box("mdat", Uint8Array.of(1)));
    assert.equal(mp4Problem(complete), null);
    assert.match(mp4Problem(complete.subarray(0, complete.length - 1)) ?? "", /truncated.*mdat/i);
    assert.match(mp4Problem(concat(box("ftyp"), box("mdat"))) ?? "", /no moov/i);
  });
});
