import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMediaObservationSchema, AnalyzeAudioArgsSchema, SampleVideoArgsSchema, measureAudioSignal } from "../src/agent-media.js";
import { WorldChatCheckReceiptSchema } from "../src/world-chat.js";
const hash = "sha256:" + "a".repeat(64);
function pcm(values: number[]) { const result = Buffer.alloc(values.length * 4); values.forEach((value, index) => result.writeFloatLE(value, index * 4)); return result; }
test("original-channel measurements distinguish silence, sample peaks, full-scale flags and RMS", () => {
  const value = measureAudioSignal(pcm([0, .5, 0, .5, 1, .5, 0, .5]), 4, 2, 3, hash);
  assert.equal(value.sampleFrames, 4); assert.equal(value.decodedDurationSec, 1);
  assert.equal(value.channels[0]!.samplePeakDbfs, 0); assert.equal(value.channels[0]!.samplesAtOrAboveFullScale, 1);
  assert.equal(value.channels[0]!.leadingSilenceSec, .5); assert.equal(value.channels[0]!.trailingSilenceSec, .25);
  assert.equal(value.channels[0]!.longestSilenceSec, .5);
  assert.ok(Math.abs(value.channels[1]!.samplePeakDbfs! + 6.0206) < .0001);
  assert.equal(value.channels[1]!.samplePeakDbfs, value.channels[1]!.rmsDbfs);
  assert.equal(value.truePeak, "not-measured"); assert.equal(value.integratedLufs, "not-measured");
});
test("digital silence is explicit without non-finite dB values, and malformed PCM is refused", () => {
  const silent = measureAudioSignal(pcm([0, 0]), 2, 1, 0, hash).channels[0]!;
  assert.equal(silent.samplePeakDbfs, null); assert.equal(silent.rmsDbfs, null); assert.equal(silent.longestSilenceSec, 1);
  for (const bytes of [new Uint8Array(), new Uint8Array(3), pcm([NaN]), pcm([Infinity])]) assert.throws(() => measureAudioSignal(bytes, 2, 1, 0, hash));
  assert.throws(() => measureAudioSignal(pcm([0]), 192001, 1, 0, hash));
});
test("media inputs refuse paths, arbitrary extras, excessive sampling and invalid intervals", () => {
  const source = { kind: "artifact", id: "ar-one" };
  assert.ok(SampleVideoArgsSchema.safeParse({ source, range: { startSec: 0, endSec: 60 }, count: 8 }).success);
  for (const args of [{ source: { path: "/private" } }, { source, path: "/private" }, { source, range: { startSec: 1, endSec: 1 } },
    { source, range: { startSec: 0, endSec: 61 } }, { source, range: { startSec: 0, endSec: 1 }, count: 9 }]) assert.equal(SampleVideoArgsSchema.safeParse(args).success, false);
  assert.equal(AnalyzeAudioArgsSchema.safeParse({ source, range: { startSec: -1, endSec: 1 } }).success, false);
});
test("typed receipts cannot confuse metadata, frame inspection and audio measurements", () => {
  const media = { profile: "arke-media-evidence-v1", decoderVersion: "ffmpeg version fixture", probeVersion: "ffprobe version fixture", source: { kind: "artifact", id: "ar-one" },
    sourceHash: hash, byteLength: 3, sourceStartSec: 0, sourceEndSec: 1, inventory: { durationSec: 1, streams: [] }, coverage: "metadata-only", limitations: ["Metadata only"] };
  assert.ok(AgentMediaObservationSchema.safeParse(media).success);
  assert.equal(AgentMediaObservationSchema.safeParse({ ...media, coverage: "sampled-frames-only" }).success, false);
  const receipt = { id: "check_01J8F0000000000000000000C1", runId: "run_01J8F0000000000000000000C1", tool: "inspect-media", status: "complete", consulted: [], media, at: "2026-10-13T00:00:00Z" };
  assert.ok(WorldChatCheckReceiptSchema.safeParse(receipt).success);
  for (const value of [{ ...receipt, tool: "sample-video" }, { ...receipt, tool: "search-canon" }, { ...receipt, media: undefined }, { ...receipt, status: "failed" }]) assert.equal(WorldChatCheckReceiptSchema.safeParse(value).success, false);
});
