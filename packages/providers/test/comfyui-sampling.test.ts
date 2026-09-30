import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelSamplingSchema, SAMPLING_BOUNDS, type JobSampling } from "@arke-studio/contracts";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import {
  COMFYUI_MANIFEST_MODELS,
  COMFYUI_RECIPES,
  SAMPLING_PARAMS,
  callerParamNames,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  substituteRecipeParams,
} from "../src/comfyui/recipes.js";
import type { FetchLike, SubmitRequest } from "../src/types.js";

/*
 * Sampling for a local recipe (design turn 177): the presets are catalogue data, each value
 * reaches exactly the slot it names, and Fast is the graph as it always shipped.
 */

const OK_PREFLIGHT = async () => ({ ok: true }) as const;
const BASE = () => "http://127.0.0.1:8188";
type Graph = Record<string, { inputs: Record<string, unknown> }>;

async function posted(params: SubmitRequest["params"], extra: Partial<SubmitRequest> = {}): Promise<Graph> {
  let body: { prompt: Graph } | null = null;
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/prompt")) body = JSON.parse(init?.body as string) as { prompt: Graph };
    return new Response(JSON.stringify({ prompt_id: "p-samp", node_errors: {} }));
  };
  await new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
    model: "comfyui-h3-video",
    capability: "video",
    params,
    ...extra,
  });
  assert.ok(body, "the graph reached /prompt");
  return (body as { prompt: Graph }).prompt;
}

const QUALITY: JobSampling = { preset: "quality", steps: 12, speedAdapter: 0.5, shift: 6, sampler: "euler", scheduler: "simple" };

describe("local sampling catalogue", () => {
  const declaring = COMFYUI_RECIPES.filter((recipe) => recipe.sampling !== undefined);

  it("declares sampling on both FL2VA rows and nowhere it was not drawn", () => {
    assert.deepEqual(declaring.map((recipe) => recipe.id).sort(), ["comfyui-h3-video", "comfyui-h3-video-768"]);
  });

  for (const recipe of declaring) {
    it(`${recipe.id}: presets parse, sit inside the Custom bounds, and project onto the manifest row`, () => {
      const catalogue = ModelSamplingSchema.parse(recipe.sampling);
      for (const preset of catalogue.presets) {
        assert.ok(preset.values.steps >= SAMPLING_BOUNDS.steps.min && preset.values.steps <= SAMPLING_BOUNDS.steps.max);
        assert.ok(catalogue.samplers.includes(preset.values.sampler));
        assert.ok(catalogue.schedulers.includes(preset.values.scheduler));
      }
      const row = COMFYUI_MANIFEST_MODELS.find((model) => model.id === recipe.id)!;
      assert.deepEqual(row.sampling, recipe.sampling);
    });

    it(`${recipe.id}: Fast is the graph's own values, and every sampling param is internal and bound`, () => {
      const fast = recipe.sampling!.presets[0]!;
      assert.equal(fast.id, "fast");
      const graph = recipe.graph;
      assert.equal(graph["9"]!.inputs["steps"], fast.values.steps);
      assert.equal(graph["2"]!.inputs["strength_model"], fast.values.speedAdapter);
      assert.equal(graph["3"]!.inputs["shift_video"], fast.values.shift);
      assert.equal(graph["9"]!.inputs["sampler_name"], fast.values.sampler);
      assert.equal(graph["9"]!.inputs["scheduler"], fast.values.scheduler);
      for (const name of SAMPLING_PARAMS) {
        assert.equal(recipe.params[name]?.internal, true, `${name} cannot be sent by a caller`);
        assert.equal(callerParamNames(recipe).has(name), false);
      }
    });
  }

  it("states times for a 10 s clip where the row offers one, and for its one length at 768p", () => {
    assert.equal(comfyUiRecipeById("comfyui-h3-video")!.sampling!.clipSec, 10);
    assert.equal(comfyUiRecipeById("comfyui-h3-video-768")!.sampling!.clipSec, 5);
  });

  it("sampling changes no recipe version: the catalogue's identity carries none, a job's does", () => {
    const identity = comfyUiRecipeIdentity(comfyUiRecipeById("comfyui-h3-video")!);
    assert.equal(identity.version, 2);
    assert.equal("sampling" in identity, false);
  });
});

describe("substitution bounds", () => {
  const h3 = comfyUiRecipeById("comfyui-h3-video")!;
  const base = { prompt: "harbour", width: 864, height: 480, length: 124 };

  it("refuses every value outside its bounds or allow-list", () => {
    for (const [name, value] of [
      ["steps", 3], ["steps", 31], ["steps", 8.5],
      ["speedAdapter", -0.05], ["speedAdapter", 1.05], ["speedAdapter", 0.37],
      ["shift", 0.5], ["shift", 15.5],
      ["sampler", "lcm"], ["scheduler", "karras"],
    ] as const) {
      assert.throws(() => substituteRecipeParams(h3, { ...base, [name]: value }), new RegExp(`"${name}"`), `${name}=${value}`);
    }
  });

  it("Fast substituted is the shipped graph byte for byte", () => {
    const fast = h3.sampling!.presets[0]!.values;
    assert.equal(
      JSON.stringify(substituteRecipeParams(h3, { ...base, ...fast })),
      JSON.stringify(substituteRecipeParams(h3, base)),
    );
  });
});

describe("dispatching a job's frozen sampling", () => {
  it("binds each value into the slot it names", async () => {
    const graph = await posted({ prompt: "harbour at dawn", durationSec: 5, sampling: QUALITY });
    assert.equal(graph["9"]!.inputs["steps"], 12);
    assert.equal(graph["2"]!.inputs["strength_model"], 0.5);
    assert.equal(graph["3"]!.inputs["shift_video"], 6);
    assert.equal(graph["3"]!.inputs["shift_audio"], 3, "the audio shift is not sampling's to move");
    assert.equal(graph["9"]!.inputs["sampler_name"], "euler");
    assert.equal(graph["9"]!.inputs["scheduler"], "simple");
    assert.equal(graph["9"]!.inputs["cfg"], 1);
  });

  it("a job that froze Fast sends exactly what a job without sampling sends", async () => {
    const fast = { preset: "fast", ...comfyUiRecipeById("comfyui-h3-video")!.sampling!.presets[0]!.values };
    const withFast = await posted({ prompt: "harbour at dawn", durationSec: 5, seed: 7, sampling: fast });
    const without = await posted({ prompt: "harbour at dawn", durationSec: 5, seed: 7 });
    assert.equal(JSON.stringify(withFast), JSON.stringify(without));
  });

  it("refuses sampling out of bounds, and sampling sent to a recipe that declares none", async () => {
    await assert.rejects(posted({ prompt: "p", durationSec: 5, sampling: { ...QUALITY, steps: 40 } }), /out of bounds/);
    await assert.rejects(posted({ prompt: "p", durationSec: 5, sampling: { ...QUALITY, sampler: "lcm" } }), /"sampler"/);
    const fetch: FetchLike = async () => new Response(JSON.stringify({ prompt_id: "x", node_errors: {} }));
    await assert.rejects(
      new ComfyUiClient(fetch, BASE, OK_PREFLIGHT).submit("", {
        model: "comfyui-draft-video",
        capability: "video",
        params: { prompt: "p", durationSec: 5, sampling: QUALITY },
      }),
      /does not take sampling/,
    );
  });

  it("refuses params that disagree with the sampling frozen into the job's identity", async () => {
    const recipe = { ...comfyUiRecipeIdentity(comfyUiRecipeById("comfyui-h3-video")!), sampling: QUALITY };
    await assert.rejects(
      posted({ prompt: "p", durationSec: 5, sampling: { ...QUALITY, steps: 10 } }, { recipe }),
      /does not match the sampling recorded/,
    );
    // Key order is the journal's to change: the same values in another order still match.
    const reordered = { scheduler: "simple", sampler: "euler", shift: 6, speedAdapter: 0.5, steps: 12, preset: "quality" };
    const graph = await posted({ prompt: "p", durationSec: 5, sampling: reordered }, { recipe });
    assert.equal(graph["9"]!.inputs["steps"], 12);
  });
});
