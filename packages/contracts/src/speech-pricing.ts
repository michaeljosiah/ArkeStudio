import { z } from "zod";
import type { ManifestModel } from "./manifest.js";
import { speechUtf8Bytes } from "./speech-input.js";
import { billableCharacters } from "./speech-units.js";

const Quantity = z.number().int().nonnegative().safe();
const Rate = z.object({
  version: z.string().min(1),
  effectiveFrom: z.string().datetime(),
  microUsdPerMillionInput: Quantity,
  microUsdPerMillionOutput: Quantity,
}).strict();

/** SPEC-049 R-5..R-8. Limits are service guarantees, never duration estimates. */
export const SpeechTokenPricingSchema = z.object({
  tier: z.enum(["standard", "batch"]),
  rates: z.array(Rate).min(1),
  maxInputTokens: Quantity.positive(),
  maxOutputTokens: Quantity.positive(),
  audioTokensPerSecond: z.number().positive().finite(),
}).strict().superRefine((value, ctx) => {
  for (let i = 1; i < value.rates.length; i++) {
    if (Date.parse(value.rates[i]!.effectiveFrom) <= Date.parse(value.rates[i - 1]!.effectiveFrom)) {
      ctx.addIssue({ code: "custom", message: "Speech rates must have unique, increasing effective dates" });
    }
  }
});

export const SpeechUsageSchema = z.object({
  inputTextTokens: Quantity.optional(),
  outputAudioTokens: Quantity.optional(),
}).strict();
export type SpeechUsage = z.infer<typeof SpeechUsageSchema>;

export const SpeechQuoteSchema = z.object({
  costBasis: z.literal("estimate").optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  quotedAt: z.string().datetime(),
  validUntil: z.string().datetime().nullable(),
  tier: z.enum(["standard", "batch", "unmetered"]),
  rateVersion: z.string().min(1),
  unit: z.enum(["character", "cjk-double", "utf8-byte", "token", "unmetered"]),
  quantities: z.object({
    characters: Quantity.optional(),
    inputTextTokens: Quantity.optional(),
    outputAudioTokens: Quantity.optional(),
  }).strict(),
  tokenRates: z.object({ input: Quantity, output: Quantity }).strict().optional(),
  tokenLimits: z.object({ input: Quantity, output: Quantity }).strict().optional(),
  assumptions: z.array(z.string()),
  expectedMicroUsd: Quantity,
  authorisedMicroUsd: Quantity,
  /**
   * The author's plan for the key when the read was quoted (design turn 182). `free-plan` is a
   * $0 quote that is the author's statement, recorded as such rather than inferred (SPEC-049
   * R-19 yields to it); `free-credit` keeps its estimate and is drawn from a monthly allowance.
   */
  plan: z.enum(["free-plan", "free-credit"]).optional(),
}).strict();
export type SpeechQuote = z.infer<typeof SpeechQuoteSchema>;

/** A deliberate retry may pay twice. Each earlier attempt keeps its own rate and quantities. */
export const SpeechAttemptSchema = z.object({
  attempt: Quantity.positive(),
  quote: SpeechQuoteSchema,
  usage: SpeechUsageSchema,
  providerCostMicroUsd: Quantity.optional(),
}).strict();
export type SpeechAttempt = z.infer<typeof SpeechAttemptSchema>;

/** Shared by durable settlement and terminal receipts; an authorisation is never an actual. */
export function speechSettlement(job: {
  attempt: number;
  speechQuote?: SpeechQuote;
  speechUsage?: SpeechUsage;
  speechAttempts?: SpeechAttempt[];
  providerCostMicroUsd?: number;
}): { actualMicroUsd: number | null; actualSource?: "provider-reported" | "usage-derived" | "mixed-measured" | "free-plan" } {
  // A read on a key the author marked Free is recorded at $0 with its usage kept (design turn
  // 182) — unless the provider reported a charge, which is the evidence the key is paid and is
  // recorded as reported, never hidden behind the plan.
  const free = job.speechQuote?.plan === "free-plan" && (job.speechAttempts ?? []).every(attempt => attempt.quote.plan === "free-plan");
  const charged = (job.providerCostMicroUsd ?? 0) > 0 || (job.speechAttempts ?? []).some(attempt => (attempt.providerCostMicroUsd ?? 0) > 0);
  if (free && !charged) return { actualMicroUsd: 0, actualSource: "free-plan" };
  const archived = job.speechAttempts?.some(attempt => attempt.attempt === job.attempt) === true;
  let hasReported = !archived && job.providerCostMicroUsd !== undefined;
  let hasUsage = !archived && job.providerCostMicroUsd === undefined;
  let actualMicroUsd = archived ? 0 : job.providerCostMicroUsd ?? (job.speechQuote && job.speechUsage ? speechUsageCost(job.speechQuote, job.speechUsage) : null);
  for (const attempt of job.speechAttempts ?? []) {
    const prior = attempt.providerCostMicroUsd ?? speechUsageCost(attempt.quote, attempt.usage);
    hasReported ||= attempt.providerCostMicroUsd !== undefined;
    hasUsage ||= attempt.providerCostMicroUsd === undefined;
    actualMicroUsd = actualMicroUsd === null || prior === null ? null : actualMicroUsd + prior;
  }
  return actualMicroUsd === null ? { actualMicroUsd } : { actualMicroUsd, actualSource: hasReported ? hasUsage ? "mixed-measured" : "provider-reported" : "usage-derived" };
}

function tokenCost(input: number, output: number, rates: { input: number; output: number }): number {
  // BigInt prevents rounding down a fractional micro-dollar or overflowing an intermediate.
  const million = 1_000_000n;
  const amount = (BigInt(input) * BigInt(rates.input) + million - 1n) / million
    + (BigInt(output) * BigInt(rates.output) + million - 1n) / million;
  const result = Number(amount);
  if (!Number.isSafeInteger(result)) throw new Error("Speech cost exceeds the supported money range");
  return result;
}

const FREE_PLAN_ASSUMPTION = "Free plan: the author marked this key free; the read is recorded at $0.";

/**
 * How a token reader's read is estimated before it is made (SPEC-049 R-6). The estimate is the
 * figure a screen shows and the author approves; the service limits stay the authorisation, so
 * no read is billed past them, and the ledger's actual comes from the usage Google reports.
 * Pricing the estimate at those limits — 16,384 audio tokens for a block of a few seconds —
 * put $18.49 on a 3,247-word chapter of 122 blocks that reads for about $0.40 (2026-10-03).
 *
 * Calibrated on the 34 Flash and Lite reads in the author's ledger from 2026-09-29 to 10-02:
 * 7,070 words billed 11.4 audio tokens a word overall, and lines under 30 words 13–20, where
 * the lead-in and tail are a larger share. Prose billed about 4.4 characters an input token,
 * a short line nearer 3. The September probes billed about 32 audio tokens a second of WAV
 * against the published 25, which the margin covers. What this gives, 12.5 tokens a word and
 * 62.5 a request, estimates 1.10 of the audio those 34 reads billed in all; a single read billed
 * from 0.59 to 1.47 times its estimate, so it is said as an estimate (`~`, never `up to`).
 */
export const SPEECH_TOKEN_ESTIMATE = {
  /** An unhurried narration pace; a CJK character counts as half a word, about 5 a second. */
  wordsPerMinute: 150,
  /** Each request's lead-in and tail, which are billed as audio like the words. */
  edgeSeconds: 2,
  /** Over the published audio-token rate. */
  margin: 1.25,
  /** UTF-8 bytes an input token: under the 4.4 measured for prose, and about one per CJK character. */
  bytesPerInputToken: 4,
  /** Each request's turn framing. */
  inputOverheadTokens: 4,
} as const;

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

// Thai, Lao, Khmer and Burmese leave out the spaces between words.
const UNSPACED_CHARACTER = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;

/** Spoken words: a CJK character is half of one, and an unspaced script is read by its letters. */
function speechWords(text: string): number {
  const cjk = text.match(CJK_CHARACTER)?.length ?? 0;
  // Six letters to a word keeps a long unspaced line from reading as one word. Counted for
  // those scripts alone: over all text, long English words outweighed the words themselves
  // (codex on PR 1477).
  const unspaced = text.match(UNSPACED_CHARACTER)?.length ?? 0;
  const words = text.replace(CJK_CHARACTER, " ").replace(UNSPACED_CHARACTER, " ").split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return words + cjk / 2 + unspaced / 6;
}

/** The words' expected speech at the estimate's pace, without a request's lead-in and tail. */
export function expectedSpeechSeconds(text: string): number {
  return speechWords(text) / (SPEECH_TOKEN_ESTIMATE.wordsPerMinute / 60);
}

/** The estimate's token counts for one request, each clamped to the service limit. */
export function estimateSpeechTokens(speech: Pick<z.infer<typeof SpeechTokenPricingSchema>, "maxInputTokens" | "maxOutputTokens" | "audioTokensPerSecond">,
  text: string, instructions = ""): { inputTextTokens: number; outputAudioTokens: number } {
  const e = SPEECH_TOKEN_ESTIMATE;
  const input = Math.ceil((speechUtf8Bytes(text) + speechUtf8Bytes(instructions)) / e.bytesPerInputToken) + e.inputOverheadTokens;
  const seconds = expectedSpeechSeconds(text) + e.edgeSeconds;
  const output = Math.ceil(seconds * speech.audioTokensPerSecond * e.margin);
  return { inputTextTokens: Math.min(input, speech.maxInputTokens), outputAudioTokens: Math.min(output, speech.maxOutputTokens) };
}

/** The compiled transcript is priced; callers must not count direction tags twice. */
export function quoteSpeech(model: ManifestModel, text: string, options: {
  at?: string;
  delivery?: string;
  language?: string;
  /**
   * The style sent beside the words, for a token reader's input estimate. A delivery named
   * without it is looked up as the row's sentence, as the Google client resolves it.
   */
  instructions?: string;
  inputTextTokens?: number;
  expectedAudioSeconds?: number;
  /**
   * Estimate at the service limits too: for a call whose output is not these words read aloud
   * — voice design, whose estimate is the explicit R-19 budgeting allowance.
   */
  atServiceLimit?: boolean;
} = {}): SpeechQuote {
  const at = options.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error("A speech quote needs a valid date");
  const base = { model: model.id, provider: model.provider, quotedAt: at, validUntil: null };
  const pricing = model.pricing;
  const plan = pricing.kind === "unmetered" ? undefined : model.speechPlan;
  const free = plan === "free-plan";
  const planned = plan === undefined ? {} : { plan };
  if (pricing.kind === "unmetered") {
    return SpeechQuoteSchema.parse({ ...base, tier: "unmetered", unit: "unmetered", rateVersion: "unmetered",
      quantities: {}, assumptions: [], expectedMicroUsd: 0, authorisedMicroUsd: 0 });
  }
  if (pricing.kind === "perCharacter") {
    const characters = billableCharacters(model, text, options.delivery, options.language);
    const cost = free ? 0 : characters * pricing.microUsdPerCharacter;
    return SpeechQuoteSchema.parse({ ...base, ...planned, tier: "standard", unit: pricing.unit ?? "character",
      rateVersion: `${free ? "free-plan:" : ""}${pricing.unit ?? "character"}:${pricing.microUsdPerCharacter}`, quantities: { characters },
      assumptions: free ? [FREE_PLAN_ASSUMPTION] : [], expectedMicroUsd: cost, authorisedMicroUsd: cost });
  }
  if (pricing.kind !== "perToken" || pricing.speech === undefined) {
    throw new Error(`${model.displayName} has no qualified speech pricing`);
  }
  const speech = SpeechTokenPricingSchema.parse(pricing.speech);
  const active = speech.rates.findLastIndex((rate) => Date.parse(rate.effectiveFrom) <= Date.parse(at));
  if (active < 0) throw new Error(`${model.displayName} has no speech rate for this date`);
  const rate = speech.rates[active]!;
  // Free keeps the token arithmetic, at zero rates, so usage is still measured and recorded; the
  // rate version names the plan, so a quote made on one plan is never current on the other.
  const rates = free ? { input: 0, output: 0 } : { input: rate.microUsdPerMillionInput, output: rate.microUsdPerMillionOutput };
  const assumptions: string[] = free ? [FREE_PLAN_ASSUMPTION] : [];
  const style = options.instructions ?? (options.delivery !== undefined ? model.cadence?.deliveryMappings[options.delivery]?.instruction : undefined);
  const estimated = options.atServiceLimit === true
    ? { inputTextTokens: speech.maxInputTokens, outputAudioTokens: speech.maxOutputTokens }
    : estimateSpeechTokens(speech, text, style);
  const input = options.inputTextTokens ?? estimated.inputTextTokens;
  Quantity.parse(input);
  if (input > speech.maxInputTokens) throw new Error("Speech input exceeds the model's token limit");
  if (options.inputTextTokens === undefined) {
    assumptions.push(options.atServiceLimit === true ? "Input priced at the service token limit."
      : "Input tokens estimated from the words and style at 4 UTF-8 bytes a token.");
  }
  let output = estimated.outputAudioTokens;
  if (options.expectedAudioSeconds !== undefined) {
    if (!Number.isFinite(options.expectedAudioSeconds) || options.expectedAudioSeconds < 0) throw new Error("Invalid expected speech duration");
    output = Math.ceil(options.expectedAudioSeconds * speech.audioTokensPerSecond);
    if (output > speech.maxOutputTokens) throw new Error("Expected speech exceeds the model's output limit; split the text");
    assumptions.push("Expected audio tokens are estimated from duration; the authorisation uses the service limit.");
  } else {
    assumptions.push(options.atServiceLimit === true ? "Output priced at the service token limit."
      : "Audio tokens estimated at 150 words a minute, 2 s of lead-in and tail, plus 25%; the authorisation uses the service limit.");
  }
  return SpeechQuoteSchema.parse({ ...base, ...planned, validUntil: speech.rates[active + 1]?.effectiveFrom ?? null,
    tier: speech.tier, rateVersion: free ? `free-plan:${rate.version}` : rate.version, unit: "token", quantities: { inputTextTokens: input, outputAudioTokens: output },
    tokenRates: rates, tokenLimits: { input: speech.maxInputTokens, output: speech.maxOutputTokens }, assumptions,
    expectedMicroUsd: tokenCost(input, output, rates),
    authorisedMicroUsd: tokenCost(speech.maxInputTokens, speech.maxOutputTokens, rates) });
}

/**
 * What a screen shows and the author approves: the estimate, never the authorisation ceiling
 * (SPEC-049 R-6). A guard that compares a screen's figure with a fresh one prices the words
 * alone and leaves `instructions` out: the style's input tokens, hundredths of a cent, belong in
 * the recorded quote, but a guard that counted them would refuse a read whose screen priced the
 * same words without the sentence. The authorisation still caps the read either way.
 */
export function estimateSpeechMicroUsd(model: ManifestModel, text: string, delivery?: string, language?: string, instructions?: string): number {
  return quoteSpeech(model, text, { delivery, language, ...(instructions !== undefined ? { instructions } : {}) }).expectedMicroUsd;
}

/**
 * What goes before a read's price where the screen states a bound for character readers: `up
 * to`, since only a cache hit lowers their figure — or `~` once any reader in it is priced by
 * the token, whose figure is an estimate the read can pass (SPEC-049 R-6).
 */
export function speechPricePrefix(models: readonly Pick<ManifestModel, "provider" | "capability" | "pricing">[] | undefined, providers: Iterable<string>): "~" | "up to " {
  for (const provider of providers) {
    if (models?.some((model) => model.provider === provider && model.capability === "voice-tts" && model.pricing.kind === "perToken")) return "~";
  }
  return "up to ";
}

export function speechQuoteIsCurrent(quote: SpeechQuote, at: string): boolean {
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= Date.parse(quote.quotedAt)
    && (quote.validUntil === null || time < Date.parse(quote.validUntil));
}

/** Missing either count is unknown, including after a successful or cancelled request. */
export function speechUsageCost(quote: SpeechQuote, usage: SpeechUsage): number | null {
  SpeechUsageSchema.parse(usage);
  if (quote.tokenRates === undefined || usage.inputTextTokens === undefined || usage.outputAudioTokens === undefined) return null;
  return tokenCost(usage.inputTextTokens, usage.outputAudioTokens, quote.tokenRates);
}
