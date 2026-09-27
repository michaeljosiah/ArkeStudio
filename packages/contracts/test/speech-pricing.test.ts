import assert from "node:assert/strict";
import { it } from "node:test";
import { estimateMicroUsd, quoteSpeech, speechQuoteIsCurrent, speechUsageCost, SpeechTokenPricingSchema, type ManifestModel } from "../src/index.js";

const model: ManifestModel = {
  id: "test-speech", provider: "elevenlabs", capability: "voice-tts", displayName: "Test speech",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perToken", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000,
    speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25,
      rates: [
        { version: "intro", effectiveFrom: "2026-09-27T00:00:00.000Z", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000 },
        { version: "2027", effectiveFrom: "2027-01-01T00:00:00.000Z", microUsdPerMillionInput: 1_000_000, microUsdPerMillionOutput: 18_000_000 },
      ] } },
};
const at = "2026-12-31T23:59:59.000Z";

it("keeps expected duration separate from a service-bound authorisation and rounds money upwards", () => {
  const q = quoteSpeech(model, "Hello", { at, inputTextTokens: 1, expectedAudioSeconds: 0.01 });
  assert.equal(q.expectedMicroUsd, 10);
  assert.equal(q.authorisedMicroUsd, 151552);
  assert.equal(q.quantities.outputAudioTokens, 1);
  assert.equal(speechUsageCost(q, { inputTextTokens: 1, outputAudioTokens: 250 }), 2251);
  assert.equal(speechUsageCost(q, { outputAudioTokens: 250 }), null);
  assert.equal(speechUsageCost(q, {}), null);
  assert.equal(speechUsageCost(q, { inputTextTokens: 0, outputAudioTokens: 0 }), 0);
});

it("never interprets missing token counts as free speech", () => {
  const q = quoteSpeech(model, "Hello", { at });
  assert.equal(q.expectedMicroUsd, q.authorisedMicroUsd);
  assert.equal(q.assumptions.length, 2);
  assert.throws(() => estimateMicroUsd(model, { characters: 5 }), /quoteSpeech/);
  assert.throws(() => quoteSpeech({ ...model, pricing: { kind: "perToken", microUsdPerMillionInput: 1, microUsdPerMillionOutput: 1 } }, "Hello", { at }), /no qualified speech pricing/);
  assert.throws(() => quoteSpeech(model, "Hello", { at, inputTextTokens: 8193 }), /input exceeds/);
  assert.throws(() => quoteSpeech(model, "Hello", { at, expectedAudioSeconds: 700 }), /split/);
});

it("expires introductory quotes exactly at the new rate boundary without repricing landed usage", () => {
  const q = quoteSpeech(model, "Hello", { at });
  assert.equal(speechQuoteIsCurrent(q, at), true);
  const next = "2027-01-01T00:00:00.000Z";
  assert.equal(speechQuoteIsCurrent(q, next), false);
  assert.equal(quoteSpeech(model, "Hello", { at: next }).authorisedMicroUsd, 303104);
  assert.equal(speechUsageCost(q, { inputTextTokens: 10, outputAudioTokens: 250 }), 2255);
});

it("preserves byte/CJK/delivery billing and explicit unmetered speech", () => {
  const reader = (unit: "character" | "cjk-double" | "utf8-byte"): ManifestModel => ({ ...model,
    pricing: { kind: "perCharacter", microUsdPerCharacter: 100, unit } });
  assert.equal(quoteSpeech(reader("character"), "é漢", { at }).authorisedMicroUsd, 200);
  assert.equal(quoteSpeech(reader("cjk-double"), "é漢", { at }).authorisedMicroUsd, 300);
  assert.equal(quoteSpeech(reader("utf8-byte"), "é漢", { at }).authorisedMicroUsd, 500);
  const local = quoteSpeech({ ...model, provider: "kokoro", pricing: { kind: "unmetered" } }, "Hello", { at });
  assert.equal(local.authorisedMicroUsd, 0);
  assert.equal(local.unit, "unmetered");
  assert.throws(() => speechUsageCost(quoteSpeech(model, "Hello", { at }), { inputTextTokens: -1 }), /greater/);
});

it("rejects ambiguous rate schedules", () => {
  if (model.pricing.kind !== "perToken") throw new Error("fixture");
  const pricing = model.pricing.speech!;
  assert.equal(SpeechTokenPricingSchema.safeParse({ ...pricing, rates: [...pricing.rates].reverse() }).success, false);
  const rate = pricing.rates[0]!;
  const schedule = (first: string, second: string) => ({ ...pricing, rates: [{ ...rate, effectiveFrom: first }, { ...rate, version: "next", effectiveFrom: second }] });
  assert.equal(SpeechTokenPricingSchema.safeParse(schedule("2027-01-01T00:00:00Z", "2027-01-01T00:00:00.001Z")).success, true);
  assert.equal(SpeechTokenPricingSchema.safeParse(schedule("2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00Z")).success, false);
  assert.equal(SpeechTokenPricingSchema.safeParse(schedule("2027-01-01T00:00:00.001Z", "2027-01-01T00:00:00Z")).success, false);
});
