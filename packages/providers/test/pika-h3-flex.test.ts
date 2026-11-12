import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelManifestSchema, frameDispatchFor, validateReferences } from "@arke-studio/contracts";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { COMFYUI_RECIPES, VIDEO_DERIVATIONS, comfyUiRecipeIdentity } from "../src/comfyui/recipes.js";
import { PIKA_H3_FLEX_MODELS, PIKA_H3_FLEX_RECIPES } from "../src/comfyui/pika-h3-flex-recipe.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import type { RecipeGraph } from "../src/comfyui/recipes.js";
import type { FetchLike, SubmitRequest } from "../src/types.js";

function engine() {
  const calls: string[] = [], graphs: RecipeGraph[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/system_stats")) return new Response(JSON.stringify({ system: { comfyui_version: "0.38.0" } }));
    if (url.endsWith("/upload/image")) return new Response(JSON.stringify({ name: "uploaded.png" }));
    if (url.endsWith("/prompt")) {
      graphs.push(JSON.parse(String(init?.body)).prompt);
      return new Response(JSON.stringify({ prompt_id: "pika" }));
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { client: new ComfyUiClient(fetch, () => "http://127.0.0.1:8188", async () => ({ ok: true })), calls, graphs };
}

function request(id: string, seconds: number, picture = true): SubmitRequest {
  const recipe = PIKA_H3_FLEX_RECIPES.find(row => row.id === id)!;
  return { model: id, capability: "video", recipe: comfyUiRecipeIdentity(recipe),
    params: { prompt: "A red robot waves beside a blue ball.", seed: 9123, duration: seconds, aspect: "9:16",
      ...(picture ? { references: ["robot.png"] } : {}) },
    ...(picture ? { imageReferences: [{ name: "robot.png", contentType: "image/png", data: Uint8Array.from([1, 2, 3]) }] } : {}),
  };
}

test("Pika registrations expose the measured sizes, durations and reference budget", () => {
  ModelManifestSchema.parse(SHIPPED_MANIFEST);
  assert.equal(PIKA_H3_FLEX_RECIPES.length, 4);
  for (const recipe of PIKA_H3_FLEX_RECIPES) {
    const model = SHIPPED_MANIFEST.models.find(row => row.id === recipe.id)!;
    assert.ok(COMFYUI_RECIPES.includes(recipe));
    assert.ok(model);
    assert.equal(model.accepts.referenceImages, recipe.referenceFrame ? 0 : 1);
    assert.equal(validateReferences([{ kind: "image" }], model).ok, recipe.referenceFrame === undefined);
    assert.equal(model.accepts.referenceVideos ?? 0, 0);
    assert.equal(model.accepts.referenceAudio ?? 0, 0);
    assert.equal(validateReferences([{ kind: "image" }, { kind: "image" }], model).ok, false);
    assert.deepEqual(Object.keys(model.limits.durations!), Object.keys(VIDEO_DERIVATIONS[recipe.id]!.framesBySeconds));
    assert.equal(model.requires!.vramMb, recipe.hardware.minVramMb);
    assert.equal(model.requires!.memMb, recipe.hardware.minMemMb);
    assert.equal(model.pricing.kind, "unmetered");
    assert.equal(recipe.sampling, undefined);
    assert.equal(recipe.adapterSlot, undefined);
    assert.equal(frameDispatchFor(model, 1) !== null, recipe.referenceFrame !== undefined);
  }
  assert.deepEqual(PIKA_H3_FLEX_MODELS.map(row => Object.keys(row.limits.durations!)), [["5", "10", "15"], ["5"], ["5", "15"], ["5"]]);
});

test("Pika pins each backbone with its matching adapter and fixed six-step schedule", () => {
  for (const recipe of PIKA_H3_FLEX_RECIPES) {
    const reference = recipe.id.includes("reference");
    const backbone = reference ? "ref2va" : "fl2va";
    assert.match(String(recipe.graph["1"]!.inputs.unet_name), new RegExp(backbone));
    assert.equal(recipe.graph["2"]!.inputs.lora_name, `pika_h3_flex_${backbone}_comfy_bf16.safetensors`);
    assert.equal(recipe.graph["2"]!.inputs.strength_model, 1);
    assert.equal(recipe.graph["8"]!.class_type, "BasicGuider");
    assert.equal(recipe.graph["9"]!.class_type, "SamplerCustomAdvanced");
    assert.equal(recipe.graph["16"]!.inputs.sampler_name, "lcm");
    assert.deepEqual(String(recipe.graph["17"]!.inputs.sigmas).split(",").map(Number), [1, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0]);
    assert.equal(recipe.requires.checkpoints.length, 5);
    assert.ok(recipe.requires.checkpoints.every(file => /^[0-9a-f]{64}$/.test(file.sha256) && /\/resolve\/[0-9a-f]{40}\//.test(file.url)));
    assert.ok(!recipe.requires.checkpoints.some(file => /turbo|lightx2v/i.test(file.file)));
  }
});

test("Pika submits each preset through shared derivation, upload and identity boundaries", async () => {
  for (const recipe of PIKA_H3_FLEX_RECIPES) {
    const seconds = recipe.id.endsWith("768") ? 5 : 15;
    const { client, graphs } = engine();
    try {
      await client.submit("", request(recipe.id, seconds));
      const graph = graphs[0]!;
      assert.equal(graph["7"]!.inputs.width, recipe.id.endsWith("768") ? 768 : 480);
      assert.equal(graph["7"]!.inputs.height, recipe.id.endsWith("768") ? 1344 : 864);
      assert.equal(graph["7"]!.inputs.length, seconds === 5 ? 124 : 362);
      assert.equal(graph["15"]!.inputs.noise_seed, 9123);
      assert.equal(graph["14"]!.inputs.image, "uploaded.png");
      if (recipe.referenceFrame) {
        assert.deepEqual(graph["7"]!.inputs.first_frame, ["18", 0]);
        assert.equal(graph["18"]!.inputs.height, graph["7"]!.inputs.height);
      } else {
        assert.deepEqual(graph["7"]!.inputs["ref_images.ref_image_0"], ["14", 0]);
        assert.equal(graph["7"]!.inputs.first_frame, undefined);
      }
    } finally { client.dispose(); }
  }
});

test("Pika text generation prunes the optional first-frame loader and scaler", async () => {
  const { client, graphs } = engine();
  try {
    await client.submit("", request("comfyui-pika-h3-flex", 10, false));
    assert.equal(graphs[0]!["7"]!.inputs.length, 243);
    assert.equal(graphs[0]!["7"]!.inputs.first_frame, undefined);
    assert.equal(graphs[0]!["14"], undefined);
    assert.equal(graphs[0]!["18"], undefined);
  } finally { client.dispose(); }
});

test("unsupported Pika durations and generic H3 sampling refuse before uploads", async () => {
  const cases = [request("comfyui-pika-h3-flex-768", 10), request("comfyui-pika-h3-flex-reference-768", 15), request("comfyui-pika-h3-flex-reference", 10)];
  const sampling = request("comfyui-pika-h3-flex", 5);
  sampling.params.sampling = { preset: "fast", steps: 8, speedAdapter: 1, shift: 12, sampler: "euler", scheduler: "simple" };
  cases.push(sampling);
  for (const input of cases) {
    const { client, calls } = engine();
    try {
      await assert.rejects(client.submit("", input));
      assert.ok(!calls.some(url => url.endsWith("/upload/image") || url.endsWith("/prompt")));
    } finally { client.dispose(); }
  }
});
