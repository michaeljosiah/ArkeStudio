import { randomInt } from "node:crypto";
import { comfyUiRecipeById } from "@arke-studio/providers";
import type { EnqueueInput } from "./dispatcher.js";

/**
 * Local recipes carry a fixed sampler seed in their template (0), and nothing sent one, so every
 * take of a request started from the same noise: two H3 takes with different adapter strengths
 * came back near-identical and "Run it again" could never differ (2026-09-30). Freezing a random
 * seed before the job is journalled means a retry or resubmission repeats the same sample and the
 * job records how to reproduce it. A caller's own seed stands; recipes without a seed are untouched.
 */
export function withLocalSeed(input: EnqueueInput, pick: () => number = () => randomInt(0, 2 ** 31 - 1)): EnqueueInput {
  if (input.provider !== "comfyui" || input.params.seed !== undefined || !comfyUiRecipeById(input.model)?.params.seed) return input;
  return { ...input, params: { ...input.params, seed: pick() } };
}
