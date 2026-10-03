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
  freeLimitReason,
  freePlanAllowance,
  freePlanAskCopy,
  freePlanFailure,
  freePlanNote,
  freePlanShortfall,
  freePlanStop,
  modelPriceCopy,
  narratorReadsUnasked,
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

// 2026-10-02: Google refused a 122-block chapter at 23:14 UTC with "limit: 10 requests per day on
// Free Tier ... retry in 45m28s" — a reset at 00:00 UTC, not midnight Pacific.
describe("a free day Google named", () => {
  const refusal = "Google free limit reached (HTTP 429 free daily quota · 10 a day · resets 2026-10-03T00:00:00.000Z)";
  const then = new Date("2026-10-02T23:14:32.000Z");

  it("keeps the limit and the reset a refusal named, and says them", () => {
    const stop = freePlanStop(refusal, then);
    assert.deepEqual(stop, { kind: "free-limit", provider: "google", resetsAt: "2026-10-03T00:00:00.000Z", limit: 10 });
    assert.equal(freePlanNote(refusal, then), "Google free limit reached · 10 a day · resets 17:00 PT · 46 m");
    assert.equal(freePlanFailure(refusal), "Google free limit reached · 10 a day · resets 2026-10-03T00:00:00.000Z");
    // A queue refusal of the rest of a batch reads the same way.
    assert.equal(freePlanStop(`${freeLimitReason({ allowed: 10, resetsAt: "2026-10-03T00:00:00.000Z" })} · not sent`, then)?.kind, "free-limit");
    // A failure that named no reset still says the opening alone, and midnight Pacific.
    assert.equal(freePlanFailure("Google free limit reached (HTTP 429 free daily quota)"), "Google free limit reached");
  });

  const entry = (ts: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
    ts, worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", jobId: `jb_${ts}`, provider: "google", model: gemini.id, outcome: "succeeded",
    estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "free-plan", speechQuote: { ...quoteSpeech(gemini, "x", { at: ts }), plan: "free-plan" }, ...extra,
  });

  it("counts the day's free reads Google took, since the last midnight Pacific", () => {
    const now = new Date("2026-10-02T18:00:00.000Z"); // 11:00 PDT; the day began 07:00 UTC
    const ledger = [
      entry("2026-10-02T06:59:00.000Z"), // yesterday, Pacific
      entry("2026-10-02T08:00:00.000Z"),
      entry("2026-10-02T09:00:00.000Z"),
      entry("2026-10-02T09:30:00.000Z", { outcome: "failed" }), // refused: no usage, not a request taken
      entry("2026-10-02T09:40:00.000Z", { outcome: "failed", speechUsage: { outputAudioTokens: 10 } }), // answered, then failed
      entry("2026-10-02T10:00:00.000Z", { model: "gemini-3.8-flash-lite-tts" }),
      entry("2026-10-02T10:00:00.000Z", { speechQuote: quoteSpeech(gemini, "x", { at: "2026-10-02T10:00:00.000Z" }) }), // paid
    ];
    assert.deepEqual(freePlanAllowance(ledger, gemini.id, now), { model: gemini.id, allowed: 10, left: 7, resetsAt: "2026-10-03T07:00:00.000Z", reached: false });
    assert.equal(freePlanAllowance([], "an-unknown-model", now).left, Infinity, "no limit is invented for a model never observed");
  });

  it("holds the day used up until the reset a refusal named, then counts from that reset", () => {
    const observed = { provider: "google", model: gemini.id, limit: 10, resetsAt: "2026-10-03T00:00:00.000Z", observedAt: then.toISOString() };
    assert.deepEqual(freePlanAllowance([], gemini.id, then, observed), { model: gemini.id, allowed: 10, left: 0, resetsAt: "2026-10-03T00:00:00.000Z", reached: true });
    const after = new Date("2026-10-03T01:00:00.000Z");
    const ledger = [entry("2026-10-02T23:50:00.000Z"), entry("2026-10-03T00:30:00.000Z")];
    assert.deepEqual(freePlanAllowance(ledger, gemini.id, after, { ...observed, limit: 25 }), { model: gemini.id, allowed: 25, left: 24, resetsAt: "2026-10-03T07:00:00.000Z", reached: false });
  });

  it("weighs a read whole per model, and asks in plain words", () => {
    const models = applyProviderPlans(manifest, free).models;
    const freeGemini = models.find((model) => model.id === gemini.id)!;
    const day = (model: string) => ({ model, allowed: 10, left: 10, resetsAt: "2026-10-03T07:00:00.000Z", reached: false });
    assert.equal(freePlanShortfall([{ model: freeGemini, requests: 6 }, { model: freeGemini, requests: 4 }], day), null);
    assert.deepEqual(freePlanShortfall([{ model: freeGemini, requests: 61 }, { model: freeGemini, requests: 61 }], day)?.short, { requests: 122, allowed: 10, left: 10 });
    assert.equal(freePlanShortfall([{ model: gemini, requests: 122 }, { model: null, requests: 5 }], day), null, "a paid row is not the free day's");
    assert.deepEqual(freePlanAskCopy({ requests: 122, allowed: 10, left: 10 }), { line: "122 reads · free plan allows 10 a day", confirm: "Read 10 now" });
    assert.deepEqual(freePlanAskCopy({ requests: 12, allowed: 10, left: 3 }), { line: "12 reads · free plan allows 10 a day · 3 left", confirm: "Read 3 now" });
    assert.equal(freePlanAskCopy({ requests: 2, allowed: 10, left: 0 }).confirm, "Read anyway");
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

describe("Read replies' narrator (design turn 183)", () => {
  const paul = { provider: "mistral", model: voxtral.id, voiceId: "en_paul_neutral" };
  const ife = { provider: "google", model: gemini.id, voiceId: "Kore" };
  it("reads unasked through the shipped voice, and through any narrator that falls to it", () => {
    assert.equal(narratorReadsUnasked(null, "w1", manifest.models, 0), true);
    assert.equal(narratorReadsUnasked({ provider: "kokoro", voiceId: "bf_emma" }, "w1", manifest.models, 0), true);
    // A clone chosen in another world is not this world's voice; the shipped one reads here.
    assert.equal(narratorReadsUnasked({ ...paul, worldId: "w2" }, "w1", manifest.models, 0), true);
  });
  it("reads unasked on a Free plan, and on a free credit only while there is some left", () => {
    const models = applyProviderPlans(manifest, { ...free, mistral: "free-credit" }).models;
    assert.equal(narratorReadsUnasked(ife, "w1", models, 0), true);
    assert.equal(narratorReadsUnasked(paul, "w1", models, 1), true);
    assert.equal(narratorReadsUnasked(paul, "w1", models, 0), false);
    // One reply weighed against what is left: room for five characters is not room for ten.
    assert.equal(narratorReadsUnasked(paul, "w1", models, 100, "Tides"), true);
    assert.equal(narratorReadsUnasked(paul, "w1", models, 100, "Tides rise"), false);
    // A reply on a free day with nothing left is left for Listen; the toggle itself stays offered.
    assert.equal(narratorReadsUnasked(ife, "w1", models, 0, "Tides", () => 1), true);
    assert.equal(narratorReadsUnasked(ife, "w1", models, 0, "Tides", () => 0), false);
    assert.equal(narratorReadsUnasked(ife, "w1", models, 0, undefined, () => 0), true);
  });
  it("asks through a priced reader, a hosted clone, and a choice the manifest does not list", () => {
    assert.equal(narratorReadsUnasked(paul, "w1", manifest.models, Infinity), false);
    const models = applyProviderPlans(manifest, credit).models;
    assert.equal(narratorReadsUnasked({ ...paul, worldId: "w1" }, "w1", models, Infinity), false);
    assert.equal(narratorReadsUnasked({ provider: "fishaudio", model: "s1", voiceId: "x" }, "w1", manifest.models, Infinity), false);
  });
});
