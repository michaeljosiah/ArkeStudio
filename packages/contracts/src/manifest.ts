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
    /**
     * Seconds → the provider's own word for that length. Video routes do not take a number of
     * seconds: they take a string from a fixed list, and the lists disagree — seedance and kling
     * say "5", veo says "5s", and none of them accepts 6.5. A model with no entry here has no
     * length we can ask for, so the provider's default runs and the estimate must say so.
     */
    durations: z.record(z.string().regex(/^[0-9]+$/), z.string().min(1)).optional(),
    /**
     * How the route spells that length on the wire. Every route shipped before this took a
     * string ("5", "8s"); the minimax, ltx and wan families declare `duration` as an integer
     * or a number enum, and a quoted "6" is not a member of [6, 8, 10]. Absent means string,
     * which is what every earlier row meant implicitly.
     */
    durationWire: z.enum(["string", "number"]).optional(),
    /**
     * The route takes "auto" as a length: it chooses, and no number is sent. Offered as its own
     * choice rather than a value, the way the provider offers it.
     */
    durationAuto: z.boolean().optional(),
    /**
     * The route lets the caller choose whether sound is generated (`generate_audio`). Absent
     * means no choice exists — which is NOT the same as no sound: wan and minimax produce audio
     * and simply publish no switch for it, and offering one would be a control that lies.
     */
    soundChoice: z.boolean().optional(),
    /**
     * What the reference route calls its image array. Seedance says `image_urls`; minimax and
     * wan say `reference_image_urls`. Data for the same reason `framesField` is.
     */
    referencesField: z.string().min(1).optional(),
    resolutions: z.array(z.string()).optional(),
    /**
     * Normalised tier → the provider's own word for it. The tier is what a user chooses; the
     * value is what goes over the wire. A model omitting a tier cannot reach it.
     */
    tiers: z.record(SizeTierSchema, z.string().min(1)).optional(),
    aspects: z.array(z.string()).optional(),
    /** LLMs: the context window, for routing sanity rather than pricing. */
    maxContextTokens: z.number().int().min(1).optional(),
    /**
     * Video: how many storyboard panels this family reads reliably (SPEC-019 R-23).
     *
     * A property of the model that *consumes* the board, not of the image model that draws it —
     * past the cap the documented failure is a still output or panels rendered out of order. A
     * row without one states no cap, and the plan draws every shot.
     */
    storyboardPanels: z.number().int().min(1).optional(),
    /**
     * How many distinct subjects this model holds apart reliably (SPEC-019 R-42). A *range*, not
     * a cap: past it stability drops, and the budget warns rather than truncating — dropping a
     * character the user wrote into the shot is a worse failure than a shakier take they retry.
     */
    reliableSubjects: z.number().int().min(1).optional(),
    /** Aggregate seconds of video reference this model accepts across all clips (R-40, R-41). */
    maxReferenceVideoSec: z.number().min(0).optional(),
    /** Aggregate seconds of audio reference this model accepts across all clips (R-40, R-41). */
    maxReferenceAudioSec: z.number().min(0).optional(),
    /**
     * The longest output the *reference* route will make, where it is shorter than the text
     * route's (probed 2026-08-16).
     *
     * A row's `durations` are transcribed from the route it dispatches to by default, but a job
     * carrying references lands on a different route — and those two routes do not always agree.
     * Wan 2.7 makes 15 seconds from text and 10 from references. Without this, the composer
     * offers 12s, the estimate prices 12s, the user accepts, and the route rejects a length it
     * never advertised. Absent means the two routes agree.
     */
    maxReferenceDurationSec: z.number().min(0).optional(),
    /**
     * Characters of prompt this model accepts, where the provider publishes one (design 68).
     *
     * Characters, not tokens: the composer counts what somebody typed as they type it, and a
     * token count cannot be computed on this side of the wire for a model whose tokenizer we do
     * not ship. A row **without** one states no cap, and the composer shows **no counter** there
     * rather than an invented ceiling — a counter is a promise about a refusal, and one measured
     * against a house number would refuse briefs the model would have taken. Where it is stated,
     * over the cap refuses *before* dispatch: nothing is truncated on the way out, because a brief
     * silently cut at the end loses the shot list rather than the adjectives.
     */
    maxPromptChars: z.number().int().min(1).optional(),
    /** Delivery directions this concrete speech model has a measured wire mapping for. */
    deliveries: z.array(z.enum(["measured", "whispered", "breaking", "cold", "warm", "urgent"])).optional(),
    /** Generated speech container, consumed consistently by cache, verification, media, and events. */
    audioFormat: z.enum(["wav", "mp3", "flac"]).optional(),
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

// ---------------------------------------------------------------------------
// Task modes and their locked parameters (SPEC-019 R-32..R-36, D25, D26)
// ---------------------------------------------------------------------------

export const TaskModeSchema = z.enum([
  "generate",
  "edit",
  "continue",
  "first-frame",
  "first-and-last-frame",
  "keyframe-sequence",
]);
export type TaskMode = z.infer<typeof TaskModeSchema>;

/** Output parameters a mode can take out of the user's hands by deriving them from its input. */
export const LockedParameterSchema = z.enum(["aspect", "duration", "resolution"]);
export type LockedParameter = z.infer<typeof LockedParameterSchema>;

/**
 * What one mode costs a model in control.
 *
 * `route` is the point of the whole shape: T-1 established that on this aggregator a task mode is
 * a *route*, not a field — text-to-video, image-to-video and reference-to-video are siblings, and
 * which one a request lands on decides what it does. The catalogue already models that for the
 * `/edit` sibling.
 *
 * `sentinels` is the second lesson. The vendor API spells a locked duration `-1` and a locked
 * ratio `adaptive`; the aggregator spells both `"auto"`. Two surfaces onto one model already
 * disagree, so the spelling is data rather than a constant somebody has to find.
 */
export const TaskModeSpecSchema = z
  .object({
    /** The provider route this mode dispatches to, when it is not the model's default. */
    route: z.string().min(1).optional(),
    /** Parameters this mode derives from its input; a dispatch must not send a chosen value. */
    locked: z.array(LockedParameterSchema).default([]),
    /** What to send in a locked parameter's place, where the route requires something. */
    sentinels: z.record(LockedParameterSchema, z.string().min(1)).optional(),
    /**
     * How far the output duration may exceed the input's, in seconds. Priced at the top (R-38):
     * a figure that can come in under is honest where one that can come in over is not.
     */
    durationToleranceSec: z.number().min(0).optional(),
    /**
     * The route's own ceiling on frame images, curated from its schema the way durations are.
     * Meaningful on keyframe-sequence, whose count is otherwise unbounded; first-frame and
     * first-and-last-frame carry their counts in their names. Absent means the ceiling was
     * never read, and a dispatch must refuse rather than probe a paid route with a guess.
     */
    maxFrames: z.number().int().min(1).optional(),
    /**
     * What this route calls the array of frames. Seedance says `image_urls`; the minimax and
     * wan reference routes say `reference_image_urls`. Data rather than a constant for the
     * same reason sentinels are: two routes of one family already disagree.
     */
    framesField: z.string().min(1).optional(),
  })
  .strict();
export type TaskModeSpec = z.infer<typeof TaskModeSpecSchema>;

/** The aspect ratios a model accepts as a continuous range, rather than an enumeration (R-36). */
export const AspectRangeSchema = z
  .object({ min: z.number().positive(), max: z.number().positive() })
  .strict();
export type AspectRange = z.infer<typeof AspectRangeSchema>;

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
     * The model family this row belongs to, e.g. "seedance" (SPEC-019 R-16). Models in one
     * family answer the same prompting conventions, so it is the family — not the row — that a
     * skill is written for and selected by. Optional: a row with no family gets no skill and
     * drafts under general guidance, which R-20 requires be a stated fallback rather than a
     * failure. Deliberately not derived from the id, because ids are route names and two routes
     * of one family disagree about them ("seedance-2.0", "seedance-2.0-fast").
     */
    family: z.string().min(1).optional(),
    /**
     * The task modes this model supports, and what each one locks (R-32). A model with no entry
     * supports `generate` only — which is what every row said implicitly before this existed.
     */
    modes: z.record(TaskModeSchema, TaskModeSpecSchema).optional(),
    /** A continuous aspect range, where the model accepts one instead of a fixed list (R-36). */
    aspectRange: AspectRangeSchema.optional(),
    /**
     * Enabled from a provider's catalogue rather than shipped with a verified description. The
     * price is real — nothing unpriced can be enabled — but what it accepts was never checked,
     * so it runs at the floor: no references, no frames, the provider's default size. Marked
     * wherever it appears, because understating a capability costs a dropped reference while
     * overstating one costs a dispatch that dies after the estimate was accepted.
     */
    unverified: z.boolean().optional(),
    /**
     * What this model needs of the machine it runs on. Two kinds of requirement, and they
     * produce different verdicts (SPEC-033 R-18, R-19).
     *
     * `vramMb` and `memMb` are **measured** floors: a machine that misses one is `insufficient`,
     * and a bigger machine would work.
     *
     * `platform` and `accelerator` are **declared**: a machine outside the list is `unsupported`,
     * whatever its figures, and no amount of memory changes the answer. They are lists because a
     * model routinely runs on more than one — `["cuda", "rocm"]` is a real row, and folding it
     * into one string would have made the second one unrepresentable.
     *
     * `diskMb` is the install size, and deliberately **not** a fit input: SPEC-033 R-17 moved it
     * to the install-closure guard, because it is the one floor the model itself moves.
     */
    requires: z
      .object({
        vramMb: z.number().int().min(1).optional(),
        memMb: z.number().int().min(1).optional(),
        diskMb: z.number().int().min(1).optional(),
        /** `process.platform` spellings: `win32`, `darwin`, `linux`. */
        platform: z.array(z.string().min(1)).min(1).optional(),
        /** Accelerator names as the probe reports them: `cuda`, `rocm`, `metal`. */
        accelerator: z.array(z.string().min(1)).min(1).optional(),
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
    /**
     * capability → local model ids, best first (SPEC-033 R-33). Authored, and expressing
     * **quality alone**: it makes no claim about any machine, because the gate already answers
     * that and an authored per-machine flag goes stale the moment the hardware moves.
     *
     * Local models only, by construction rather than by a filter applied late. A cloud model
     * declares no requirements, so its fit would be vacuously `runs-well` and a shared order
     * would recommend it on Local AI — the one screen R-2 forbids it from appearing on.
     *
     * Optional: a manifest that authors no order recommends nothing, which is the honest
     * reading and keeps a fixture from having to carry an empty one.
     */
    localPreference: z.record(CapabilitySchema, z.array(z.string().min(1))).optional(),
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

export type CharacterImageWorkflow =
  | "main-photo"
  | "character-sheet"
  | "character-look"
  | "reference-tile"
  /** A place, not a person (#243) — and so landscape, like the panels it will be stacked into. */
  | "location-view";

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
  aspect?: string,
): ImageOutputSpec {
  return imageOutputFor(model, {
    landscape: isLandscapeWorkflow(workflow),
    ...(tier !== undefined ? { tier } : {}),
    ...(aspect !== undefined ? { aspect } : {}),
  });
}

/**
 * The shapes offered in a picker, in the order they are offered.
 *
 * Deliberately a short, opinionated list rather than every ratio arithmetic allows: this is a
 * control somebody reads at a glance, and a model declaring a continuous range would otherwise
 * produce an unbounded one.
 */
export const STANDARD_ASPECTS = ["1:1", "4:5", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"] as const;

/** "16:9" as 1.777…, or null for anything that is not two positive numbers around a colon. */
export function parseAspect(aspect: string): number | null {
  const parts = /^\s*([0-9]+(?:\.[0-9]+)?)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(aspect);
  if (!parts) return null;
  const width = Number.parseFloat(parts[1]!);
  const height = Number.parseFloat(parts[2]!);
  return width > 0 && height > 0 ? width / height : null;
}

/**
 * The one spelling an aspect is stored and compared in (issue 389): the two numbers around a
 * colon, no whitespace. Everything that writes an aspect normalizes through here, so " 9 : 16 "
 * and "9:16" cannot become two different productions' shapes. Null is a refusal — the caller
 * names the input rather than storing something no route will ever match.
 */
export function normalizeAspect(aspect: string): string | null {
  const parts = /^\s*([0-9]+(?:\.[0-9]+)?)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(aspect);
  if (!parts) return null;
  const width = Number.parseFloat(parts[1]!);
  const height = Number.parseFloat(parts[2]!);
  return width > 0 && height > 0 ? `${parts[1]!}:${parts[2]!}` : null;
}

/** Which way round the work wants to be, for the workflows whose shape is not the author's. */
export function isLandscapeWorkflow(workflow: CharacterImageWorkflow): boolean {
  return workflow === "character-sheet" || workflow === "location-view";
}

/**
 * The shape a request takes when nobody chose one: the provider's own habit, by orientation.
 *
 * Extracted so there is one of these rather than two. It used to be inline in the output builder,
 * and the picker took its default from the *curated* list's first entry instead — so the same
 * model produced 3:2 everywhere except a screen with a shape control, where it produced 16:9,
 * and nano-banana defaulted to a 21:9 cinemascope crop because 21:9 happened to be listed first.
 */
export function derivedAspect(model: ManifestModel, landscape: boolean): string {
  return model.provider === "openai"
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
}

/** The shapes a row advertises, as curated — before the default is folded in. */
function curatedAspects(model: ManifestModel): readonly string[] {
  if (model.unverified === true) return [];
  const enumerated = model.limits.aspects;
  if (enumerated !== undefined && enumerated.length > 0) return enumerated;
  const range = model.aspectRange;
  if (!range) return [];
  return STANDARD_ASPECTS.filter((aspect) => {
    const ratio = parseAspect(aspect);
    return ratio !== null && ratio >= range.min && ratio <= range.max;
  });
}

/**
 * The shapes to offer for this model, in the order to offer them — and an empty list where it has
 * no opinion, which is the signal to draw no control rather than a control over a guess.
 *
 * `limits.aspects` is a *curated offer list*, not a statement of what the route will accept: the
 * fal catalogue's own comment says so, and nano-banana's entry deliberately leaves out ratios the
 * route does have. So a derived default outside that list is not an invalid request — flux takes
 * a 3:2 `image_size` perfectly well — it is simply a shape we had not thought to offer.
 *
 * Which is why the default is folded in rather than corrected away. Given an orientation, the
 * shape that orientation would otherwise have produced comes **first**, so opening a dialog and
 * changing nothing generates exactly what the surface generated before it had a picker. Without
 * one, the curated list stands alone — there is no orientation to have a default for.
 *
 * Snapping the ladder into the curated list instead would have been worse than the inconsistency:
 * flux's nearest offered shape to a 4:5 portrait is 1:1, so every character main photo would have
 * become a square, and an identity anchor cropped to a square is a worse photograph than an
 * unlisted ratio is a bookkeeping error.
 */
export function offeredAspects(
  model: ManifestModel,
  options: { landscape?: boolean } = {},
): readonly string[] {
  const curated = curatedAspects(model);
  if (curated.length === 0 || options.landscape === undefined) return curated;
  const fallback = derivedAspect(model, options.landscape);
  return [fallback, ...curated.filter((aspect) => aspect !== fallback)];
}

/**
 * Whether this model would take that shape.
 *
 * The union of both orientations' defaults and the curated list, because the output builder
 * validates through here and must never reject a shape it would itself have produced.
 */
export function aspectOffered(model: ManifestModel, aspect: string): boolean {
  if (curatedAspects(model).includes(aspect)) return true;
  return aspect === derivedAspect(model, true) || aspect === derivedAspect(model, false);
}

/**
 * A row that curates nothing and declares no range has no opinion about shape (issue 389): the
 * routes behind it take real dimensions, and treating silence as refusal would unshape a
 * production's stills on exactly the models that could honour them. An unverified row is not
 * opinion-less — it has not earned a guess.
 */
function aspectOpinionless(model: ManifestModel): boolean {
  const enumerated = model.limits.aspects;
  return (
    (enumerated === undefined || enumerated.length === 0) &&
    model.aspectRange === undefined &&
    model.unverified !== true
  );
}

/**
 * Whether this model's selected route can deliver that shape, and what it offers instead
 * (issue 389). Three vocabularies, kept apart: a curated `limits.aspects` list is the offer, a
 * continuous `aspectRange` is a capability, and a row declaring neither has no opinion — which
 * is a pass, not a refusal, because refusing on silence would block routes that take anything.
 * The verdict is computed before enqueue so an impossible shape is a named refusal, never a
 * provider failure after the estimate was accepted.
 */
export function aspectSupport(
  model: ManifestModel,
  aspect: string,
): { ok: true } | { ok: false; supported: readonly string[] } {
  const canonical = normalizeAspect(aspect);
  const enumerated = model.limits.aspects;
  const offers = enumerated !== undefined && enumerated.length > 0 ? enumerated : STANDARD_ASPECTS;
  if (canonical === null) return { ok: false, supported: offers };
  if (enumerated !== undefined && enumerated.length > 0) {
    return enumerated.includes(canonical) ? { ok: true } : { ok: false, supported: enumerated };
  }
  const range = model.aspectRange;
  if (range) {
    const ratio = parseAspect(canonical)!;
    return ratio >= range.min && ratio <= range.max
      ? { ok: true }
      : { ok: false, supported: STANDARD_ASPECTS.filter((a) => aspectAllowed(model, parseAspect(a)!)) };
  }
  // An unverified row's silence is not an opinion — it has not earned a guess (the same rule
  // aspectOpinionless applies to stills). Passing here would put a shape on a route nobody
  // checked, fal would silently ignore the field, and the user would pay for default-shape
  // footage a reviewed 9:16 plan never mentioned.
  if (model.unverified === true) return { ok: false, supported: [] };
  return { ok: true };
}

/**
 * A still frame from a scene, shaped by the production's delivery aspect (issue 389) — and by
 * the old landscape habit where no aspect was ever chosen, which is the documented default for
 * every production created before aspect existed. Scene dispatch needs this because the image
 * clients size a request from `output.width`/`height` and ignore a bare resolution string — a
 * tier that never became dimensions moved the control and nothing else.
 */
export function sceneImageOutput(model: ManifestModel, tier?: SizeTier, aspect?: string): ImageOutputSpec {
  const ratio = aspect !== undefined ? parseAspect(aspect) : null;
  return imageOutputFor(model, {
    landscape: ratio === null ? true : ratio >= 1,
    ...(tier !== undefined ? { tier } : {}),
    ...(aspect !== undefined ? { aspect } : {}),
  });
}

/**
 * An output spec for any image request, with the shape either chosen or derived.
 *
 * Derived is what every caller had before there was a picker: the provider's own habit, portrait
 * or landscape. A chosen aspect replaces that and is reshaped from the same base long edge, so
 * changing the shape does not quietly change the size as well — the tier still decides that.
 *
 * A requested shape the model does not offer is ignored rather than obeyed. The manifest is the
 * first line of defence and the picker never offers one; this is the backstop, and honouring an
 * unreachable ratio here would send a request the provider refuses after the estimate was
 * accepted.
 */
export function imageOutputFor(
  model: ManifestModel,
  options: { landscape?: boolean; tier?: SizeTier; aspect?: string } = {},
): ImageOutputSpec {
  const landscape = options.landscape ?? false;
  const tier = options.tier;
  // Offered, or asked of a row with no opinion to refuse with (issue 389) — either way the
  // shape is one the request can carry, because these routes size from real dimensions.
  const chosen =
    options.aspect !== undefined &&
    (aspectOffered(model, options.aspect) ||
      (aspectOpinionless(model) && parseAspect(options.aspect) !== null))
      ? options.aspect
      : undefined;
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
  const aspect = chosen ?? derivedAspect(model, landscape);
  // Reshaped around the long edge the provider's own default already established, so a shape
  // change is a shape change and nothing else. The tier below is still what decides the size.
  const shaped = reshape(dimensions, chosen);
  const resolution =
    (tier !== undefined ? nativeResolution(model, tier) : undefined) ?? model.limits.resolutions?.[0];
  // The tier has to reach the dimensions too, not just the label. Several clients submit
  // width/height and ignore `resolution` entirely — OpenAI, and every fal route that is not a
  // nano-banana — so a tier that only set the label left those requests at the old size while
  // the picker said 4K. Per-megapixel estimates read these dimensions as well, so the figure
  // would have been wrong in the same direction.
  const scaled = tier !== undefined ? scaleToTier(shaped, tier, resolution) : shaped;
  return { ...snapToAcceptedSize(model.provider, scaled), aspect, ...(resolution ? { resolution } : {}) };
}

/** The same long edge, at a different ratio. Absent ratio means the dimensions already agree. */
function reshape(
  dimensions: { width: number; height: number },
  aspect: string | undefined,
): { width: number; height: number } {
  const ratio = aspect === undefined ? null : parseAspect(aspect);
  if (ratio === null) return dimensions;
  // Even numbers, for the same reason scaleToTier rounds to them: several providers reject odd
  // dimensions, and finding that out at submission costs a whole round trip.
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const longEdge = Math.max(dimensions.width, dimensions.height);
  return ratio >= 1
    ? { width: even(longEdge), height: even(longEdge / ratio) }
    : { width: even(longEdge * ratio), height: even(longEdge) };
}

/** Long edge per tier, the aspect kept. 1K is the size these defaults were already written at. */
const TIER_LONG_EDGE: Record<SizeTier, number> = { "1K": 1536, "2K": 2048, "4K": 4096 };

/**
 * OpenAI's image routes take `size` from a fixed list, not a width and a height (#223). These
 * three are the list.
 */
const OPENAI_IMAGE_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
] as const;

/**
 * The last stop before dimensions become a request. Long-edge scaling is right for a route that
 * takes real numbers — fal, higgsfield — and wrong for one whose size is an enum: a 2K tier
 * scaled 1024x1536 to 1366x2048, which OpenAI rejected at validation with HTTP 400 in 1.3s,
 * every time, before any rendering started.
 *
 * The manifest is the first line of defence — a model declares only the tiers it reaches, so the
 * picker never offers this one. This is the backstop, so no future row can put an unsendable
 * size on the wire. Shape decides first: a portrait request must come back portrait, because a
 * cropped subject is a worse answer than a smaller one. Area only breaks the tie.
 */
function snapToAcceptedSize(
  provider: ManifestModel["provider"],
  dimensions: { width: number; height: number },
): { width: number; height: number } {
  if (provider !== "openai") return dimensions;
  const aspect = dimensions.width / dimensions.height;
  const area = dimensions.width * dimensions.height;
  const shapeOf = (size: { width: number; height: number }) => Math.abs(size.width / size.height - aspect);
  const best = [...OPENAI_IMAGE_SIZES].sort((a, b) => {
    const shape = shapeOf(a) - shapeOf(b);
    if (Math.abs(shape) > 0.01) return shape;
    return Math.abs(a.width * a.height - area) - Math.abs(b.width * b.height - area);
  })[0]!;
  return { width: best.width, height: best.height };
}

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

/**
 * What an image request will cost, priced off the spec it will actually carry.
 *
 * Orientation is explicit rather than inferred from a workflow, because a surface can borrow a
 * workflow for its price band and still be making something the other way round — the master look
 * is a landscape plate priced as ordinary image work — and the base long edge differs by
 * orientation, so inferring it put the figure a whole tier away from the request on long-edge rows.
 */
export function estimateImageMicroUsd(
  model: ManifestModel,
  options: {
    images?: number;
    referenceImages?: number;
    tier?: SizeTier;
    // The shape as well as the size, because a per-megapixel row is billed by area: 16:9 and 1:1
    // at one tier are different amounts of money on a long-edge row, and a figure that ignored
    // the picker beside it would be wrong in whichever direction the author had just chosen.
    aspect?: string;
    landscape?: boolean;
  } = {},
): number {
  const output = imageOutputFor(model, {
    landscape: options.landscape ?? false,
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
  });
  return estimateMicroUsd(model, {
    images: options.images ?? 1,
    referenceImages: options.referenceImages ?? 0,
    megapixels: (output.width * output.height) / 1_000_000,
    ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
  });
}

export function estimateCharacterImageMicroUsd(
  model: ManifestModel,
  workflow: CharacterImageWorkflow,
  images = 1,
  referenceImages = 0,
  tier?: SizeTier,
  aspect?: string,
): number {
  return estimateImageMicroUsd(model, {
    images,
    referenceImages,
    landscape: isLandscapeWorkflow(workflow),
    ...(tier !== undefined ? { tier } : {}),
    ...(aspect !== undefined ? { aspect } : {}),
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
  // Frames read from the same authority the dispatch uses (issue 154): a task-mode route that
  // takes them, or the legacy accepts flags where a row still claims them without one. The old
  // flags-only read printed nothing for every fal video row that genuinely dispatches a first
  // frame through its image-to-video sibling.
  if (frameDispatchFor(model, 2) !== null || (model.accepts.startFrame && model.accepts.endFrame)) {
    parts.push("frames");
  } else if (frameDispatchFor(model, 1) !== null || model.accepts.startFrame) {
    parts.push("start frame");
  }
  if (model.limits.maxDurationSec !== undefined) parts.push(`${model.limits.maxDurationSec}s`);
  return parts.join(" · ");
}

/**
 * The lengths this model can actually be asked for, in seconds, ascending.
 *
 * `withReferences` picks the route the job will really land on. The reference route is a
 * different endpoint with its own ceiling, and offering a length only the text route makes is
 * how a user comes to accept an estimate for footage that cannot be produced. Filtering rather
 * than substituting is deliberate: a reference route that ever offers a length the text route
 * does not would be under-promised here, which costs a choice, where over-promising costs money.
 */
export function durationOptions(model: ManifestModel, opts?: { withReferences?: boolean }): number[] {
  const ceiling = opts?.withReferences === true ? model.limits.maxReferenceDurationSec : undefined;
  return Object.keys(model.limits.durations ?? {})
    .map((seconds) => Number.parseInt(seconds, 10))
    .filter((seconds) => ceiling === undefined || seconds <= ceiling)
    .sort((a, b) => a - b);
}

/**
 * What a dispatch can ask for, in seconds and in the route's own word — or why it cannot.
 *
 * Three outcomes, kept apart because they need different answers. A length the route offers is
 * rounded **up** to: the footage covers the shot rather than ending early, and the estimate,
 * computed from this same number, can only overstate. A model that declares no lengths runs at
 * the provider's default, which is worth saying rather than pretending a number was honoured.
 * And a shot longer than anything the route offers is refused: clamping a 22s shot to a 15s
 * clip would spend real money on footage that cannot cover what was asked for.
 */
export type DurationChoice =
  | { kind: "asked"; seconds: number; wire: string | number }
  | { kind: "provider-default" }
  | { kind: "over-cap"; longest: number; becauseReferences: boolean };

export function dispatchDuration(
  model: ManifestModel,
  requestedSec: number,
  opts?: { withReferences?: boolean },
): DurationChoice {
  const options = durationOptions(model, opts);
  if (options.length === 0) return { kind: "provider-default" };
  const longest = options[options.length - 1]!;
  if (requestedSec > longest) {
    // Whether the references are what shortened it, so the refusal can say so: "runs at most
    // 10s" reads as a fact about the model, where "at most 10s with references" tells the user
    // there is a shot to be had by removing one.
    const unrestricted = durationOptions(model);
    const becauseReferences = longest < (unrestricted[unrestricted.length - 1] ?? longest);
    return { kind: "over-cap", longest, becauseReferences };
  }
  const chosen = options.find((seconds) => seconds >= requestedSec)!;
  const wire = model.limits.durations![String(chosen)]!;
  // In the route's own type. The lengths are stored as strings because they are keys, but a
  // route declaring `duration` as a number enum rejects the quoted form — and it rejects it
  // AFTER accepting the submission, so the job is queued, billed and then 422s on its result.
  return { kind: "asked", seconds: chosen, wire: model.limits.durationWire === "number" ? Number(wire) : wire };
}

/** The seconds a dispatch will run for, for pricing — the request itself when we cannot ask. */
export function pricedDuration(model: ManifestModel, requestedSec: number, opts?: { withReferences?: boolean }): number {
  const choice = dispatchDuration(model, requestedSec, opts);
  return choice.kind === "asked" ? choice.seconds : requestedSec;
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
      // Locality belongs to the selected runtime. A ComfyUI URL may be another machine.
      return "unmetered";
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


// ---------------------------------------------------------------------------
// Mode queries (SPEC-019 R-32..R-35)
// ---------------------------------------------------------------------------

const GENERATE_ONLY: TaskModeSpec = { locked: [] };

/** What this model does in a mode, or null when it does not support it at all. */
export function modeSpec(model: ManifestModel, mode: TaskMode): TaskModeSpec | null {
  if (model.modes === undefined) return mode === "generate" ? GENERATE_ONLY : null;
  return model.modes[mode] ?? null;
}

export function supportsMode(model: ManifestModel, mode: TaskMode): boolean {
  return modeSpec(model, mode) !== null;
}

/** Parameters a dispatch in this mode must NOT send a chosen value for (R-33). */
export function lockedParameters(model: ManifestModel, mode: TaskMode): LockedParameter[] {
  return modeSpec(model, mode)?.locked ?? [];
}

export function locksParameter(model: ManifestModel, mode: TaskMode, parameter: LockedParameter): boolean {
  return lockedParameters(model, mode).includes(parameter);
}

/** What goes over the wire in a locked parameter's place, when the route wants something. */
export function sentinelFor(
  model: ManifestModel,
  mode: TaskMode,
  parameter: LockedParameter,
): string | null {
  return modeSpec(model, mode)?.sentinels?.[parameter] ?? null;
}

/**
 * Why a mode is unavailable, in words, or null when it is available (R-34, D26).
 *
 * SPEC-008's rule for size tiers, on a new axis: an absent mode reads as a missing product
 * capability, a disabled one with a reason teaches something about the model.
 */
export function modeUnavailableReason(model: ManifestModel, mode: TaskMode): string | null {
  if (supportsMode(model, mode)) return null;
  return `${model.displayName} has no ${mode.replace(/-/g, " ")} route`;
}

/** Whether an aspect ratio is reachable on this model, by range or by enumeration. */
export function aspectAllowed(model: ManifestModel, ratio: number): boolean {
  const range = model.aspectRange;
  if (range) return ratio >= range.min && ratio <= range.max;
  return model.limits.aspects === undefined || model.limits.aspects.length === 0;
}

// ---------------------------------------------------------------------------
// Boundary-frame capability (issue 154): one query, one answer, every consumer
// ---------------------------------------------------------------------------

/**
 * Everything a frame-carrying dispatch needs to know, decided in one place.
 *
 * The catalogue speaks two vocabularies about frames. `accepts.startFrame`/`endFrame` are the
 * legacy per-row booleans — false on every shipped fal video row, pinned false by test, because
 * the row's default route has no image input at all. Task modes are where frame capability
 * really lives: `first-frame` and `first-and-last-frame` name the image-to-video sibling route
 * and what it locks. Planning, the picker, the estimate and the dispatch all consult THIS
 * projection rather than reading either vocabulary directly, so they cannot disagree about
 * whether a frame travels or where it lands.
 */
export interface FrameDispatch {
  mode: Extract<TaskMode, "first-frame" | "first-and-last-frame">;
  /** The provider route, or null when the mode runs on the model's default endpoint. */
  route: string | null;
  /** The route's own field names — what the transport actually writes (SPEC-019 T-1). */
  fields: { start: string; end: string | null };
  locked: LockedParameter[];
}

/**
 * How this model takes `frames` boundary images, or null when it cannot.
 *
 * Null is a refusal the caller must honour before submit: composing a frame dispatch for a
 * model this returns null for is asking a text route to read an image field it does not have.
 */
export function frameDispatchFor(model: ManifestModel, frames: 1 | 2): FrameDispatch | null {
  const mode = frames === 1 ? ("first-frame" as const) : ("first-and-last-frame" as const);
  const spec = modeSpec(model, mode);
  if (spec === null) return null;
  return {
    mode,
    route: spec.route ?? null,
    fields: { start: "image_url", end: frames === 2 ? "end_image_url" : null },
    locked: spec.locked,
  };
}

// ---------------------------------------------------------------------------
// Continuation capability (SPEC-019 R-50, T-31): the same projection, for footage
// ---------------------------------------------------------------------------

/**
 * Everything a continuation dispatch needs to know, decided in one place.
 *
 * The mirror of `FrameDispatch`, and it exists for the same reason: planning, the estimate, the
 * dialog and the transport must not each read `modes.continue` and reach their own conclusion
 * about whether footage can be extended or where it lands.
 */
export interface ContinueDispatch {
  /** The provider route, or null when the mode runs on the model's default endpoint. */
  route: string | null;
  /** The route's own field name for the footage being extended. */
  field: "video_url";
  locked: LockedParameter[];
}

/**
 * How this model extends existing footage, or null when it cannot.
 *
 * Null is a refusal the caller must honour before submit, exactly as `frameDispatchFor`'s is:
 * composing a continuation for a model this refuses is asking a text route to read a video field
 * it never declared.
 *
 * `field` is a constant where `framesField` is manifest data, and the difference is evidence
 * rather than taste. The frames array needed data because the first two routes read disagreed —
 * seedance says `image_urls`, wan says `reference_image_urls`. Four extend routes from four
 * vendors were read here — veo 3.1, PixVerse v6, LTX 2.3 and Flux 3 — and all four require a
 * field named `video_url`. There is no disagreement for data to record, and inventing a manifest
 * key for one is a curation burden on every future row that buys nothing.
 */
export function continueDispatchFor(model: ManifestModel): ContinueDispatch | null {
  const spec = modeSpec(model, "continue");
  if (spec === null) return null;
  return { route: spec.route ?? null, field: "video_url", locked: spec.locked };
}
