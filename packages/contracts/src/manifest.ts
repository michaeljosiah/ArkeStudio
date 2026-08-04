import { z } from "zod";
import { IsoDateSchema } from "./ids.js";
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

/** Explicit output intent shared by character UI, estimation, durable jobs, and providers. */
export function characterImageOutput(model: ManifestModel, workflow: CharacterImageWorkflow): ImageOutputSpec {
  const landscape = workflow === "character-sheet";
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
  const resolution = model.limits.resolutions?.[0];
  return { ...dimensions, aspect, ...(resolution ? { resolution } : {}) };
}

export function estimateCharacterImageMicroUsd(
  model: ManifestModel,
  workflow: CharacterImageWorkflow,
  images = 1,
  referenceImages = 0,
): number {
  const output = characterImageOutput(model, workflow);
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
 * Whole-scene pass packing (§2.5): how many dispatches a duration needs under the model's cap.
 */
export function passesForDuration(model: ManifestModel, durationSec: number): number {
  const cap = model.limits.maxDurationSec;
  if (cap === undefined || durationSec <= 0) return durationSec > 0 ? 1 : 0;
  return Math.ceil(durationSec / cap);
}
