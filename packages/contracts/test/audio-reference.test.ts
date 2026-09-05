import assert from "node:assert/strict";
import { it } from "node:test";
import { AudioUseRequestSchema, characterAudioRoute } from "../src/audio-reference.js";

it("voice guidance and performance sync enforce distinct source authorities", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const sample = { kind: "character-sample", sheetId: "maren-kest", hash };
  const slice = { kind: "master-slice", sliceId: "slice-1", hash };
  assert.ok(AudioUseRequestSchema.safeParse({ intent: "voice-reference", source: sample }).success);
  assert.equal(AudioUseRequestSchema.safeParse({ intent: "performance-sync", source: sample }).success, false);
  assert.ok(AudioUseRequestSchema.safeParse({ intent: "performance-sync", source: slice }).success);
  assert.equal(AudioUseRequestSchema.safeParse({ intent: "voice-reference", source: slice }).success, false);
  assert.equal(AudioUseRequestSchema.safeParse({ intent: "exact-dialogue", source: sample }).success, false);
});
it("verified voice guidance routes retain truthful limits and effects", () => {
  for (const id of ["seedance-2.0", "seedance-2.0-fast"]) {
    const route = characterAudioRoute({ provider: "fal", id })!;
    assert.equal(route.endpoint, `bytedance/${id}/reference-to-video`);
    assert.equal(route.maxFiles, 3); assert.equal(route.maxTotalDurationSec, 15);
    assert.equal(route.maxCombinedReferences, 12);
    assert.equal(route.effects.suppliedAudioPreserved, false);
    assert.equal(route.effects.generatedAudio, true);
    assert.equal(characterAudioRoute({ provider: "fal", id }, "first-frame"), null);
    assert.equal(characterAudioRoute({ provider: "fal", id }, "continue"), null);
  }
  assert.equal(characterAudioRoute({ provider: "fal", id: "seedance-2.5" }), null);
});
