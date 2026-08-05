import { z } from "zod";
import { IsoDateSchema } from "./ids.js";
import { formatMicroUsd } from "./money.js";
import { CapabilitySchema, ProviderIdSchema, type Capability } from "./provider.js";
import type { RoutingDefaults } from "./settings.js";

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
      /** Conservative allowance for billed reference-image input tokens. */
      microUsdPerReferenceImage: z.number().int().min(0).optional(),
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
  /**
   * Images billed in tokens, not in images (fal's route to GPT Image 2). The rates are exact and
   * published; the token counts are not knowable before dispatch, because they depend on the
   * prompt and on how the provider tokenises the reference images. So the row carries the counts
   * the estimate assumes, chosen high, and the estimate is a stated ceiling rather than a guess
   * at the middle: the contract is that a figure is shown and accepted before money is spent, and
   * a figure that can come in under is honest where one that can come in over is not.
   *
   * Cached-input rates are published too and deliberately unused — assuming a cache hit would
   * lower an estimate on a discount that may not apply.
   */
  z
    .object({
      kind: z.literal("perImageToken"),
      microUsdPerMillionTextInput: z.number().int().min(0),
      microUsdPerMillionImageInput: z.number().int().min(0),
      microUsdPerMillionImageOutput: z.number().int().min(0),
      assumedTextInputTokens: z.number().int().min(0),
      assumedImageInputTokensPerReference: z.number().int().min(0),
      assumedImageOutputTokensPerImage: z.number().int().min(0),
      /** The provider rounds the total up to this; the estimate rounds the same way (fal: $0.0001). */
      roundUpToMicroUsd: z.number().int().min(1).optional(),
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
    /** True only when the provider has separate style and identity image inputs. */
    referenceRoles: z.boolean().optional(),
    startFrame: z.boolean(),
    endFrame: z.boolean(),
  })
  .strict();
export type ModelAccepts = z.infer<typeof ModelAcceptsSchema>;

/**
 * One vocabulary for image output size, across providers that each have their own. fal says
 * 1K/2K/4K, Higgsfield says 1080p, flux counts megapixels and OpenAI counts pixels — a picker
 * cannot be built on that directly, and a tier a model cannot reach has to be offerable-but-
 * disabled rather than absent, so the reason is visible. Video keeps its own words: 720p and
 * 1080p are what that surface means, and normalising them would only obscure it.
 */
export const SizeTierSchema = z.enum(["1K", "2K", "4K"]);
export type SizeTier = z.infer<typeof SizeTierSchema>;

export const ModelLimitsSchema = z
  .object({
    maxDurationSec: z.number().int().min(1).optional(),
    resolutions: z.array(z.string()).optional(),
    /**
     * Normalised tier → the provider's own word for it. The tier is what a user chooses; the
     * value is what goes over the wire. A model omitting a tier cannot reach it.
     */
    tiers: z.record(SizeTierSchema, z.string().min(1)).optional(),
    aspects: z.array(z.string()).optional(),
    /** LLMs: the context window, for routing sanity rather than pricing. */
    maxContextTokens: z.number().int().min(1).optional(),
  })
  .strict();
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

/** The tiers a model can actually reach, in ascending order, for a picker to render. */
export function tiersFor(model: { limits: ModelLimits }): SizeTier[] {
  const declared = model.limits.tiers;
  if (!declared) return [];
  return (["1K", "2K", "4K"] as const).filter((tier) => declared[tier] !== undefined);
}

/** The provider's own word for a tier, or undefined when the model cannot reach it. */
export function nativeResolution(model: { limits: ModelLimits }, tier: SizeTier): string | undefined {
  return model.limits.tiers?.[tier];
}

export const ManifestModelSchema = z
  .object({
    id: z.string().min(1),
    provider: ProviderIdSchema,
    capability: CapabilitySchema,
    displayName: z.string().min(1),
    accepts: ModelAcceptsSchema,
    limits: ModelLimitsSchema,
    pricing: PricingSchema,
    /**
     * Enabled from a provider's catalogue rather than shipped with a verified description. The
     * price is real — nothing unpriced can be enabled — but what it accepts was never checked,
     * so it runs at the floor: no references, no frames, the provider's default size. Marked
     * wherever it appears, because understating a capability costs a dropped reference while
     * overstating one costs a dispatch that dies after the estimate was accepted.
     */
    unverified: z.boolean().optional(),
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

/** Select a routed model, validating its capability before falling back to the manifest order. */
export function modelForCapability(
  manifest: ModelManifest,
  routing: RoutingDefaults | null | undefined,
  capability: Capability,
): ManifestModel | null {
  const routed = routing?.[capability];
  if (routed !== undefined) {
    const model = manifest.models.find((candidate) => candidate.id === routed && candidate.capability === capability);
    if (model) return model;
  }
  return manifest.models.find((candidate) => candidate.capability === capability) ?? null;
}

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
  /** Reference images billed as model input. Defaults to 0. */
  referenceImages?: number;
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
      return (input.images ?? 1) * rate + (input.referenceImages ?? 0) * (p.microUsdPerReferenceImage ?? 0);
    }
    case "perMegapixel":
      return Math.ceil((milli(input.megapixels ?? 0) * (input.images ?? 1) * p.microUsdPerMegapixel) / 1000);
    case "perCharacter":
      return (input.characters ?? 0) * p.microUsdPerCharacter;
    case "perToken": {
      const inCost = Math.ceil(((input.tokensIn ?? 0) * p.microUsdPerMillionInput) / 1_000_000);
      const outCost = Math.ceil(((input.tokensOut ?? 0) * p.microUsdPerMillionOutput) / 1_000_000);
      return inCost + outCost;
    }
    case "perImageToken": {
      // The ceiling, not the middle. Every term uses the row's assumed token counts, so the same
      // inputs always produce the same figure and the only way this estimate moves is by someone
      // changing the assumption — which manifest drift will tell them to do (§2.5).
      const images = input.images ?? 1;
      const perImage =
        p.assumedImageOutputTokensPerImage * p.microUsdPerMillionImageOutput +
        p.assumedTextInputTokens * p.microUsdPerMillionTextInput;
      const perReference = p.assumedImageInputTokensPerReference * p.microUsdPerMillionImageInput;
      const total = Math.ceil((images * perImage + (input.referenceImages ?? 0) * perReference) / 1_000_000);
      const step = p.roundUpToMicroUsd;
      return step === undefined ? total : Math.ceil(total / step) * step;
    }
    case "unmetered":
      return 0;
  }
}

export type CharacterImageWorkflow = "main-photo" | "character-sheet" | "character-look" | "reference-tile";

export interface ImageOutputSpec {
  width: number;
  height: number;
  aspect: string;
  /** The model's selected resolution label, when its API exposes one. */
  resolution?: string;
}

/**
 * Explicit output intent shared by character UI, estimation, durable jobs, and providers.
 *
 * The tier is the user's choice, translated here into the provider's own word for it. Absent —
 * or unreachable for this model — it falls back to the model's first declared resolution, which
 * is what every caller got before the size control existed. An unverified model declares no
 * tiers at all, so it carries no resolution and the provider uses its own default: guessing one
 * would be stating a capability nobody checked.
 */
export function characterImageOutput(
  model: ManifestModel,
  workflow: CharacterImageWorkflow,
  tier?: SizeTier,
): ImageOutputSpec {
  return imageOutput(model, workflow === "character-sheet", tier);
}

/**
 * A still frame from a scene: landscape, and sized by the same tier vocabulary. Scene dispatch
 * needs this because the image clients size a request from `output.width`/`height` and ignore a
 * bare resolution string — a tier that never became dimensions moved the control and nothing
 * else.
 */
export function sceneImageOutput(model: ManifestModel, tier?: SizeTier): ImageOutputSpec {
  return imageOutput(model, true, tier);
}

function imageOutput(model: ManifestModel, landscape: boolean, tier?: SizeTier): ImageOutputSpec {
  const dimensions =
    model.provider === "openai"
      ? landscape
        ? { width: 1536, height: 1024 }
        : { width: 1024, height: 1536 }
      : model.provider === "fal" && model.pricing.kind === "perImage"
        ? landscape
          ? { width: 1536, height: 864 }
          : { width: 1024, height: 1820 }
      : model.provider === "higgsfield"
        ? landscape
          ? { width: 1920, height: 1080 }
          : { width: 1024, height: 1024 }
      : landscape
        ? { width: 1536, height: 1024 }
        : { width: 1024, height: 1280 };
  const aspect =
    model.provider === "openai"
      ? landscape
        ? "3:2"
        : "2:3"
      : model.provider === "fal" && model.pricing.kind === "perImage"
        ? landscape
          ? "16:9"
          : "9:16"
        : model.provider === "higgsfield"
          ? landscape
            ? "16:9"
            : "1:1"
          : landscape
            ? "3:2"
            : "4:5";
  const resolution =
    (tier !== undefined ? nativeResolution(model, tier) : undefined) ?? model.limits.resolutions?.[0];
  // The tier has to reach the dimensions too, not just the label. Several clients submit
  // width/height and ignore `resolution` entirely — OpenAI, and every fal route that is not a
  // nano-banana — so a tier that only set the label left those requests at the old size while
  // the picker said 4K. Per-megapixel estimates read these dimensions as well, so the figure
  // would have been wrong in the same direction.
  const scaled = tier !== undefined ? scaleToTier(dimensions, tier, resolution) : dimensions;
  return { ...scaled, aspect, ...(resolution ? { resolution } : {}) };
}

/** Long edge per tier, the aspect kept. 1K is the size these defaults were already written at. */
const TIER_LONG_EDGE: Record<SizeTier, number> = { "1K": 1536, "2K": 2048, "4K": 4096 };

/**
 * The tier as dimensions. Which axis to scale depends on what the model means by the tier: fal's
 * flux rows call 4K "4MP", and a 4096px long edge at 3:2 is about 13MP — three times the size
 * asked for, on a model billed by the megapixel. When the model's own word for the tier is a
 * megapixel count, the area is the target; otherwise the long edge is.
 */
function scaleToTier(
  dimensions: { width: number; height: number },
  tier: SizeTier,
  nativeWord?: string,
): { width: number; height: number } {
  // Even numbers: encoders and several providers reject odd dimensions, and rounding here is
  // cheaper than discovering it at submission.
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const megapixels = /^([0-9]+(?:\.[0-9]+)?)\s*MP$/i.exec(nativeWord ?? "");
  if (megapixels) {
    const target = Number.parseFloat(megapixels[1]!) * 1_000_000;
    const factor = Math.sqrt(target / (dimensions.width * dimensions.height));
    return { width: even(dimensions.width * factor), height: even(dimensions.height * factor) };
  }
  const longest = Math.max(dimensions.width, dimensions.height);
  const target = TIER_LONG_EDGE[tier];
  if (longest === target) return dimensions;
  const factor = target / longest;
  return { width: even(dimensions.width * factor), height: even(dimensions.height * factor) };
}

export function estimateCharacterImageMicroUsd(
  model: ManifestModel,
  workflow: CharacterImageWorkflow,
  images = 1,
  referenceImages = 0,
  tier?: SizeTier,
): number {
  const output = characterImageOutput(model, workflow, tier);
  return estimateMicroUsd(model, {
    images,
    referenceImages,
    megapixels: (output.width * output.height) / 1_000_000,
    resolution: output.resolution,
  });
}

/** Paid work must never silently enter the queue with an unusable zero estimate. */
export function characterImageEstimateIsUsable(model: ManifestModel, estimate: number): boolean {
  if (!Number.isInteger(estimate) || estimate < 0) return false;
  const pricing = model.pricing;
  if (pricing.kind === "unmetered") return estimate === 0;
  const hasPositiveRate =
    pricing.kind === "perSecond"
      ? pricing.microUsdPerSecond > 0 || Object.values(pricing.byResolution ?? {}).some((rate) => rate > 0)
      : pricing.kind === "perImage"
        ? pricing.microUsdPerImage > 0 ||
          (pricing.microUsdPerReferenceImage ?? 0) > 0 ||
          Object.values(pricing.byResolution ?? {}).some((rate) => rate > 0)
        : pricing.kind === "perMegapixel"
          ? pricing.microUsdPerMegapixel > 0
          : pricing.kind === "perCharacter"
            ? pricing.microUsdPerCharacter > 0
            : pricing.kind === "perImageToken"
              ? pricing.microUsdPerMillionImageOutput > 0
              : pricing.microUsdPerMillionInput > 0 || pricing.microUsdPerMillionOutput > 0;
  return !hasPositiveRate || estimate > 0;
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
 * What a model costs, in one line, in the unit the provider actually bills in. The unit is the
 * point: "$0.30" beside a video model and "$0.30" beside an image model would look like the same
 * money, and one of them is per second. A model listed with no readable price cannot be enabled
 * at all, so there is no unpriced case here beyond the local runtimes, which say so.
 */
export function modelPriceCopy(model: ManifestModel): string {
  const pricing = model.pricing;
  switch (pricing.kind) {
    case "unmetered":
      return "on this machine · unmetered";
    case "perSecond":
      return `${formatMicroUsd(pricing.microUsdPerSecond)} / second`;
    case "perImage":
      return formatMicroUsd(pricing.microUsdPerImage);
    case "perMegapixel":
      return `${formatMicroUsd(pricing.microUsdPerMegapixel)} / megapixel`;
    case "perCharacter":
      return `${formatMicroUsd(pricing.microUsdPerCharacter)} / character`;
    case "perToken":
      return `${formatMicroUsd(pricing.microUsdPerMillionInput)} / ${formatMicroUsd(
        pricing.microUsdPerMillionOutput,
      )} per M tokens`;
    case "perImageToken":
      // Billed in tokens, so there is no true per-image price — the figure shown is the ceiling
      // the estimator uses, said as such rather than as a price the provider quotes.
      return `${formatMicroUsd(estimateMicroUsd(model, { images: 1 }))} per image at most`;
  }
}

/**
 * Whole-scene pass packing (§2.5): how many dispatches a duration needs under the model's cap.
 */
export function passesForDuration(model: ManifestModel, durationSec: number): number {
  const cap = model.limits.maxDurationSec;
  if (cap === undefined || durationSec <= 0) return durationSec > 0 ? 1 : 0;
  return Math.ceil(durationSec / cap);
}
