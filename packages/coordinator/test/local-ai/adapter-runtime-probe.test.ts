import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { H3_ADAPTER_BUNDLES, comfyUiRecipeById, comfyUiRecipeIdentity, comfyUiRouteRecipe, recipeWithAdapters } from "@arke-studio/providers";
import type { RuntimeProbes } from "@arke-studio/contracts";
import type { ComfyUiEngineService } from "../../src/comfyui/engine.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { FakeProvider } from "../queue/fake-provider.js";

/**
 * An adapter dispatch measures the machine itself.
 *
 * Only Settings › Providers › ComfyUI asked for a probe, and a launch starts unmeasured (#1013),
 * so after every launch the first bench dispatch of an H3 video with an adapter was refused with
 * "measure local graphics" until someone happened to open that panel. Reproduced 2026-09-30 on
 * the installed app.
 */

const MODEL = "comfyui-h3-video";
const PROBES: RuntimeProbes = { vramMb: 12 * 1024, memMb: 32 * 1024, diskFreeMb: 500 * 1024, accelerators: ["cuda"], platform: "win32" };

async function harness(probeRuntime: () => Promise<RuntimeProbes>) {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-09-30T12:00:00.000Z" });
  const asked: (RuntimeProbes | null)[] = [];
  const engineStatus = () => ({ source: "managed", state: "ready", locality: "local", location: "127.0.0.1:8188",
    version: "0.3.45", instanceId: "engine-1", detail: null, detected: [] });
  const service = {
    engineStatus,
    engineIdentity: () => null,
    identityFor: () => null,
    baseUrl: () => "http://127.0.0.1:8188",
    baseUrls: () => ["http://127.0.0.1:8188"],
    status: async (probes: RuntimeProbes | null) => {
      asked.push(probes);
      return { engine: engineStatus(), checkedAt: "2026-09-30T12:00:00.000Z",
        recipes: [{ recipeId: MODEL, recipeVersion: 1, displayName: "H3 video", capability: "video", state: "ready" }] };
    },
    checkNow: async () => {},
    applySettings: async () => {},
    reverify: async () => {},
    subscribe: () => () => {},
    dispose: async () => {},
  } as unknown as ComfyUiEngineService;
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    manifest: { manifestVersion: 1, generated: "2026-09-30", models: [] },
    probeRuntime,
    comfyui: { service },
    dispatchClients: { comfyui: new FakeProvider() },
  });
  // Adapter access, downloads and scanning are the library's own tests; this is about the
  // hardware floor that follows it.
  (coordinator as unknown as { adapterLibrary: { guard(): Promise<void> } }).adapterLibrary.guard = async () => {};
  await coordinator.start();
  const dispatch = (extra: Record<string, unknown> = {}, recipe?: import("@arke-studio/contracts").RecipeIdentity) => coordinator.enqueueJob({
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    target: { kind: "shot", id: "sh_12" },
    capability: "video",
    provider: "comfyui",
    model: MODEL,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p", adapters: H3_ADAPTER_BUNDLES[0]!.selections, ...extra },
    estimatedMicroUsd: 0,
    ...(recipe ? { recipe } : {}),
  });
  return { coordinator, asked, dispatch, close: async () => { await coordinator.stop(); await provider.close(); } };
}

it("an adapter dispatch with no prior detect-runtimes measures the machine and proceeds", async () => {
  let probes = 0;
  const h = await harness(async () => { probes++; return PROBES; });
  try {
    assert.equal(h.coordinator.getState().app.runtime, null, "a launch starts unmeasured");
    const job = await h.dispatch();
    assert.equal(job.model, MODEL);
    assert.equal(probes, 1);
    // Measured through the detect-runtimes path, so Settings shows the figures it was judged on
    // and admission's recipe walk was handed them rather than null.
    assert.equal(h.coordinator.getState().app.runtime!.probes.vramMb, PROBES.vramMb);
    assert.deepEqual(h.asked.at(-1), PROBES);
    await h.dispatch();
    assert.equal(probes, 1, "a measured machine is not probed again for every dispatch");
  } finally { await h.close(); }
});

it("concurrent adapter dispatches share one probe", async () => {
  let probes = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(async () => { probes++; await held; return PROBES; });
  try {
    const both = Promise.all([h.dispatch(), h.dispatch()]);
    release();
    assert.equal((await both).length, 2);
    assert.equal(probes, 1);
  } finally { release(); await h.close(); }
});

it("a probe that fails still refuses, and publishes nothing over the unknown (D12)", async () => {
  let probes = 0;
  const h = await harness(async () => { probes++; throw new Error("nvidia-smi missing"); });
  try {
    await assert.rejects(h.dispatch(), /Could not measure graphics and system memory/);
    assert.equal(h.coordinator.getState().app.runtime, null);
    // A failed probe is not remembered as an answer: the next dispatch asks again.
    await assert.rejects(h.dispatch(), /Could not measure/);
    assert.equal(probes, 2);
  } finally { await h.close(); }
});

it("a reference-route job freezes the reference graph's identity, adapters on top (design turn 179)", async () => {
  const h = await harness(async () => PROBES);
  try {
    const job = await h.dispatch({ recipeRoute: "reference" });
    assert.equal(job.recipe?.route, "reference");
    const route = comfyUiRouteRecipe(comfyUiRecipeById(MODEL)!, "reference");
    assert.equal(job.recipe?.templateDigest, comfyUiRecipeIdentity(recipeWithAdapters(route, H3_ADAPTER_BUNDLES[0]!.selections)).templateDigest);
    assert.deepEqual(job.recipe?.adapters, H3_ADAPTER_BUNDLES[0]!.selections);
    const plain = await h.dispatch({ recipeRoute: "reference", adapters: undefined });
    assert.equal(plain.recipe?.route, "reference");
    assert.equal(plain.recipe?.templateDigest, comfyUiRecipeIdentity(route).templateDigest);
    // A caller holding the text-to-video identity is not let through onto the reference graph.
    await assert.rejects(h.dispatch({ recipeRoute: "reference", adapters: undefined }, comfyUiRecipeIdentity(comfyUiRecipeById(MODEL)!)), /no longer matches/);
    await assert.rejects(h.dispatch({ recipeRoute: "sideways" }), /not a recipe route/);
  } finally { await h.close(); }
});
