import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema } from "./ids.js";
import type { BenchVideoParams } from "./bench.js";
import {
  durationLimitsFor,
  estimateMicroUsd,
  frameDispatchFor,
  pricedDuration,
  type ManifestModel,
} from "./manifest.js";

/** A clip remains a separate choice beside its source still (turn 208, SPEC-047). */
export const AudiobookMotionSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    file: z.string().min(1).max(1000),
    seconds: z.number().positive().max(300),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceAt: IsoDateTimeSchema,
    behavior: z.enum(["repeat", "hold"]),
    active: z.boolean(),
  })
  .strict();
export type AudiobookMotion = z.infer<typeof AudiobookMotionSchema>;

/** A video's sound is never mixed into the audiobook; the selected route still prices its full output. */
export function audiobookMotionModel(model: ManifestModel): boolean {
  return (
    model.capability === "video" &&
    frameDispatchFor(model, 1) !== null &&
    audiobookMotionDurations(model).length > 0
  );
}

export function audiobookMotionDurations(model: ManifestModel): number[] {
  const route = frameDispatchFor(model, 1);
  if (route === null) return [];
  const limits = durationLimitsFor(model, route.mode);
  const offered = Object.keys(limits.durations ?? {})
    .map(Number)
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 15);
  return [
    ...new Set(limits.durations !== undefined ? offered : [Math.min(5, limits.maxDurationSec ?? 5)]),
  ].sort((a, b) => a - b);
}

export function audiobookMotionPrice(
  model: ManifestModel,
  params: BenchVideoParams,
): number {
  const route = frameDispatchFor(model, 1);
  if (route === null) throw new Error("this model cannot start from a picture");
  return estimateMicroUsd(model, {
    durationSec: pricedDuration(model, params.durationSec ?? 5, { taskMode: route.mode }),
    ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
  });
}

/** One visual clock for app, preview and export. The endpoint is held before the decoder's duration. */
export function audiobookMotionTime(seconds: number, elapsed: number, behavior: "repeat" | "hold"): number {
  if (!(seconds > 0)) return 0;
  const at = Math.max(0, elapsed);
  return behavior === "repeat" ? at % seconds : Math.min(at, Math.max(0, seconds - 1 / 120));
}
