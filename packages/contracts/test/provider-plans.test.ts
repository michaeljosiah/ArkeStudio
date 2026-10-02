import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppSettingsSchema,
  applyProviderPlans,
  compactCount,
  formatTimeLeft,
  freeCreditDraw,
  freeCreditLeft,
  freeCreditOverrun,
  freeCreditThisMonth,
  freePlanFailure,
  freePlanNote,
  freePlanStop,
  modelPriceCopy,
  nextPacificMidnight,
  PAID_PLANS,
  quoteSpeech,
  quoteVoiceDesign,
  readerPriceLabel,
  speechAsks,
  speechPlanFor,
  speechPriceCopy,
  speechSettlement,
  spendSummary,
  tableReadPlanNote,
  type LedgerEntry,
  type ManifestModel,
  type ModelManifest,
} from "../src/index.js";

// Design turn 182: a provider's Free plan, voice first.

const gemini: ManifestModel = {
  id: "gemini-3.8-flash-tts", provider: "google", capability: "voice-tts", displayName: "Gemini 3.8 Flash TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perToken", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000,
    speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25,
      rates: [{ version: "gemini-3.8-flash-standard-2026-09-27", effectiveFrom: "2026-09-27T00:00:00.000Z", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000 }] } },
};
const voxtral: ManifestModel = {
  id: "voxtral-mini-tts", provider: "mistral", capability: "voice-tts", displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perCharacter", microUsdPerCharacter: 16 },
};
const image: ManifestModel = {
  id: "gemini-image", provider: "google", capability: "image", displayName: "Gemini image",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 40_000 },
};
const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-10-02", models: [gemini, voxtral, image] };
const at = "2026-10-02T09:14:00.000Z";
const free = { ...PAID_PLANS, google: "free" as const };
const credit = { ...PAID_PLANS, mistral: "free-credit" as const };

describe("the author's plan on the manifest", () => {
  it("serves the shipped manifest untouched while every key is paid", () => {
    assert.equal(applyProviderPlans(manifest, PAID_PLANS), manifest);
  });

  it("stamps speech rows only, and takes the stamp off again", () => {
    const planned = applyProviderPlans(manifest, { ...free, mistral: "free-credit" });
    assert.equal(planned.models.find((m) => m.id === gemini.id)?.speechPlan, "free-plan");
    assert.equal(planned.models.find((m) => m.id === voxtral.id)?.speechPlan, "free-credit");
    assert.equal(planned.models.find((m) => m.id === image.id)?.speechPlan, undefined, "voice only: a key's other capabilities stay priced");
    const back = applyProviderPlans(planned, PAID_PLANS);
    assert.ok(back.models.every((m) => m.speechPlan === undefined));
  });

  it("prices Google reads again after a billed read until the author says Free once more", () => {
    assert.equal(speechPlanFor(free, "google", gemini.id), "free-plan");
    assert.equal(speechPlanFor({ ...free, googleBilledAt: at }, "google", gemini.id), undefined);
    assert.equal(speechPlanFor(free, "google", "gemini-3.8-pro"), undefined);
  });
});

describe("a read on a free plan", () => {
  it("is quoted at $0 with its token arithmetic kept, and never current on the paid plan", () => {
    const row = applyProviderPlans(manifest, free).models[0]!;
    const quote = quoteSpeech(row, "Hello", { at });
    assert.equal(quote.authorisedMicroUsd, 0);
    assert.equal(quote.expectedMicroUsd, 0);
    assert.equal(quote.plan, "free-plan");
    assert.equal(quote.unit, "token");
    assert.deepEqual(quote.tokenRates, { input: 0, output: 0 });
    assert.match(quote.rateVersion, /^free-plan:/);
    assert.notEqual(quote.rateVersion, quoteSpeech(gemini, "Hello", { at }).rateVersion);
    assert.equal(speechAsks(row, quote.authorisedMicroUsd), false);
  });

  it("leaves voice design priced on the same row", () => {
    const row = applyProviderPlans(manifest, free).models[0]!;
    const design = quoteVoiceDesign(row, "A low, unhurried voice", at);
    assert.ok(design.authorisedMicroUsd > 0);
    assert.equal(design.plan, undefined);
    assert.equal(design.rateVersion, quoteVoiceDesign(gemini, "A low, unhurried voice", at).rateVersion);
  });

  it("settles at $0 as free-plan with its usage, unless the provider reports a charge", () => {
    const quote = quoteSpeech(applyProviderPlans(manifest, free).models[0]!, "Hello", { at });
    assert.deepEqual(speechSettlement({ attempt: 1, speechQuote: quote, speechUsage: { inputTextTokens: 4, outputAudioTokens: 300 } }), { actualMicroUsd: 0, actualSource: "free-plan" });
    assert.deepEqual(speechSettlement({ attempt: 1, speechQuote: quote }), { actualMicroUsd: 0, actualSource: "free-plan" });
    assert.deepEqual(speechSettlement({ attempt: 1, speechQuote: quote, providerCostMicroUsd: 120 }), { actualMicroUsd: 120, actualSource: "provider-reported" });
  });

  it("names its plan where the price was", () => {
    const row = applyProviderPlans(manifest, free).models[0]!;
    assert.equal(speechPriceCopy(row, 0), "free plan");
    assert.equal(readerPriceLabel(row), "free plan");
    assert.equal(modelPriceCopy(row), "free plan");
    assert.equal(speechPriceCopy(gemini, 151_552), "up to $0.15");
  });
});

describe("a read on a free credit", () => {
  it("keeps its estimate and asks nothing", () => {
    const row = applyProviderPlans(manifest, credit).models[1]!;
    const quote = quoteSpeech(row, "Hello there", { at });
    assert.equal(quote.authorisedMicroUsd, 11 * 16);
    assert.equal(quote.plan, "free-credit");
    assert.equal(quote.rateVersion, quoteSpeech(voxtral, "Hello there", { at }).rateVersion);
    assert.equal(speechAsks(row, quote.authorisedMicroUsd), false);
    assert.equal(speechAsks(voxtral, quote.authorisedMicroUsd), true);
    assert.equal(speechAsks(voxtral, 0), false, "a read that costs nothing asks nothing");
    assert.equal(speechPriceCopy(row, quote.authorisedMicroUsd), "free credit");
    assert.equal(modelPriceCopy(row), "$16.00 / M characters · free credit");
  });

  // The owner's rule (2026-10-02): a credit read past what is left of the month asks, because
  // Mistral bills the rest when pay-as-you-go is on and Arke cannot see whether it is.
  it("asks again once a read, a chapter or a book would run past the month's credit left", () => {
    const row = applyProviderPlans(manifest, credit).models[1]!;
    const price = quoteSpeech(row, "Hello there", { at }).authorisedMicroUsd;
    assert.equal(speechAsks(row, price, price), false, "exactly what is left still fits");
    assert.equal(speechAsks(row, price, price - 1), true);
    assert.equal(speechAsks(row, price), false, "an unknown balance is not short");
    assert.equal(speechAsks(voxtral, price, Infinity), true, "a paid row asks however much credit is left");
    assert.equal(speechPriceCopy(row, price, price - 1), "$0.0002 · past free credit");
    assert.equal(speechPriceCopy(row, price, price), "free credit");
    const draw = freeCreditDraw([{ model: row, microUsd: 400 }, { model: row, microUsd: 400 }, { model: voxtral, microUsd: 900 }]);
    assert.equal(draw, 800, "only reads on the credit draw from it");
    assert.equal(freeCreditOverrun(draw, 799), true, "reads that each fit run past it together");
    assert.equal(freeCreditOverrun(draw, 800), false);
    assert.equal(freeCreditOverrun(0, 0), false, "drawing nothing never asks");
    const spent = (microUsd: number): LedgerEntry => ({
      ts: new Date(2026, 9, 2, 9).toISOString(), worldId: "01K0000000000000000000000W", jobId: "jb_01K00000000000000000000001", provider: "mistral", model: voxtral.id,
      outcome: "succeeded", estimatedMicroUsd: microUsd, actualMicroUsd: microUsd, actualSource: "free-credit",
      speechQuote: { ...quoteSpeech(voxtral, "x", { at }), plan: "free-credit" },
    });
    const now = new Date(2026, 9, 20, 12);
    assert.equal(freeCreditLeft([spent(3_420_000)], now), 6_580_000);
    assert.equal(freeCreditLeft([spent(12_000_000)], now), 0, "never below zero");
  });

  it("counts the month's draw against the credit, this month only", () => {
    const entry = (ts: string, microUsd: number, characters: number, source: LedgerEntry["actualSource"] = "free-credit"): LedgerEntry => ({
      ts, worldId: "01K0000000000000000000000W", jobId: `jb_01K00000000000000000000${String(microUsd).padStart(3, "0")}`, provider: "mistral", model: voxtral.id,
      outcome: "succeeded", estimatedMicroUsd: microUsd, actualMicroUsd: microUsd, actualSource: source,
      speechQuote: { ...quoteSpeech(voxtral, "x".repeat(characters), { at: ts }), plan: "free-credit" },
    });
    const now = new Date(2026, 9, 20, 12);
    const month = freeCreditThisMonth([
      entry(new Date(2026, 9, 2, 9).toISOString(), 300, 20),
      entry(new Date(2026, 9, 3, 9).toISOString(), 400, 25),
      entry(new Date(2026, 8, 30, 9).toISOString(), 900, 50),
      entry(new Date(2026, 9, 4, 9).toISOString(), 500, 30, "manifest-derived"),
    ], "mistral", now);
    assert.deepEqual(month, { microUsd: 700, characters: 45, reads: 2 });
  });
});

describe("spend counts free reads apart", () => {
  it("keeps them out of the total and out of the unmetered count", () => {
    const quote = quoteSpeech(applyProviderPlans(manifest, free).models[0]!, "Hello", { at });
    const base = { worldId: "01K0000000000000000000000W", outcome: "succeeded" as const };
    const summary = spendSummary([
      { ...base, ts: at, jobId: "jb_01K000000000000000000000A1", provider: "google", model: gemini.id, estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "free-plan", speechQuote: quote, speechUsage: { inputTextTokens: 1000, outputAudioTokens: 30_000 } },
      { ...base, ts: at, jobId: "jb_01K000000000000000000000A2", provider: "mistral", model: voxtral.id, estimatedMicroUsd: 70_000, actualMicroUsd: 70_000, actualSource: "free-credit", speechQuote: { ...quoteSpeech(voxtral, "x".repeat(4100), { at }), plan: "free-credit" } },
      { ...base, ts: at, jobId: "jb_01K000000000000000000000A3", provider: "breezeblue", model: "breeze", estimatedMicroUsd: 4000, actualMicroUsd: 4000, actualSource: "manifest-derived" },
    ], 7, new Date(at));
    assert.equal(summary.totalMicroUsd, 4000);
    assert.equal(summary.unmeteredRuns, 0);
    assert.deepEqual(summary.plans, [
      { provider: "google", plan: "free-plan", entries: 1, microUsd: 0, tokens: 31_000, characters: 0 },
      { provider: "mistral", plan: "free-credit", entries: 1, microUsd: 70_000, tokens: 0, characters: 4100 },
    ]);
    assert.equal(compactCount(31_000), "31k");
    assert.equal(compactCount(4100), "4.1k");
    assert.equal(compactCount(980), "980");
  });
});

describe("plans in app settings", () => {
  it("reads a file from before plans as all-paid, and a malformed block as all-paid", () => {
    assert.deepEqual(AppSettingsSchema.parse({}).plans, PAID_PLANS);
    assert.deepEqual(AppSettingsSchema.parse({ plans: { google: "gratis" } }).plans, PAID_PLANS);
    assert.deepEqual(AppSettingsSchema.parse({ plans: { google: "free" } }).plans, { ...PAID_PLANS, google: "free" });
  });
});

describe("the two ways a free plan ends", () => {
  it("recognises the daily limit and the billed key, and nothing else", () => {
    const now = new Date("2026-10-02T18:48:00.000Z"); // 11:48 PDT
    const limit = freePlanStop("Google free limit reached (HTTP 429 free daily quota)", now);
    assert.equal(limit?.kind, "free-limit");
    assert.equal(limit?.kind === "free-limit" ? limit.resetsAt : null, "2026-10-03T07:00:00.000Z");
    assert.equal(freePlanNote("Google free limit reached", now), "Google free limit reached · resets 00:00 PT · 12 h 12 m");
    assert.equal(freePlanStop("Google billed this read · key looks paid (Google asked for payment)", now)?.kind, "billed");
    assert.equal(freePlanFailure("Google billed this read · key looks paid (HTTP 402)"), "Google billed this read · key looks paid");
    assert.equal(freePlanStop("Google's project quota was reached (HTTP 429)", now), null);
    assert.equal(freePlanFailure(undefined), null);
  });

  it("resets at midnight Pacific across daylight saving", () => {
    assert.equal(nextPacificMidnight(new Date("2026-01-15T20:00:00.000Z")).toISOString(), "2026-01-16T08:00:00.000Z");
    assert.equal(nextPacificMidnight(new Date("2026-07-15T06:59:00.000Z")).toISOString(), "2026-07-15T07:00:00.000Z");
    assert.equal(nextPacificMidnight(new Date("2026-07-15T07:00:00.000Z")).toISOString(), "2026-07-16T07:00:00.000Z");
    assert.equal(formatTimeLeft(new Date(0), new Date(5 * 3_600_000 + 12 * 60_000)), "5 h 12 m");
    assert.equal(formatTimeLeft(new Date(0), new Date(9 * 60_000)), "9 m");
  });
});

describe("a table read's door", () => {
  it("names the plan only when every line it sends is on one", () => {
    const models = applyProviderPlans(manifest, { ...free, mistral: "free-credit" }).models;
    assert.equal(tableReadPlanNote({ items: [{ route: "cloud", provider: "google", model: gemini.id }, { route: "local" }] }, models), "free plan");
    assert.equal(tableReadPlanNote({ items: [{ route: "cloud", provider: "mistral", model: voxtral.id }, { route: "cloud", provider: "google", model: gemini.id }] }, models), "free credit");
    assert.equal(tableReadPlanNote({ items: [{ route: "cloud", provider: "google", model: gemini.id }, { route: "cloud", provider: "fal", model: "other" }] }, models), null);
    assert.equal(tableReadPlanNote({ items: [{ route: "local" }] }, models), null);
  });
});
