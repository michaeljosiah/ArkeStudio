import {
  estimateMicroUsd,
  lockedParameters,
  modeSpec,
  modeUnavailableReason,
  sentinelFor,
  supportsMode,
  type ManifestModel,
  type TaskMode,
} from "./manifest.js";

/**
 * Task modes whose output parameters are dictated by their input (SPEC-019 §2.9, §2.10,
 * R-32..R-39, D25..D28).
 *
 * Dispatch composition used to branch on capability and otherwise send what the user chose. That
 * holds while every task is *generate*. It stops holding the moment a task takes an existing
 * asset as its subject rather than its reference: editing derives aspect ratio and duration from
 * the input, extension derives aspect ratio, and a planner that sends a chosen value for either
 * is composing a request the route must override — and pricing a length nobody picked.
 */

export interface SizeParams {
  resolution?: string;
  aspect?: string;
}

/**
 * The size and length fields a dispatch in this mode may actually send (R-33).
 *
 * A locked parameter is dropped, and replaced by the route's sentinel only where the manifest
 * says the route wants one. That distinction is load-bearing: the vendor API spells a locked
 * ratio `adaptive` and this aggregator spells it `auto`, while a third route may simply want the
 * field absent — which is why the spelling is manifest data and the absence is the default.
 */
export function sizeParamsFor(
  model: ManifestModel,
  mode: TaskMode,
  chosen: SizeParams,
): Record<string, string> {
  const locked = new Set(lockedParameters(model, mode));
  const out: Record<string, string> = {};
  for (const [parameter, value] of [
    ["resolution", chosen.resolution],
    ["aspect", chosen.aspect],
  ] as const) {
    if (!locked.has(parameter)) {
      if (value !== undefined) out[parameter] = value;
      continue;
    }
    const sentinel = sentinelFor(model, mode, parameter);
    if (sentinel !== null) out[parameter] = sentinel;
  }
  return out;
}

/** The route a mode dispatches to, or null to use the model's default endpoint (T-1). */
export function routeFor(model: ManifestModel, mode: TaskMode): string | null {
  return modeSpec(model, mode)?.route ?? null;
}

export interface ModeAvailability {
  mode: TaskMode;
  available: boolean;
  /** Why not, in words — never merely absent from the surface (R-34, D26). */
  reason: string | null;
}

/**
 * Every mode, with its availability and a reason for each refusal (R-34).
 *
 * Offered-and-disabled rather than omitted: a user who cannot find *Continue* concludes the
 * product cannot do it, where one who sees "this model has no continue route" has learned
 * something about the model.
 */
export function modeAvailability(model: ManifestModel, modes: readonly TaskMode[]): ModeAvailability[] {
  return modes.map((mode) => ({
    mode,
    available: supportsMode(model, mode),
    reason: modeUnavailableReason(model, mode),
  }));
}

// ---------------------------------------------------------------------------
// Estimating a length the user did not choose (R-37..R-39, D28)
// ---------------------------------------------------------------------------

export type LockedDurationEstimate =
  | { ok: true; durationSec: number; estimatedMicroUsd: number; statement: string }
  | { ok: false; reason: string };

/**
 * Price a dispatch whose duration comes from its input rather than from a picker (R-37).
 *
 * Two rules, and both are the same principle SPEC-008 already settled when it chose to assume no
 * cache discount and to state assumed token counts high. The length is *measured*, never guessed
 * — an unmeasurable input refuses the mode outright (R-39), because a dispatch priced on a guess
 * is worse than a dispatch not offered. And where the route states a tolerance, the estimate
 * takes the top of it: a figure that can come in under is honest where one that can come in over
 * is not.
 */
export function lockedDurationEstimate(input: {
  model: ManifestModel;
  mode: TaskMode;
  /** Measured locally from the input asset; null when it could not be read. */
  measuredSec: number | null;
  resolution?: string;
}): LockedDurationEstimate {
  const { model, mode } = input;
  if (!supportsMode(model, mode)) {
    return { ok: false, reason: modeUnavailableReason(model, mode) ?? `${model.displayName} has no ${mode} route` };
  }
  if (!lockedParameters(model, mode).includes("duration")) {
    return { ok: false, reason: `${mode} does not lock duration on ${model.displayName}` };
  }
  if (input.measuredSec === null) {
    return {
      ok: false,
      reason: "that input's duration could not be read on this machine, so the job cannot be priced",
    };
  }
  const tolerance = modeSpec(model, mode)?.durationToleranceSec ?? 0;
  const durationSec = input.measuredSec + tolerance;
  const estimatedMicroUsd = estimateMicroUsd(model, {
    durationSec,
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
  });
  return {
    ok: true,
    durationSec,
    estimatedMicroUsd,
    statement:
      tolerance > 0
        ? `priced at ${durationSec.toFixed(1)}s — the input's ${input.measuredSec.toFixed(1)}s plus the ${tolerance}s this route may add`
        : `priced at ${durationSec.toFixed(1)}s, measured from the input`,
  };
}
