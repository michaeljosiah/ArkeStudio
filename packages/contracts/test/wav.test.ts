import assert from "node:assert/strict";
import { test } from "node:test";
import { isRiffWave, pcm16WavHeader, wavChunks, wavFormat } from "../src/wav.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the PCM16 header is the one every writer produced, byte for byte", () => {
  // Gemini's and Eleven's 24 kHz mono, and the 48 kHz stereo a chapter render writes. Files on
  // disk were written with exactly these bytes, so a change here is a change to every take.
  assert.equal(hex(pcm16WavHeader(4, 24_000, 1)),
    ["52494646", "28000000", "57415645", "666d7420", "10000000", "0100", "0100", "c05d0000", "80bb0000", "0200", "1000", "64617461", "04000000"].join(""));
  assert.equal(hex(pcm16WavHeader(8, 48_000, 2)),
    ["52494646", "2c000000", "57415645", "666d7420", "10000000", "0100", "0200", "80bb0000", "00ee0200", "0400", "1000", "64617461", "08000000"].join(""));
});

test("a header the 32-bit size fields cannot hold is refused, not wrapped", () => {
  assert.throws(() => pcm16WavHeader(0xffffffff, 48_000, 2), RangeError);
  assert.throws(() => pcm16WavHeader(-2, 48_000, 2), RangeError);
  assert.throws(() => pcm16WavHeader(1.5, 48_000, 2), RangeError);
  assert.equal(pcm16WavHeader(0xffffffff - 36, 48_000, 2).length, 44);
});

/** RIFF/WAVE around these chunks, each padded as the container requires. */
function riff(...chunks: Array<[string, Uint8Array]>): Uint8Array {
  const parts = chunks.map(([id, body]) => {
    const out = new Uint8Array(8 + body.length + (body.length % 2));
    out.set(Buffer.from(id, "latin1"));
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  });
  const size = parts.reduce((sum, part) => sum + part.length, 4);
  const out = new Uint8Array(8 + size);
  out.set(Buffer.from("RIFF"));
  new DataView(out.buffer).setUint32(4, size, true);
  out.set(Buffer.from("WAVE"), 8);
  let at = 12;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function fmtBody(tag: number, size: number, subFormat?: number): Uint8Array {
  const body = new Uint8Array(Math.max(size, 26));
  const view = new DataView(body.buffer);
  view.setUint16(0, tag, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 48_000, true);
  view.setUint32(8, 384_000, true);
  view.setUint16(12, 8, true);
  view.setUint16(14, 32, true);
  if (subFormat !== undefined) view.setUint16(24, subFormat, true);
  return body.subarray(0, size);
}

test("the walk steps over an odd chunk's pad byte and resolves an extensible format", () => {
  const bytes = riff(["LIST", new Uint8Array(3)], ["fmt ", fmtBody(0xfffe, 40, 3)], ["data", new Uint8Array(8)]);
  assert.equal(isRiffWave(bytes), true);
  const chunks = [...wavChunks(bytes)];
  assert.deepEqual(chunks.map(({ id, at, size }) => [id, at, size]), [["LIST", 20, 3], ["fmt ", 32, 40], ["data", 80, 8]]);
  assert.deepEqual(wavFormat(bytes, 32, 40), { tag: 0xfffe, code: 3, channels: 2, rate: 48_000, byteRate: 384_000, blockAlign: 8, bits: 32 });
});

test("an extensible chunk too short for its GUID keeps 0xFFFE, and a short fmt is no format", () => {
  const bytes = riff(["fmt ", fmtBody(0xfffe, 18)]);
  assert.equal(wavFormat(bytes, 20, 18)?.code, 0xfffe);
  assert.equal(wavFormat(riff(["fmt ", fmtBody(1, 14)]), 20, 14), null);
});

test("a data chunk that runs past the end is reported as declared, for the caller to judge", () => {
  const whole = riff(["fmt ", fmtBody(1, 16)], ["data", new Uint8Array(100)]);
  const cut = whole.subarray(0, 60);
  assert.deepEqual([...wavChunks(cut)].map(({ id, size }) => [id, size]), [["fmt ", 16], ["data", 100]]);
});

test("only a RIFF/WAVE opening is a WAV", () => {
  assert.equal(isRiffWave(new Uint8Array(8)), false);
  assert.equal(isRiffWave(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), false);
});
