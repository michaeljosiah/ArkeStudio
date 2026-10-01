import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import type { ManifestModel } from "./manifest.js";

/**
 * Upscale a finished video take to 1080p (design turn 178; SPEC-021 R-31..R-35).
 *
 * On the reference RTX 3080, H3 makes 480p up to 15 s and 768p up to 7 s, and asking it for 1080p
 * directly ran past seventy minutes without finishing. A SeedVR2 pass over a finished take made a
 * 7 s 768p clip into 1920×1080 in 14.3 minutes, so 1080p is a second step on a take rather than a
 * generation size. Everything here is the arithmetic and the words both sides of that step share:
 * the screen that offers it and states the crop, and the coordinator that refuses what the screen
 * should never have offered.
 */

/** The one size (design 178): 1920×1080 for a landscape source, 1080×1920 for a portrait one. */
export const UPSCALE_SIZE = "1080p" as const;
export const UPSCALE_DIMENSIONS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
} as const;
export type UpscaleAspect = keyof typeof UPSCALE_DIMENSIONS;

export interface UpscalePlan {
  aspect: UpscaleAspect;
  from: { width: number; height: number };
  to: { width: number; height: number };
  /**
   * What the centre crop takes, as a whole percentage of the axis it takes it from, after the
   * source is scaled to cover the frame: `top and bottom` when the source is a little taller than
   * the frame, `each side` when it is a little wider. Zero is no crop at all.
   */
  crop: { edge: "top and bottom" | "each side" | null; percent: number };
}

/**
 * The plan for a source of this size, or null where Upscale is not offered: a square source has
 * no 16:9 or 9:16 frame to fill, and a source already at or above the size has nothing to gain.
 *
 * Scale to cover, then centre-crop — the same thing the recipe's `ImageScale` with `crop:
 * "center"` does — so the frame is always full and the crop is the only thing given up. Stated as
 * data before the press (design 178a): 1344×768 loses 2% top and bottom; 864×480 loses 1% at the
 * sides. The percentage is of the scaled axis, rounded, and never shown as 0% when anything at all
 * is cut.
 */
export function upscalePlan(source: { width: number; height: number }): UpscalePlan | null {
  const { width, height } = source;
  if (!(width > 0 && height > 0) || width === height) return null;
  const aspect: UpscaleAspect = width > height ? "16:9" : "9:16";
  const to = UPSCALE_DIMENSIONS[aspect];
  if (width >= to.width && height >= to.height) return null;
  const scale = Math.max(to.width / width, to.height / height);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const cutHeight = scaledHeight - to.height;
  const cutWidth = scaledWidth - to.width;
  const pct = (cut: number, of: number) => (cut <= 0.5 ? 0 : Math.max(1, Math.round((cut / of) * 100)));
  const crop: UpscalePlan["crop"] =
    cutHeight > 0.5
      ? { edge: "top and bottom", percent: pct(cutHeight, scaledHeight) }
      : cutWidth > 0.5
        ? { edge: "each side", percent: pct(cutWidth, scaledWidth) }
        : { edge: null, percent: 0 };
  return { aspect, from: { width, height }, to: { ...to }, crop };
}

/** `2% top and bottom`, `1% each side`, or `None`. */
export function upscaleCropCopy(crop: UpscalePlan["crop"]): string {
  return crop.edge === null ? "None" : `${crop.percent}% ${crop.edge}`;
}

/** `1344×768 → 1920×1080`. */
export function upscaleFrameCopy(plan: Pick<UpscalePlan, "from" | "to">): string {
  return `${plan.from.width}×${plan.from.height} → ${plan.to.width}×${plan.to.height}`;
}

/**
 * The one clause an engine below a recipe's floor is refused with (design 178d): `Needs ComfyUI
 * 0.38` for a floor of 0.38.0. The tile says it and the Upscale press is refused with it, so the
 * two cannot drift into two spellings of the same fact.
 */
export function engineFloorClause(minVersion: string): string {
  const [major = "0", minor = "0", patch] = minVersion.split(".");
  return `Needs ComfyUI ${major}.${minor}${patch !== undefined && patch !== "0" ? `.${patch}` : ""}`;
}

/** Whether a manifest row is an upscaler: offered on a take, never in a model picker. */
export function isUpscaler(model: Pick<ManifestModel, "upscale">): boolean {
  return model.upscale !== undefined;
}

// ---------------------------------------------------------------------------
// The measured rate (design 178c) — per second of output, on this machine
// ---------------------------------------------------------------------------

/** One completed upscale: seconds of wall time per second of video it made. */
export const UpscaleRateSampleSchema = z
  .object({ secPerOutputSec: z.number().positive(), at: IsoDateTimeSchema })
  .strict();
export type UpscaleRateSample = z.infer<typeof UpscaleRateSampleSchema>;

/** The same window the sampling estimate keeps: enough to smooth one odd run. */
export const UPSCALE_RATE_RUNS = 5;

/** Mean seconds per output second, or null until one upscale has completed here. */
export function upscaleRate(samples: readonly UpscaleRateSample[] | undefined): number | null {
  if (samples === undefined || samples.length === 0) return null;
  return samples.reduce((sum, sample) => sum + sample.secPerOutputSec, 0) / samples.length;
}

/** The tile's rate (178c): `~2 min / s`, or `—` until measured. */
export function upscaleRateCopy(samples: readonly UpscaleRateSample[] | undefined): string {
  const rate = upscaleRate(samples);
  if (rate === null) return "—";
  return rate >= 90 ? `~${Math.round(rate / 60)} min / s` : `~${Math.max(1, Math.round(rate))} s / s`;
}

/** The popover's time for one take (178a): `~14 min`, or `—` until measured. */
export function upscaleTimeCopy(samples: readonly UpscaleRateSample[] | undefined, outputSec: number): string {
  const rate = upscaleRate(samples);
  if (rate === null || !(outputSec > 0)) return "—";
  const seconds = rate * outputSec;
  return seconds >= 90 ? `~${Math.round(seconds / 60)} min` : `~${Math.max(1, Math.round(seconds))} s`;
}
