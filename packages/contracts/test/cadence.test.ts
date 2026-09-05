import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { mapCadence, normalizeSpeechText, type CadencePlan, type ManifestModel } from "../src/index.js";
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const model: Pick<ManifestModel, "id" | "provider" | "cadence"> = { id: "test-v3", provider: "elevenlabs", cadence: {
  deliveries: ["measured"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization",
  breath: "best-effort-audio-tag", outputTimestamps: "none", deliveryMappings: { measured: { settings: { stability: 0.5 } } } } };
const plan = (text: string, cues: CadencePlan["cues"] = []): CadencePlan => ({ schemaVersion: 1, sourceTextHash: hash(text), delivery: "measured", speed: 1, cues });
it("maps exact spans and tags at UTF-16 positions without modifying authored wording", () => {
  const text = "Straße waits.";
  const input = plan(text, [{ kind: "emphasis", span: { from: 0, to: 6, text: "Straße" }, level: "strong" },
    { kind: "pause", at: 6, length: "long" }, { kind: "breath", at: text.length, action: "exhale" }]);
  const output = mapCadence(text, hash(text), input, model);
  assert.equal(output.providerText, "STRASSE [long pause]  waits. [exhales] ");
  assert.equal(output.controls.length, 5); assert.equal(output.voiceSettings.speed, 1);
  assert.equal(normalizeSpeechText(" a\n b! "), "a b!");
});
it("refuses moved wording, surrogate splits, mismatched spans, overlap, duplicate and unordered cues", () => {
  const text = "Hi 😀 there";
  const bad: CadencePlan[] = [ { ...plan(text), sourceTextHash: hash("old") }, plan(text, [{ kind: "pause", at: 4, length: "short" }]),
    plan(text, [{ kind: "emphasis", span: { from: 0, to: 2, text: "No" }, level: "moderate" }]),
    plan(text, [{ kind: "pause", at: 2, length: "short" }, { kind: "pause", at: 2, length: "long" }]),
    plan(text, [{ kind: "pause", at: 5, length: "short" }, { kind: "pause", at: 0, length: "long" }]),
    plan(text, [{ kind: "emphasis", span: { from: 0, to: 2, text: "Hi" }, level: "strong" }, { kind: "emphasis", span: { from: 1, to: 2, text: "i" }, level: "strong" }]) ];
  for (const input of bad) assert.throws(() => mapCadence(text, hash(text), input, model));
});
it("names every unsupported control instead of silently claiming local cadence", () => {
  const text = "Hello";
  const output = mapCadence(text, hash(text), { ...plan(text, [{ kind: "breath", at: 0, action: "inhale" }]), speed: 1.1 },
    { id: "unknown", provider: "kokoro" });
  assert.deepEqual(output.controls.map(c => c.status), ["unsupported", "unsupported", "unsupported"]);
  assert.equal(output.providerText, text);
});
