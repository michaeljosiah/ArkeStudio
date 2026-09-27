import { z } from "zod";
import type { ManifestModel } from "./manifest.js";
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
    if (value.rates[i]!.effectiveFrom <= value.rates[i - 1]!.effectiveFrom) {
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
}).strict();
export type SpeechQuote = z.infer<typeof SpeechQuoteSchema>;

/** A deliberate retry may pay twice. Each earlier attempt keeps its own rate and quantities. */
export const SpeechAttemptSchema = z.object({
  attempt: Quantity.positive(),
  quote: SpeechQuoteSchema,
  usage: SpeechUsageSchema,
}).strict();
export type SpeechAttempt = z.infer<typeof SpeechAttemptSchema>;

function tokenCost(input: number, output: number, rates: { input: number; output: number }): number {
  // BigInt prevents rounding down a fractional micro-dollar or overflowing an intermediate.
  const million = 1_000_000n;
  const amount = (BigInt(input) * BigInt(rates.input) + million - 1n) / million
    + (BigInt(output) * BigInt(rates.output) + million - 1n) / million;
  const result = Number(amount);
  if (!Number.isSafeInteger(result)) throw new Error("Speech cost exceeds the supported money range");
  return result;
}

/** The compiled transcript is priced; callers must not count direction tags twice. */
export function quoteSpeech(model: ManifestModel, text: string, options: {
  at?: string;
  delivery?: string;
  language?: string;
  inputTextTokens?: number;
  expectedAudioSeconds?: number;
} = {}): SpeechQuote {
  const at = options.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error("A speech quote needs a valid date");
  const base = { model: model.id, provider: model.provider, quotedAt: at, validUntil: null };
  const pricing = model.pricing;
  if (pricing.kind === "unmetered") {
    return SpeechQuoteSchema.parse({ ...base, tier: "unmetered", unit: "unmetered", rateVersion: "unmetered",
      quantities: {}, assumptions: [], expectedMicroUsd: 0, authorisedMicroUsd: 0 });
  }
  if (pricing.kind === "perCharacter") {
    const characters = billableCharacters(model, text, options.delivery, options.language);
    const cost = characters * pricing.microUsdPerCharacter;
    return SpeechQuoteSchema.parse({ ...base, tier: "standard", unit: pricing.unit ?? "character",
      rateVersion: `${pricing.unit ?? "character"}:${pricing.microUsdPerCharacter}`, quantities: { characters },
      assumptions: [], expectedMicroUsd: cost, authorisedMicroUsd: cost });
  }
  if (pricing.kind !== "perToken" || pricing.speech === undefined) {
    throw new Error(`${model.displayName} has no qualified speech pricing`);
  }
  const speech = SpeechTokenPricingSchema.parse(pricing.speech);
  const active = speech.rates.findLastIndex((rate) => Date.parse(rate.effectiveFrom) <= Date.parse(at));
  if (active < 0) throw new Error(`${model.displayName} has no speech rate for this date`);
  const rate = speech.rates[active]!;
  const rates = { input: rate.microUsdPerMillionInput, output: rate.microUsdPerMillionOutput };
  const assumptions: string[] = [];
  const input = options.inputTextTokens ?? speech.maxInputTokens;
  Quantity.parse(input);
  if (input > speech.maxInputTokens) throw new Error("Speech input exceeds the model's token limit");
  if (options.inputTextTokens === undefined) assumptions.push("Input priced at the service token limit; no token count was reported.");
  let output = speech.maxOutputTokens;
  if (options.expectedAudioSeconds !== undefined) {
    if (!Number.isFinite(options.expectedAudioSeconds) || options.expectedAudioSeconds < 0) throw new Error("Invalid expected speech duration");
    output = Math.ceil(options.expectedAudioSeconds * speech.audioTokensPerSecond);
    if (output > speech.maxOutputTokens) throw new Error("Expected speech exceeds the model's output limit; split the text");
    assumptions.push("Expected audio tokens are estimated from duration; the authorisation uses the service limit.");
  } else assumptions.push("Output priced at the service token limit; duration is not known before synthesis.");
  return SpeechQuoteSchema.parse({ ...base, validUntil: speech.rates[active + 1]?.effectiveFrom ?? null,
    tier: speech.tier, rateVersion: rate.version, unit: "token", quantities: { inputTextTokens: input, outputAudioTokens: output },
    tokenRates: rates, tokenLimits: { input: speech.maxInputTokens, output: speech.maxOutputTokens }, assumptions,
    expectedMicroUsd: tokenCost(input, output, rates),
    authorisedMicroUsd: tokenCost(speech.maxInputTokens, speech.maxOutputTokens, rates) });
}

/** Existing confirmations show this conservative authorisation, never a duration guess. */
export function estimateSpeechMicroUsd(model: ManifestModel, text: string, delivery?: string, language?: string): number {
  return quoteSpeech(model, text, { delivery, language }).authorisedMicroUsd;
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
