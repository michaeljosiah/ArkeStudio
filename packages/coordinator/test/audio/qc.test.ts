import assert from "node:assert/strict";
import { it } from "node:test";
import { analyzePcmWav, audioQcCacheKey, audioHash, canonicalWav } from "../../src/audio/qc.js";
import { wav } from "./helpers.js";

it("measures PCM RMS peak clipping and DC offset without perceptual claims", () => {
  const bytes = wav([-32768, 32767, 0, 0]);
  const report = analyzePcmWav(bytes);
  assert.equal(report.sourceHash, audioHash(bytes));
  assert.equal(report.measurements.fullScaleSampleCount, 2);
  assert.equal(report.measurements.samplePeakDbfs, 0);
  assert.equal(report.measurements.dcOffset, -1 / 32768 / 4);
  assert.ok(Math.abs(report.measurements.rmsDbfs! + 3.0104) < 0.001);
  assert.equal(report.checks.clipping.outcome, "warning");
  for (const key of ["truePeak", "lufs", "noiseFloor", "snr", "speechPresence", "musicLikelihood", "multipleSpeakers"] as const) {
    assert.equal(report.checks[key].outcome, "unavailable");
  }
  assert.equal(report.checks.transcriptMatch.outcome, "not-applicable");
});
it("distinguishes the quantized samples around minus sixty dBFS and handles digital silence", () => {
  assert.equal(analyzePcmWav(wav([32, -32])).checks.silence.outcome, "warning");
  assert.equal(analyzePcmWav(wav([33, -33])).checks.silence.outcome, "pass");
  const silent = analyzePcmWav(wav(Array(48000).fill(0)));
  assert.equal(silent.measurements.rmsDbfs, null);
  assert.equal(silent.measurements.leadingSilenceSec, 1);
  assert.equal(silent.measurements.trailingSilenceSec, 1);
  assert.equal(silent.measurements.longestInternalSilenceSec, 0);
});
it("reports boundary and internal silence independently without trimming", () => {
  const report = analyzePcmWav(wav([...Array(48000).fill(0), 1000, ...Array(100).fill(0), 1000, ...Array(48000).fill(0)]));
  assert.equal(report.measurements.leadingSilenceSec, 1);
  assert.equal(report.measurements.trailingSilenceSec, 1);
  assert.equal(report.measurements.longestInternalSilenceSec, 100 / 48000);
});
it("refuses wrong PCM and truncated RIFF rather than analyzing arbitrary bytes", () => {
  const bytes = Buffer.from(wav([1, 2]));
  bytes.writeUInt16LE(2, 22);
  assert.throws(() => canonicalWav(bytes), /unsupported/);
  assert.throws(() => canonicalWav(wav([])));
  assert.throws(() => canonicalWav(wav([1, 2]).slice(0, 45)));
  assert.match(audioQcCacheKey(audioHash(wav([1]))), /[a-f0-9]{64}\/arke-pcm-qc-v1-p1.json/);
  assert.throws(() => audioQcCacheKey("sha256:12345678"));
});
