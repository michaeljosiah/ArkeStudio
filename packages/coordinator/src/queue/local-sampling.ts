import {
  JobSamplingSchema,
  effectiveSampling,
  type Job,
  type JobSampling,
  type SamplingSetting,
  type SamplingTimingSample,
  type UpscaleRateSample,
} from "@arke-studio/contracts";
import { VIDEO_DERIVATIONS, comfyUiRecipeById } from "@arke-studio/providers";
import type { EnqueueInput } from "./dispatcher.js";

/**
 * Freeze a local recipe's sampling into the job before it is journalled (design turn 177), in
 * the same place and for the same reason as the seed beside it: a retry, a recovery or a re-run
 * repeats what was recorded, and the job states what it rendered. Only a comfyui recipe that
 * declares sampling, and only when the caller sent none — a re-run's own sampling stands.
 */
export function withLocalSampling(
  input: EnqueueInput,
  settingFor: (recipeId: string) => SamplingSetting | undefined,
): EnqueueInput {
  if (input.provider !== "comfyui" || input.params.sampling !== undefined) return input;
  const catalogue = comfyUiRecipeById(input.model)?.sampling;
  if (catalogue === undefined) return input;
  return { ...input, params: { ...input.params, sampling: effectiveSampling(catalogue, settingFor(input.model)) } };
}

/**
 * A bench take's seed and sampling, frozen at reservation so the take records what it sends.
 * A re-run keeps the take's own sampling — Fast for a take from before sampling existed, since
 * that is what it was sent with — and always draws a fresh seed ("Run it again").
 */
export function localTakeFreeze(
  modelId: string,
  rerunOf: { sampling?: JobSampling } | undefined,
  settingFor: (recipeId: string) => SamplingSetting | undefined,
  seed: () => number,
): { seed?: number; sampling?: JobSampling } {
  const recipe = comfyUiRecipeById(modelId);
  if (recipe === null) return {};
  const catalogue = recipe.sampling;
  const sampling = catalogue === undefined
    ? undefined
    : rerunOf !== undefined
      ? rerunOf.sampling ?? effectiveSampling(catalogue, undefined)
      : effectiveSampling(catalogue, settingFor(modelId));
  return {
    ...(recipe.params["seed"] !== undefined ? { seed: seed() } : {}),
    ...(sampling !== undefined ? { sampling } : {}),
  };
}

/** A job's frozen sampling, when it carries one that parses. */
export function jobSampling(params: Record<string, unknown>): JobSampling | undefined {
  const parsed = JobSamplingSchema.safeParse(params["sampling"]);
  return parsed.success ? parsed.data : undefined;
}

interface Watch {
  runningAt: number;
  steps: number;
  /** When each step count was first seen: the first sighting is when that step finished. */
  firstSeen: Map<number, number>;
}

/**
 * The measured time beside a preset (design turn 177): seconds per sampler step, and the fixed
 * remainder, from this machine's own completed runs.
 *
 * Read off the step counts the engine already reports while a job runs (SPEC-021 D16), because
 * one run's total cannot say how much of it grows with steps and how much is loading and
 * decoding. The first time each count is seen is when that step finished, so the gap between the
 * first and last counts seen, over the steps between them, is the time a step takes — whatever
 * the poll interval, give or take one poll at each end. Everything else in the run is fixed.
 *
 * Both figures are then stated for the recipe's reference clip: the per-step time scaled by the
 * frame count, the fixed time as measured. That is a simplification — attention grows faster
 * than the frames and decoding grows with them — and it is the reason the dialog says `~`.
 *
 * Memory only: a run the coordinator did not watch from start to finish records nothing.
 */
export class SamplingClock {
  private readonly watching = new Map<string, Watch>();

  constructor(
    private readonly record: (recipeId: string, sample: SamplingTimingSample) => void,
    private readonly now: () => number = Date.now,
  ) {}

  observe(job: Job): void {
    if (job.provider !== "comfyui") return;
    const sampling = jobSampling(job.params);
    if (sampling === undefined) return;
    const at = this.now();
    let watch = this.watching.get(job.id);
    // Watched from its first running sighting only while nothing has counted yet: a job met
    // mid-run (after a restart) would otherwise report its remainder as the whole.
    if (job.status === "running" && watch === undefined && (job.step == null || job.step.done === 0)) {
      watch = { runningAt: at, steps: sampling.steps, firstSeen: new Map() };
      this.watching.set(job.id, watch);
    }
    if (watch === undefined) return;
    if (job.status === "running") {
      // Only the sampler's own count: another node reporting progress counts something else.
      if (job.step && job.step.total === watch.steps && job.step.done > 0 && !watch.firstSeen.has(job.step.done)) {
        watch.firstSeen.set(job.step.done, at);
      }
      return;
    }
    this.watching.delete(job.id);
    if (job.status !== "succeeded") return;
    const sample = measure(watch, at, clipScale(job));
    if (sample !== null) this.record(job.model, { ...sample, at: new Date(at).toISOString() });
  }
}

function measure(watch: Watch, endedAt: number, scale: number | null): Omit<SamplingTimingSample, "at"> | null {
  if (scale === null) return null;
  const counts = [...watch.firstSeen.keys()].sort((a, b) => a - b);
  if (counts.length < 2) return null;
  const low = counts[0]!;
  const high = counts[counts.length - 1]!;
  const secPerStep = (watch.firstSeen.get(high)! - watch.firstSeen.get(low)!) / 1000 / (high - low);
  if (!(secPerStep > 0)) return null;
  const totalSec = (endedAt - watch.runningAt) / 1000;
  const fixedSec = Math.max(0, totalSec - secPerStep * watch.steps);
  return { secPerStep: secPerStep * scale, fixedSec };
}

/**
 * Frames in the recipe's reference clip over frames in this run's clip, or null when either is
 * unknown — a run whose length cannot be read is not scaled on a guess.
 */
function clipScale(job: Job): number | null {
  const recipe = comfyUiRecipeById(job.model);
  const derivation = VIDEO_DERIVATIONS[job.model];
  if (recipe?.sampling === undefined) return null;
  if (derivation === undefined) return 1;
  const raw = job.params["durationSec"] ?? job.params["duration"];
  const seconds = raw === undefined ? 5 : Number(raw);
  const ran = derivation.framesBySeconds[String(seconds)];
  const reference = derivation.framesBySeconds[String(recipe.sampling.clipSec)];
  return ran === undefined || reference === undefined ? null : reference / ran;
}

/**
 * The measured rate beside Upscale (design turn 178): seconds of run per second of video made,
 * from this machine's own completed upscales, the way the sampling clock measures a preset.
 *
 * One figure rather than steps and a remainder, because an upscale has one sampler step and its
 * time is all chunks, encoding and decoding — work that grows with the frames, so per second of
 * output is the honest unit. Watched from its first running sighting only, like the sampling
 * clock: a job met mid-run after a restart would report its remainder as the whole. A source
 * whose length was not measured records nothing rather than a rate divided by a guess.
 */
export class UpscaleClock {
  private readonly watching = new Map<string, number>();

  constructor(
    private readonly record: (recipeId: string, sample: UpscaleRateSample) => void,
    private readonly now: () => number = Date.now,
  ) {}

  observe(job: Job): void {
    if (job.provider !== "comfyui" || comfyUiRecipeById(job.model)?.videoInput === undefined) return;
    const at = this.now();
    if (job.status === "running") {
      if (!this.watching.has(job.id) && (job.step == null || job.step.done === 0)) this.watching.set(job.id, at);
      return;
    }
    const started = this.watching.get(job.id);
    if (started === undefined) return;
    if (job.status === "queued" || job.status === "submitting") return;
    this.watching.delete(job.id);
    if (job.status !== "succeeded") return;
    const outputSec = Number(job.params["sourceDurationSec"]);
    const secPerOutputSec = (at - started) / 1000 / outputSec;
    if (!(outputSec > 0) || !(secPerOutputSec > 0)) return;
    this.record(job.model, { secPerOutputSec, at: new Date(at).toISOString() });
  }
}
