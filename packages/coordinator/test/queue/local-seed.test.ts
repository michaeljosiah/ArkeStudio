import assert from "node:assert/strict";
import { it } from "node:test";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { withLocalSeed } from "../../src/queue/local-seed.js";

const job = (provider: string, model: string, params: Record<string, unknown> = { prompt: "A red cube moves." }): EnqueueInput => ({
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "shot", id: "sh_12" }, capability: "video",
  provider, model, params, estimatedMicroUsd: 0,
});

it("a local recipe with a seed gets a fresh frozen seed per job, not the template's 0", () => {
  const seeds = [7, 1234567];
  const first = withLocalSeed(job("comfyui", "comfyui-h3-video"), () => seeds.shift()!);
  const second = withLocalSeed(job("comfyui", "comfyui-h3-video"), () => seeds.shift()!);
  assert.equal(first.params.seed, 7);
  assert.equal(second.params.seed, 1234567);
  assert.equal(first.params.prompt, "A red cube moves.");
  const drawn = withLocalSeed(job("comfyui", "comfyui-krea2-image")).params.seed as number;
  assert.ok(Number.isInteger(drawn) && drawn >= 0 && drawn < 2 ** 31 - 1);
});

it("a caller's seed, a recipe without one and a cloud job are left alone", () => {
  const never = () => assert.fail("no seed should be drawn");
  const pinned = job("comfyui", "comfyui-h3-video", { prompt: "x", seed: 42 });
  assert.equal(withLocalSeed(pinned, never), pinned);
  const unknown = job("comfyui", "not-a-recipe");
  assert.equal(withLocalSeed(unknown, never), unknown);
  const cloud = job("fal", "seedance-2.0-fast");
  assert.equal(withLocalSeed(cloud, never), cloud);
});
