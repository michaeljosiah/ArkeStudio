import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, Job, ManifestModel, SamplingTimingSample } from "@arke-studio/contracts";
import { COMFYUI_MANIFEST_MODELS, comfyUiRecipeById } from "@arke-studio/providers";
import { AppSettingsFile } from "../../src/app-settings.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { SamplingClock, localTakeFreeze, withLocalSampling } from "../../src/queue/local-sampling.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { FakeProvider } from "./fake-provider.js";

/*
 * Sampling for a local recipe (design turn 177): frozen into a job beside its seed, a device
 * setting per recipe, and a time measured from this machine's own runs.
 */

const H3 = "comfyui-h3-video";
const catalogue = comfyUiRecipeById(H3)!.sampling!;
const FAST = { preset: "fast" as const, ...catalogue.presets[0]!.values };
const QUALITY = { preset: "quality" as const, ...catalogue.presets[2]!.values };

const job = (provider: string, model: string, params: Record<string, unknown> = { prompt: "A red cube moves." }): EnqueueInput => ({
  worldId: WORLD_ID, target: { kind: "shot", id: "sh_12" }, capability: "video",
  provider, model, params, estimatedMicroUsd: 0,
});

describe("freezing sampling into a job", () => {
  it("resolves the device setting for a recipe that declares sampling", () => {
    assert.deepEqual(withLocalSampling(job("comfyui", H3), () => undefined).params.sampling, FAST);
    assert.deepEqual(withLocalSampling(job("comfyui", H3), () => ({ preset: "quality" })).params.sampling, QUALITY);
  });

  it("leaves a caller's sampling, a recipe without sampling and a cloud job alone", () => {
    const never = () => assert.fail("no setting should be read");
    const carried = job("comfyui", H3, { prompt: "x", sampling: QUALITY });
    assert.equal(withLocalSampling(carried, never), carried);
    const draft = job("comfyui", "comfyui-draft-video");
    assert.equal(withLocalSampling(draft, never), draft);
    const cloud = job("fal", "seedance-2.0-fast");
    assert.equal(withLocalSampling(cloud, never), cloud);
  });

  it("a bench take freezes its seed and sampling; a re-run keeps the sampling and draws a new seed", () => {
    const seeds = [11, 22, 33];
    const next = () => seeds.shift()!;
    assert.deepEqual(localTakeFreeze(H3, undefined, () => ({ preset: "quality" }), next), { seed: 11, sampling: QUALITY });
    // The setting has moved to Balanced since; the re-run is of the Quality take.
    assert.deepEqual(localTakeFreeze(H3, { sampling: QUALITY }, () => ({ preset: "balanced" }), next), { seed: 22, sampling: QUALITY });
    // A take from before sampling existed was sent at the shipped values.
    assert.deepEqual(localTakeFreeze(H3, {}, () => ({ preset: "balanced" }), next), { seed: 33, sampling: FAST });
    assert.deepEqual(localTakeFreeze("comfyui-krea2-image", undefined, () => undefined, () => 5), { seed: 5 });
    assert.deepEqual(localTakeFreeze("seedance-2.0", undefined, () => undefined, () => 5), {});
  });
});

describe("the measured time", () => {
  const running = (at: number, step?: { done: number; total: number }, extra: Partial<Job> = {}): Job => ({
    id: "jb_1", provider: "comfyui", model: H3, status: "running",
    params: { prompt: "p", duration: 5, sampling: FAST },
    ...(step ? { step: { stage: "making video", ...step } } : {}),
    ...extra,
  }) as unknown as Job;

  it("splits a run into seconds per step and a fixed remainder, stated for the reference clip", () => {
    let now = 0;
    const recorded: Array<[string, SamplingTimingSample]> = [];
    const clock = new SamplingClock((recipe, sample) => recorded.push([recipe, sample]), () => now);
    clock.observe(running(0));
    // 100 s loading, then 60 s a step; each count seen a little after it lands, and seen again.
    for (const [at, done] of [[161, 1], [163, 1], [221, 2], [281, 3], [341, 4], [401, 5], [461, 6], [521, 7], [581, 8], [700, 8]] as const) {
      now = at * 1000;
      clock.observe(running(now, { done, total: 8 }));
    }
    now = 760_000;
    clock.observe({ ...running(now), status: "succeeded" } as Job);
    assert.equal(recorded.length, 1);
    const [recipe, sample] = recorded[0]!;
    assert.equal(recipe, H3);
    // 124 frames ran; the 10 s reference clip is 243, so the per-step figure scales by that.
    assert.ok(Math.abs(sample.secPerStep - 60 * (243 / 124)) < 1e-9);
    assert.ok(Math.abs(sample.fixedSec - (760 - 8 * 60)) < 1e-9);
  });

  it("records nothing for a failed run, a run met mid-way, or a job without sampling", () => {
    const recorded: unknown[] = [];
    let now = 0;
    const clock = new SamplingClock((...args) => recorded.push(args), () => now);
    clock.observe(running(0));
    clock.observe(running(1, { done: 1, total: 8 }));
    now = 5000;
    clock.observe(running(5, { done: 2, total: 8 }));
    clock.observe({ ...running(9), status: "failed" } as Job);
    clock.observe(running(10, { done: 3, total: 8 }, { id: "jb_2" } as Partial<Job>));
    clock.observe({ ...running(20), id: "jb_2", status: "succeeded" } as Job);
    const plain = running(0, undefined, { id: "jb_3", params: { prompt: "p" } } as Partial<Job>);
    clock.observe(plain);
    clock.observe({ ...plain, status: "succeeded" } as Job);
    assert.deepEqual(recorded, []);
  });
});

describe("the device setting", () => {
  it("stores a preset by name and Custom with its values, drops Fast, and keeps the last five runs", async () => {
    const { root } = await makeTempRoot();
    const file = new AppSettingsFile(join(root, "settings.json"));
    await file.setLocalSampling(H3, { preset: "quality" });
    const values = { steps: 20, speedAdapter: 0.6, shift: 7, sampler: "euler", scheduler: "beta" };
    await file.setLocalSampling("comfyui-h3-video-768", { preset: "custom", values });
    assert.deepEqual((await file.load()).localSampling.choices, {
      [H3]: { preset: "quality" },
      "comfyui-h3-video-768": { preset: "custom", values },
    });
    await file.setLocalSampling(H3, { preset: "fast" });
    await file.setLocalSampling("comfyui-h3-video-768", null);
    assert.deepEqual((await file.load()).localSampling.choices, {});
    for (let run = 1; run <= 7; run += 1) {
      await file.recordSamplingTiming(H3, { secPerStep: run, fixedSec: 10, at: "2026-09-30T12:00:00.000Z" });
    }
    assert.deepEqual((await file.load()).localSampling.timings[H3]!.map((sample) => sample.secPerStep), [3, 4, 5, 6, 7]);
  });
});

describe("through the coordinator", () => {
  async function harness() {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => "2026-09-30T12:00:00.000Z" });
    await provider.loadWorld(WORLD_ID);
    const models: ManifestModel[] = COMFYUI_MANIFEST_MODELS.filter((model) => model.id === H3);
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      appRoot: root,
      cipher: devCipher(),
      credentialsFileName: "credentials.dev.dat",
      manifest: { manifestVersion: 1, generated: "2026-09-30", models },
      dispatchClients: { comfyui: new FakeProvider() },
    });
    const send = (message: ClientMessage) =>
      (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
    await coordinator.start(0);
    return { root, coordinator, send };
  }

  it("persists the setting, publishes it, refuses Custom out of bounds, and freezes it into new jobs once", async () => {
    const { root, coordinator, send } = await harness();
    try {
      await send({ kind: "set-local-sampling", recipeId: H3, sampling: { preset: "quality" } });
      assert.deepEqual(coordinator.getState().app.localSampling?.choices, { [H3]: { preset: "quality" } });
      const onDisk = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { localSampling: unknown };
      assert.deepEqual(onDisk.localSampling, { choices: { [H3]: { preset: "quality" } }, timings: {} });
      // A recipe with no sampling is not stored against.
      await send({ kind: "set-local-sampling", recipeId: "comfyui-draft-video", sampling: { preset: "quality" } });
      assert.equal(coordinator.getState().app.localSampling?.choices["comfyui-draft-video"], undefined);
      // Custom with a sampler outside the recipe's allow-list is refused whole.
      await send({ kind: "set-local-sampling", recipeId: H3,
        sampling: { preset: "custom", values: { steps: 20, speedAdapter: 0.5, shift: 6, sampler: "lcm", scheduler: "simple" } } });
      assert.deepEqual(coordinator.getState().app.localSampling?.choices[H3], { preset: "quality" });

      // The freeze enqueue runs, read directly: admission here would need a live engine.
      const freeze = (input: EnqueueInput) =>
        (coordinator as unknown as { freezeLocalIdentity(input: EnqueueInput): EnqueueInput }).freezeLocalIdentity(input);
      const queued = freeze(job("comfyui", H3, { prompt: "harbour", durationSec: 5 }));
      assert.deepEqual(queued.params.sampling, QUALITY);
      assert.equal(typeof queued.params.seed, "number");
      // Frozen once: a retry of the frozen input keeps both, whatever Settings says by then.
      await send({ kind: "set-local-sampling", recipeId: H3, sampling: null });
      assert.deepEqual(coordinator.getState().app.localSampling?.choices, {});
      const retried = freeze(queued);
      assert.deepEqual(retried.params.sampling, QUALITY);
      assert.equal(retried.params.seed, queued.params.seed);
      assert.deepEqual(freeze(job("comfyui", H3, { prompt: "harbour", durationSec: 5 })).params.sampling, FAST);
      // A recipe identity handed in without sampling gains the job's; one that disagrees refuses.
      const identity = { id: H3, version: 2, templateDigest: "a".repeat(64), dependencyDigest: "b".repeat(64) };
      assert.deepEqual(freeze({ ...job("comfyui", H3, { prompt: "p" }), recipe: identity }).recipe?.sampling, FAST);
      assert.throws(() => freeze({ ...job("comfyui", H3, { prompt: "p", sampling: QUALITY }), recipe: { ...identity, sampling: FAST } }),
        /sampling no longer matches/);
    } finally {
      await coordinator.stop();
    }
  });
});
