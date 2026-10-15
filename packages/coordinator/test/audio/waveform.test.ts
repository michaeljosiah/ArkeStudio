import assert from "node:assert/strict";
import { test } from "node:test";
import { audioWaveform } from "../../src/audio/waveform.js";

test("waveforms preserve channel peaks and retain short transients at bucket boundaries", () => {
  const left = new Float32Array(8192), right = new Float32Array(8192);
  left[3] = -.8; right[4] = .25; left[8191] = .5;
  const peaks = audioWaveform(`sha256:${"a".repeat(64)}`, { rate: 48000, channels: 2, left, right });
  assert.equal(peaks.samples, 8192); assert.equal(peaks.left.length, 2048);
  assert.equal(peaks.left[0], .8); assert.equal(peaks.right[0], 0); assert.equal(peaks.right[1], .25);
  assert.equal(peaks.left.at(-1), .5);
});
