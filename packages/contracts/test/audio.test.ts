import assert from "node:assert/strict";
import { it } from "node:test";
import { FullSha256Schema, AudioRangeSchema, AudioRightsEventSchema, AudioUseIntentSchema } from "../src/audio.js";
import { Sha256Schema } from "../src/ids.js";
import { ProvenanceSchema } from "../src/take.js";

it("full media hashes reject abbreviated values without tightening legacy schemas", () => {
  assert.equal(FullSha256Schema.safeParse("sha256:12345678").success, false);
  assert.equal(Sha256Schema.safeParse("sha256:12345678").success, true);
  assert.equal(FullSha256Schema.safeParse(`sha256:${"a".repeat(64)}`).success, true);
  assert.deepEqual(ProvenanceSchema.parse({ canonRevision: 1, sheets: {} }), { canonRevision: 1, sheets: {} });
});
it("audio ranges reject nonfinite reversed empty and negative values", () => {
  for (const range of [{ inSec: 1, outSec: 1 }, { inSec: -1, outSec: 1 }, { inSec: 1, outSec: 0 }, { inSec: 0, outSec: Infinity }, { inSec: NaN, outSec: 1 }]) {
    assert.equal(AudioRangeSchema.safeParse(range).success, false);
  }
});
it("rights and intent have one vocabulary independent of transport and effects", () => {
  assert.deepEqual(AudioUseIntentSchema.options, ["voice-reference", "performance-sync"]);
  assert.equal(AudioUseIntentSchema.safeParse("audio_urls").success, false);
  assert.equal(AudioRightsEventSchema.safeParse({ schemaVersion: 1, action: "withdraw", audioHash: `sha256:${"a".repeat(64)}`,
    acknowledgementId: "ack", at: "2026-09-05T12:00:00Z" }).success, true);
});
