import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { UPSCALE_RATE_RUNS, UpscaleRateSampleSchema } from "./upscale.js";

/**
 * Sampling for a local recipe (design turn 177): how many steps the sampler takes, how hard the
 * speed adapter (the distillation LoRA a turbo recipe ships) pulls, the sigma shift, and which
 * sampler and scheduler run. Drawn after H3 adapter testing on 2026-09-30 showed the shipped
 * values (8 steps, adapter 1, shift 12) and the publisher-style ones (12, 0.5, 6) each suit
 * different cards and tastes, so the choice moves to the person.
 *
 * Four rules shape everything below:
 *
 * - It is a **device setting per recipe**, never a world or production field: what a card can
 *   afford and what someone likes about its output belong to the machine and the person.
 * - The presets are **catalogue data**, declared by the recipe that owns the graph and projected
 *   onto its manifest row. A client holding the numbers would be a second place to get them wrong.
 * - A job **freezes** the effective values into its params and recipe identity next to its seed,
 *   so a retry, a recovery or a re-run after the setting changed still sends what was recorded.
 * - The time beside a preset is **measured on this machine**, never authored.
 */

/** The bounds Custom may reach, whatever a recipe declares. One place, read by every check. */
export const SAMPLING_BOUNDS = {
  steps: { min: 4, max: 30 },
  speedAdapter: { min: 0, max: 1, step: 0.05 },
  shift: { min: 1, max: 15 },
} as const;

/** The one clause an out-of-range field shows (design 177b): its range, and nothing else. */
export const SAMPLING_RANGE_COPY = {
  steps: "4 to 30",
  speedAdapter: "0 to 1 in 0.05",
  shift: "1 to 15",
} as const;

/** A multiple of 0.05, tolerating the float noise `0.1 + 0.05` carries. */
function onSpeedGrid(value: number): boolean {
  const scaled = value / SAMPLING_BOUNDS.speedAdapter.step;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** An engine's sampler or scheduler name: ComfyUI's own snake-case identifiers. */
const SamplerNameSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const SamplingValuesSchema = z
  .object({
    steps: z.number().int().min(SAMPLING_BOUNDS.steps.min).max(SAMPLING_BOUNDS.steps.max),
    speedAdapter: z
      .number()
      .min(SAMPLING_BOUNDS.speedAdapter.min)
      .max(SAMPLING_BOUNDS.speedAdapter.max)
      .refine(onSpeedGrid, "the speed adapter moves in steps of 0.05"),
    shift: z.number().finite().min(SAMPLING_BOUNDS.shift.min).max(SAMPLING_BOUNDS.shift.max),
    sampler: SamplerNameSchema,
    scheduler: SamplerNameSchema,
  })
  .strict();
export type SamplingValues = z.infer<typeof SamplingValuesSchema>;

export const SamplingPresetIdSchema = z.enum(["fast", "balanced", "quality"]);
export type SamplingPresetId = z.infer<typeof SamplingPresetIdSchema>;

export const SamplingChoiceIdSchema = z.enum(["fast", "balanced", "quality", "custom"]);
export type SamplingChoiceId = z.infer<typeof SamplingChoiceIdSchema>;

export const SAMPLING_CHOICE_NAMES: Record<SamplingChoiceId, string> = {
  fast: "Fast",
  balanced: "Balanced",
  quality: "Quality",
  custom: "Custom",
};

/**
 * A recipe's sampling catalogue, as its manifest row carries it. `fast` comes first and is the
 * recipe's shipped values exactly — the providers tests hold the graph to that — so "Reset to
 * Fast" and a setting nobody touched both send the graph as it has always been sent.
 *
 * `clipSec` is the length the measured times are stated for: ten seconds where the recipe offers
 * it (design 177a), otherwise the longest length the recipe does offer, because a time for a
 * clip the row cannot make answers nothing.
 */
export const ModelSamplingSchema = z
  .object({
    presets: z
      .array(z.object({ id: SamplingPresetIdSchema, values: SamplingValuesSchema }).strict())
      .length(3)
      .refine(
        (presets) => presets[0]?.id === "fast" && new Set(presets.map((preset) => preset.id)).size === 3,
        "fast, then the other two presets once each",
      ),
    /** The sampler allow-list; Custom offers these, narrowed to what the engine advertises. */
    samplers: z.array(SamplerNameSchema).min(1),
    schedulers: z.array(SamplerNameSchema).min(1),
    clipSec: z.number().int().min(1),
  })
  .strict();
export type ModelSampling = z.infer<typeof ModelSamplingSchema>;

/**
 * The device setting for one recipe. A preset stores its name only — its values stay the
 * catalogue's, so a shipped correction to Balanced reaches everyone who chose Balanced. Custom
 * stores its values. Fast is never stored: it is the absence of a setting.
 */
export const SamplingSettingSchema = z
  .object({
    preset: SamplingChoiceIdSchema,
    values: SamplingValuesSchema.optional(),
  })
  .strict()
  .refine(
    (setting) => (setting.preset === "custom") === (setting.values !== undefined),
    "custom carries its values; a preset carries none",
  );
export type SamplingSetting = z.infer<typeof SamplingSettingSchema>;

/** What a job froze: the choice by name and the values it resolved to at that moment. */
export const JobSamplingSchema = SamplingValuesSchema.extend({ preset: SamplingChoiceIdSchema }).strict();
export type JobSampling = z.infer<typeof JobSamplingSchema>;

/**
 * One completed run's measurement, stated for the recipe's `clipSec`: seconds per sampler step,
 * and the fixed remainder (loading, encoding, decoding, muxing) that does not grow with steps.
 */
export const SamplingTimingSampleSchema = z
  .object({ secPerStep: z.number().positive(), fixedSec: z.number().min(0), at: IsoDateTimeSchema })
  .strict();
export type SamplingTimingSample = z.infer<typeof SamplingTimingSampleSchema>;

/** How many runs the estimate averages: enough to smooth one odd run, few enough to follow a new card. */
export const SAMPLING_TIMING_RUNS = 5;

export const LocalSamplingSettingsSchema = z
  .object({
    choices: z.record(z.string().min(1), SamplingSettingSchema).default({}),
    timings: z
      .record(z.string().min(1), z.array(SamplingTimingSampleSchema).max(SAMPLING_TIMING_RUNS))
      .default({}),
    /**
     * An upscaler's measured rate per recipe (design turn 178): seconds of run per second of
     * output, the last few completed runs. Beside the sampling timings because it is the same
     * kind of fact — this machine's own measurement, kept with the engine's device settings.
     */
    rates: z.record(z.string().min(1), z.array(UpscaleRateSampleSchema).max(UPSCALE_RATE_RUNS)).optional(),
  })
  .strict();
export type LocalSamplingSettings = z.infer<typeof LocalSamplingSettingsSchema>;

/** What the engine's `/object_info` says its KSampler accepts, when it has been asked. */
export const EngineSamplerOptionsSchema = z
  .object({ samplers: z.array(z.string().min(1)), schedulers: z.array(z.string().min(1)) })
  .strict();
export type EngineSamplerOptions = z.infer<typeof EngineSamplerOptionsSchema>;

/**
 * The allow-list narrowed to what this engine runs. The whole list when the engine has not said,
 * or names none of it — an answer that rules out every sampler the recipe was built on says more
 * about the reading than about the engine.
 */
export function samplingOptions(
  catalogue: ModelSampling,
  engine: EngineSamplerOptions | null | undefined,
): { samplers: string[]; schedulers: string[] } {
  const narrow = (allowed: readonly string[], advertised: readonly string[] | undefined): string[] => {
    if (advertised === undefined) return [...allowed];
    const both = allowed.filter((name) => advertised.includes(name));
    return both.length > 0 ? both : [...allowed];
  };
  return {
    samplers: narrow(catalogue.samplers, engine?.samplers),
    schedulers: narrow(catalogue.schedulers, engine?.schedulers),
  };
}

export type SamplingField = keyof SamplingValues;

/** The fields of a Custom draft that cannot be saved, in form order. Empty means Save may go. */
export function samplingProblems(
  values: { steps: number; speedAdapter: number; shift: number; sampler: string; scheduler: string },
  catalogue: ModelSampling,
  engine?: EngineSamplerOptions | null,
): SamplingField[] {
  const options = samplingOptions(catalogue, engine);
  const problems: SamplingField[] = [];
  const { steps, speedAdapter, shift } = SAMPLING_BOUNDS;
  if (!Number.isInteger(values.steps) || values.steps < steps.min || values.steps > steps.max) problems.push("steps");
  if (
    !Number.isFinite(values.speedAdapter) ||
    values.speedAdapter < speedAdapter.min ||
    values.speedAdapter > speedAdapter.max ||
    !onSpeedGrid(values.speedAdapter)
  ) {
    problems.push("speedAdapter");
  }
  if (!Number.isFinite(values.shift) || values.shift < shift.min || values.shift > shift.max) problems.push("shift");
  if (!options.samplers.includes(values.sampler)) problems.push("sampler");
  if (!options.schedulers.includes(values.scheduler)) problems.push("scheduler");
  return problems;
}

/** A preset's values from the catalogue; Fast's for anything the catalogue does not hold. */
export function presetValues(catalogue: ModelSampling, id: SamplingPresetId): SamplingValues {
  return (catalogue.presets.find((preset) => preset.id === id) ?? catalogue.presets[0]!).values;
}

/**
 * What a new job of this recipe sends. A stored Custom that no longer fits the catalogue — an
 * allow-list that dropped its sampler, say — falls back to Fast rather than dispatching values
 * nothing vouches for.
 */
export function effectiveSampling(catalogue: ModelSampling, setting: SamplingSetting | undefined): JobSampling {
  if (
    setting?.preset === "custom" &&
    setting.values !== undefined &&
    samplingProblems(setting.values, catalogue).length === 0
  ) {
    return { preset: "custom", ...setting.values };
  }
  const id: SamplingPresetId = setting === undefined || setting.preset === "custom" ? "fast" : setting.preset;
  const found = catalogue.presets.find((preset) => preset.id === id) ?? catalogue.presets[0]!;
  return { preset: found.id, ...found.values };
}

function figure(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * `12 steps · speed 0.5 · shift 6` — the mono line under a preset and on a take. The sampler and
 * scheduler are named only where they differ from `fast`, because under every shipped preset
 * they are the recipe's own and saying so on each line would be noise.
 */
export function samplingSummary(values: SamplingValues, fast?: SamplingValues): string {
  const parts = [`${values.steps} steps`, `speed ${figure(values.speedAdapter)}`, `shift ${figure(values.shift)}`];
  if (fast !== undefined && values.sampler !== fast.sampler) parts.push(values.sampler);
  if (fast !== undefined && values.scheduler !== fast.scheduler) parts.push(values.scheduler);
  return parts.join(" · ");
}

/**
 * Seconds for one clip of the catalogue's `clipSec` at `steps`, from this machine's recorded runs:
 * the mean seconds per step times the steps, plus the mean fixed time. Null until a run has
 * completed — the dialog then shows a dash rather than a figure nobody measured.
 */
export function samplingEstimateSec(
  samples: readonly SamplingTimingSample[] | undefined,
  steps: number,
): number | null {
  if (samples === undefined || samples.length === 0) return null;
  const mean = (pick: (sample: SamplingTimingSample) => number): number =>
    samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;
  return mean((sample) => sample.secPerStep) * steps + mean((sample) => sample.fixedSec);
}

/** `~8 min`, `~40 s`, or `—` when nothing has been measured. */
export function samplingEstimateCopy(seconds: number | null): string {
  if (seconds === null) return "—";
  return seconds >= 90 ? `~${Math.round(seconds / 60)} min` : `~${Math.max(1, Math.round(seconds))} s`;
}
