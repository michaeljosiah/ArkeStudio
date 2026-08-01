import { z } from "zod";
import { IsoDateSchema } from "./ids.js";
import { CapabilitySchema, ProviderIdSchema } from "./provider.js";

/**
 * The model manifest (SPEC-008 §2.5): hand-maintained, shipped with the app, the one file the
 * model picker's capability copy, the pre-dispatch estimate and pass packing are all read from.
 * Money is integer micro-dollars throughout (R-14, D3).
 */

// ---------------------------------------------------------------------------
// Pricing — a discriminated union, because providers do not share a shape (R-11, D2)
// ---------------------------------------------------------------------------

export const PricingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("perSecond"),
      microUsdPerSecond: z.number().int().min(0),
      /** Resolution-specific overrides, e.g. 1080p billing double (§2.5). */
      byResolution: z.record(z.string(), z.number().int().min(0)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("perImage"),
      microUsdPerImage: z.number().int().min(0),
      byResolution: z.record(z.string(), z.number().int().min(0)).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("perMegapixel"), microUsdPerMegapixel: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("perCharacter"), microUsdPerCharacter: z.number().int().min(0) }).strict(),
  z
    .object({
      kind: z.literal("perToken"),
      microUsdPerMillionInput: z.number().int().min(0),
      microUsdPerMillionOutput: z.number().int().min(0),
    })
    .strict(),
  /** Local runtimes: recorded at zero and labelled unmetered (R-18). */
  z.object({ kind: z.literal("unmetered") }).strict(),
]);
export type Pricing = z.infer<typeof PricingSchema>;

export const ModelAcceptsSchema = z
  .object({
    /** Maximum reference images; 0 means the model takes none, said before commit (R-10). */
    referenceImages: z.number().int().min(0),
    startFrame: z.boolean(),
    endFrame: z.boolean(),
  })
  .strict();
export type ModelAccepts = z.infer<typeof ModelAcceptsSchema>;

export const ModelLimitsSchema = z
  .object({
    maxDurationSec: z.number().int().min(1).optional(),
    resolutions: z.array(z.string()).optional(),
    aspects: z.array(z.string()).optional(),
    /** LLMs: the context window, for routing sanity rather than pricing. */
    maxContextTokens: z.number().int().min(1).optional(),
  })
  .strict();
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

export const ManifestModelSchema = z
  .object({
    id: z.string().min(1),
    provider: ProviderIdSchema,
    capability: CapabilitySchema,
    displayName: z.string().min(1),
    accepts: ModelAcceptsSchema,
    limits: ModelLimitsSchema,
    pricing: PricingSchema,
    /** Local-runtime requirements, measured against the machine (R-22). */
    requires: z
      .object({
        vramMb: z.number().int().min(0).optional(),
        memMb: z.number().int().min(0).optional(),
        diskMb: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ManifestModel = z.infer<typeof ManifestModelSchema>;

export const ModelManifestSchema = z
  .object({
    manifestVersion: z.number().int().min(1),
    generated: IsoDateSchema,
    models: z.array(ManifestModelSchema),
  })
  .strict();
export type ModelManifest = z.infer<typeof ModelManifestSchema>;

// ---------------------------------------------------------------------------
// Estimation (R-15): manifest in, micro-dollars out, no provider round-trip
// ---------------------------------------------------------------------------

/** What a dispatch knows before it happens, per pricing shape. */
export interface EstimateInput {
  /** Video: seconds of output. */
  durationSec?: number;
  /** Video/image: requested resolution, for byResolution overrides. */
  resolution?: string;
  /** Images: how many. Defaults to 1. */
  images?: number;
  /** Upscales: output megapixels. */
  megapixels?: number;
  /** TTS: characters of input text. */
  characters?: number;
  /** LLM: token estimate both ways. */
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Pre-dispatch estimate from the manifest alone (R-15). Integer arithmetic end to end; any
 * fractional intermediate (megapixels, token millionths) rounds once, up, at its own edge —
 * an estimate that errs low teaches the user not to trust it.
 */
export function estimateMicroUsd(model: ManifestModel, input: EstimateInput): number {
  const p = model.pricing;
  // Fractional quantities (seconds, megapixels) become integer milli-units before they meet a
  // rate, so the arithmetic is integer end to end and the single ceil is exact (R-14, D3).
  const milli = (value: number): number => Math.round(value * 1000);
  switch (p.kind) {
    case "perSecond": {
      const rate = (input.resolution !== undefined ? p.byResolution?.[input.resolution] : undefined) ?? p.microUsdPerSecond;
      return Math.ceil((milli(input.durationSec ?? 0) * rate) / 1000);
    }
    case "perImage": {
      const rate = (input.resolution !== undefined ? p.byResolution?.[input.resolution] : undefined) ?? p.microUsdPerImage;
      return (input.images ?? 1) * rate;
    }
    case "perMegapixel":
      return Math.ceil((milli(input.megapixels ?? 0) * p.microUsdPerMegapixel) / 1000);
    case "perCharacter":
      return (input.characters ?? 0) * p.microUsdPerCharacter;
    case "perToken": {
      const inCost = Math.ceil(((input.tokensIn ?? 0) * p.microUsdPerMillionInput) / 1_000_000);
      const outCost = Math.ceil(((input.tokensOut ?? 0) * p.microUsdPerMillionOutput) / 1_000_000);
      return inCost + outCost;
    }
    case "unmetered":
      return 0;
  }
}

/** The one-line capability copy the picker shows, truthfully, from the manifest (R-10). */
export function modelCapabilityCopy(model: ManifestModel): string {
  const parts: string[] = [];
  if (model.accepts.referenceImages > 0) parts.push(`refs ×${model.accepts.referenceImages}`);
  else parts.push("no refs");
  if (model.accepts.startFrame && model.accepts.endFrame) parts.push("frames");
  else if (model.accepts.startFrame) parts.push("start frame");
  if (model.limits.maxDurationSec !== undefined) parts.push(`${model.limits.maxDurationSec}s`);
  return parts.join(" · ");
}

/**
 * Whole-scene pass packing (§2.5): how many dispatches a duration needs under the model's cap.
 */
export function passesForDuration(model: ManifestModel, durationSec: number): number {
  const cap = model.limits.maxDurationSec;
  if (cap === undefined || durationSec <= 0) return durationSec > 0 ? 1 : 0;
  return Math.ceil(durationSec / cap);
}
