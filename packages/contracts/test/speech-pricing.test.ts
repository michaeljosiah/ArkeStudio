import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateMicroUsd, estimateSpeechMicroUsd, estimateSpeechTokens, quoteSpeech, speechQuoteIsCurrent, speechSettlement, speechUsageCost, SpeechTokenPricingSchema,
  type ManifestModel } from "../src/index.js";

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
  assert.ok(q.expectedMicroUsd > 0, "an estimate from the words, never $0");
  assert.ok(q.expectedMicroUsd < q.authorisedMicroUsd);
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

// The installed app, 2026-10-03: "Read the chapter · 122 blocks · $18.49" for a 3,247-word
// chapter, every block priced at the service limits. The estimate comes from the words; the
// limits stay the authorisation.
describe("a token reader's estimate", () => {
  const vocabulary = ["the", "harbour", "remembered", "every", "story", "she", "had", "never", "told", "anyone", "until", "tonight"];
  const chapter = Array.from({ length: 122 }, (_, block) => {
    const words = block < 75 ? 27 : 26;
    return Array.from({ length: words }, (_, at) => vocabulary[(block * 7 + at) % vocabulary.length]).join(" ") + ".";
  });

  it("prices a 3,247-word chapter of 122 blocks well under a dollar, under the same ceiling as before", () => {
    assert.equal(chapter.join(" ").split(" ").length, 3247);
    const quotes = chapter.map((block) => quoteSpeech(model, block, { at }));
    const estimate = quotes.reduce((sum, q) => sum + q.expectedMicroUsd, 0);
    // About 22 minutes of narration: tens of thousands of audio tokens, not two million.
    assert.ok(estimate > 300_000 && estimate < 600_000, `estimate ${estimate}`);
    assert.equal(estimateSpeechMicroUsd(model, chapter[0]!), quotes[0]!.expectedMicroUsd);
    const outputTokens = quotes.reduce((sum, q) => sum + q.quantities.outputAudioTokens!, 0);
    assert.ok(outputTokens > 22 * 60 * 25 && outputTokens < 22 * 60 * 25 * 1.6, `audio tokens ${outputTokens}`);
    // The authorisation is untouched: each request at the service limits, $18.49 in all.
    for (const q of quotes) assert.equal(q.authorisedMicroUsd, 151552);
    assert.equal(quotes.reduce((sum, q) => sum + q.authorisedMicroUsd, 0), 18_489_344);
    assert.deepEqual(quotes[0]!.tokenLimits, { input: 8192, output: 16384 });
  });

  it("clamps a long block at the service limit", () => {
    const long = Array.from({ length: 1400 }, () => "remembered").join(" ");
    const q = quoteSpeech(model, long, { at });
    assert.equal(q.quantities.outputAudioTokens, 16384);
    assert.ok(q.quantities.inputTextTokens! < 8192);
    assert.ok(q.expectedMicroUsd <= q.authorisedMicroUsd);
    const tokens = estimateSpeechTokens({ maxInputTokens: 100, maxOutputTokens: 200, audioTokensPerSecond: 25 }, long);
    assert.deepEqual(tokens, { inputTextTokens: 100, outputAudioTokens: 200 });
  });

  it("counts the style sent beside the words, and a delivery's sentence where none is given", () => {
    const words = "Don't you dare walk away from me.";
    const sentence = "Read coldly and flatly, without warmth.";
    const plain = quoteSpeech(model, words, { at }).quantities.inputTextTokens!;
    const styled = quoteSpeech(model, words, { at, instructions: sentence }).quantities.inputTextTokens!;
    assert.ok(styled > plain);
    const directed = { ...model, cadence: { deliveries: ["cold"], speed: null, pause: "none", emphasis: "none", breath: "none", outputTimestamps: "none",
      deliveryMappings: { cold: { settings: {}, instruction: sentence } } } } as unknown as ManifestModel;
    assert.equal(quoteSpeech(directed, words, { at, delivery: "cold" }).quantities.inputTextTokens, styled);
    // The audio estimate is the words' alone: the sentence is not read aloud.
    assert.equal(quoteSpeech(model, words, { at, instructions: sentence }).quantities.outputAudioTokens, quoteSpeech(model, words, { at }).quantities.outputAudioTokens);
  });

  it("reads an unspaced script by its characters rather than as one word", () => {
    const chinese = quoteSpeech(model, "港口记得每一个故事。仔细听，一个新的世界就开始了。", { at });
    const english = quoteSpeech(model, "The", { at });
    assert.ok(chinese.quantities.outputAudioTokens! > english.quantities.outputAudioTokens! * 2);
    const thai = quoteSpeech(model, "ท่าเรือจำทุกเรื่องราวได้ฟังให้ดีแล้วโลกใหม่จะเริ่มต้นขึ้น", { at });
    assert.ok(thai.quantities.outputAudioTokens! > english.quantities.outputAudioTokens! * 2);
    // Long spaced words are still words: the letters count only for an unspaced script (codex on PR 1477).
    const long = Array.from({ length: 10 }, () => "internationalization").join(" ");
    const short = Array.from({ length: 10 }, () => "cat").join(" ");
    assert.equal(quoteSpeech(model, long, { at }).quantities.outputAudioTokens, quoteSpeech(model, short, { at }).quantities.outputAudioTokens);
  });

  it("keeps the service limits as the estimate only where asked, for voice design's allowance", () => {
    const q = quoteSpeech(model, "A warm, low voice", { at, atServiceLimit: true });
    assert.equal(q.expectedMicroUsd, q.authorisedMicroUsd);
    assert.deepEqual(q.quantities, { inputTextTokens: 8192, outputAudioTokens: 16384 });
  });

  it("settles from reported usage, whatever was estimated", () => {
    const q = quoteSpeech(model, chapter[0]!, { at });
    const usage = { inputTextTokens: 40, outputAudioTokens: 380 };
    assert.equal(speechUsageCost(q, usage), 20 + 3420);
    assert.deepEqual(speechSettlement({ attempt: 1, speechQuote: q, speechUsage: usage }), { actualMicroUsd: 3440, actualSource: "usage-derived" });
    assert.deepEqual(speechSettlement({ attempt: 1, speechQuote: q }), { actualMicroUsd: null }, "no usage is unknown, never the estimate");
  });
});
