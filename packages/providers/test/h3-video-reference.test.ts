import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RecipeIdentitySchema, type JobSampling } from "@arke-studio/contracts";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { recipeWithAdapters } from "../src/comfyui/adapters.js";
import { H3_ADAPTER_BUNDLES } from "../src/comfyui/adapter-bundles.js";
import { H3_REFERENCE } from "../src/comfyui/h3-reference-recipe.js";
import {
  COMFYUI_MANIFEST_MODELS,
  COMFYUI_RECIPES,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  comfyUiRouteRecipe,
  recipeNodeClasses,
} from "../src/comfyui/recipes.js";
import type { FetchLike, SubmitRequest } from "../src/types.js";

/*
 * H3 Video's reference route (design turn 179): fl2va through MiniMaxH3ReferenceToVideo, with
 * the parent's sampling and adapter slot, a graph and identity of its own, and refusals where a
 * picture would otherwise go somewhere it was not meant to.
 */

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const base = comfyUiRecipeById("comfyui-h3-video")!;
const route = comfyUiRouteRecipe(base, "reference");
const pictures = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6]), Uint8Array.from([7, 8, 9])];
const hashOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const motionAnatomy = H3_ADAPTER_BUNDLES.find((bundle) => bundle.id === "minimax-h3-motion-anatomy-v1")!.selections;

function engine() {
  const calls: string[] = [];
  const graphs: Graph[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/system_stats")) return Response.json({ system: { comfyui_version: "0.38.1" } });
    if (url.endsWith("/object_info/LoraLoaderModelOnly")) {
      return Response.json({ LoraLoaderModelOnly: { input: { required: { lora_name: [motionAnatomy.map((row) => `arke/${row.sha256}.safetensors`)] } } } });
    }
    if (url.endsWith("/upload/image")) {
      const file = (init!.body as FormData).get("image") as File;
      return Response.json({ name: file.name });
    }
    if (url.endsWith("/prompt")) {
      graphs.push(JSON.parse(String(init!.body)).prompt);
      return Response.json({ prompt_id: "h3-video-reference" });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const client = new ComfyUiClient(fetch, () => "http://127.0.0.1:8188", async () => ({ ok: true }),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => {});
  return { client, calls, graphs };
}

function request(count: number, extra: Partial<SubmitRequest["params"]> = {}, model = base.id): SubmitRequest {
  const sent = pictures.slice(0, count);
  const adapters = extra["adapters"];
  const recipe = comfyUiRecipeIdentity(recipeWithAdapters(comfyUiRouteRecipe(comfyUiRecipeById(model)!, "reference"), adapters));
  return {
    model,
    capability: "video",
    recipe,
    params: {
      prompt: "<Subject 1> is the person, shown in <Picture 1>.\nA slow camera move.",
      seed: 7,
      durationSec: 15,
      aspect: "16:9",
      recipeRoute: "reference",
      references: sent.map((_, i) => `artifacts/p${i}.png`),
      referenceHashes: sent.map(hashOf),
      ...extra,
    },
    imageReferences: sent.map((data, i) => ({ name: `reference-0${i + 1}.png`, contentType: "image/png", data })),
  };
}

test("the reference route is fl2va through MiniMaxH3ReferenceToVideo, and otherwise H3 Video's graph", () => {
  assert.equal(route.id, base.id, "the same model to the queue, the price and the take");
  assert.equal(route.route, "reference");
  assert.equal(route.graph["7"]!.class_type, "MiniMaxH3ReferenceToVideo");
  assert.deepEqual(route.graph["7"]!.inputs["vae"], ["5", 0]);
  assert.deepEqual(route.graph["7"]!.inputs["audio_vae"], ["6", 0]);
  assert.equal(route.graph["7"]!.inputs["ref_image_size"], "match");
  assert.equal(route.graph["7"]!.inputs["first_frame"], undefined);
  assert.equal(route.graph["14"], undefined);
  assert.equal(route.graph["15"], undefined);
  assert.equal(route.referenceFrame, undefined);
  for (const id of ["1", "2", "3", "4", "5", "6", "8", "9", "10", "11", "12", "13"]) {
    assert.deepEqual(route.graph[id], base.graph[id], `node ${id} is the parent's`);
  }
  assert.equal(route.graph["1"]!.inputs["unet_name"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
  assert.equal(route.graph["2"]!.inputs["lora_name"], "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors");
  assert.deepEqual(route.adapterSlot, base.adapterSlot);
  assert.deepEqual(route.sampling, base.sampling);
  assert.deepEqual(route.requires, base.requires);
  assert.equal(route.referenceImages!.length, 3);
  assert.deepEqual(route.engine, { minVersion: "0.33.1", exercisedThroughVersion: "0.38.1" });
  assert.ok(recipeNodeClasses(route).includes("MiniMaxH3ReferenceToVideo"));
  assert.ok(!recipeNodeClasses(route).includes("MiniMaxH3ImageToVideo"));
});

test("the route's identity is its own: same id and pins, another graph, named", () => {
  const parent = comfyUiRecipeIdentity(base), own = comfyUiRecipeIdentity(route);
  assert.equal(own.id, parent.id);
  assert.equal(own.route, "reference");
  assert.equal(parent.route, undefined);
  assert.equal(own.version, 1);
  assert.notEqual(own.templateDigest, parent.templateDigest);
  assert.equal(own.dependencyDigest, parent.dependencyDigest);
  assert.ok(RecipeIdentitySchema.safeParse(own).success);
  // Attaching the route changed nothing a journalled H3 Video job froze.
  assert.equal(parent.version, 2);
  assert.ok(COMFYUI_RECIPES.some((recipe) => recipe.routes?.reference === route));
});

test("only H3 Video has the route, and the row offers what was measured", () => {
  assert.throws(() => comfyUiRouteRecipe(comfyUiRecipeById("comfyui-h3-video-768")!, "reference"), /^Error: H3 Video 768p takes no reference pictures yet$/);
  assert.throws(() => comfyUiRouteRecipe(base, "sideways"), /not a recipe route/);
  assert.equal(comfyUiRouteRecipe(base, undefined), base);
  const row = COMFYUI_MANIFEST_MODELS.find((model) => model.id === base.id)!;
  assert.deepEqual(row.referenceRoute, { maxImages: 2, referenceSyntax: "minimax-h3" });
  assert.equal(row.accepts.referenceImages, 1, "the first frame keeps its own budget");
  assert.ok(row.referenceRoute!.maxImages <= route.referenceImages!.length);
  for (const other of COMFYUI_MANIFEST_MODELS.filter((model) => model.id !== base.id)) assert.equal(other.referenceRoute, undefined, other.id);
});

for (const count of [1, 2, 3]) {
  test(`${count} picture(s) bind ref_image_0..${count - 1} and drop the unused carriers`, async () => {
    const { client, graphs, calls } = engine();
    try {
      await client.submit("", request(count));
      assert.equal(calls.filter((url) => url.endsWith("/upload/image")).length, count);
      const graph = graphs[0]!;
      for (let i = 0; i < 3; i++) {
        const node = String(20 + i), slot = `ref_images.ref_image_${i}`;
        if (i < count) {
          assert.deepEqual(graph["7"]!.inputs[slot], [node, 0]);
          assert.match(String(graph[node]!.inputs["image"]), /^[a-f0-9]{64}\.png$/);
        } else {
          assert.equal(graph["7"]!.inputs[slot], undefined);
          assert.equal(graph[node], undefined);
        }
      }
      assert.equal(graph["7"]!.inputs["length"], 362, "15 s, as the 480p row offers");
      assert.equal(graph["7"]!.inputs["width"], 864);
      assert.equal(graph["9"]!.inputs["steps"], 8);
    } finally { client.dispose(); }
  });
}

test("a bundle chains between the turbo LoRA and the sigma shift, as on text-to-video", async () => {
  const { client, graphs } = engine();
  try {
    await client.submit("", request(1, { adapters: motionAnatomy }));
    const graph = graphs[0]!;
    assert.deepEqual(graph["arke_adapter_0"]!.inputs["model"], ["2", 0]);
    assert.deepEqual(graph["arke_adapter_1"]!.inputs["model"], ["arke_adapter_0", 0]);
    assert.deepEqual(graph["3"]!.inputs["model"], ["arke_adapter_2", 0]);
    assert.deepEqual(motionAnatomy.map((row, i) => graph[`arke_adapter_${i}`]!.inputs["strength_model"]), [0.5, 0.4, 0.8]);
    assert.equal(graph["7"]!.class_type, "MiniMaxH3ReferenceToVideo");
  } finally { client.dispose(); }
});

test("H3 Reference Video (ref2va) refuses the bundle and every adapter", () => {
  assert.throws(() => recipeWithAdapters(H3_REFERENCE, motionAnatomy));
  assert.throws(() => recipeWithAdapters(H3_REFERENCE, motionAnatomy.slice(0, 1)), /validation/);
  assert.ok(!H3_ADAPTER_BUNDLES.some((bundle) => bundle.recipeId === H3_REFERENCE.id));
});

test("Fast and Quality reach the reference graph's own sampler slots", async () => {
  const quality: JobSampling = { preset: "quality", steps: 12, speedAdapter: 0.5, shift: 6, sampler: "euler", scheduler: "simple" };
  const { client, graphs } = engine();
  try {
    await client.submit("", request(1));
    await client.submit("", { ...request(1, { sampling: quality }), recipe: { ...request(1).recipe!, sampling: quality } });
    const [fast, slow] = graphs;
    assert.deepEqual([fast!["9"]!.inputs["steps"], fast!["9"]!.inputs["sampler_name"], fast!["9"]!.inputs["scheduler"]], [8, "euler", "simple"]);
    assert.equal(fast!["2"]!.inputs["strength_model"], 1);
    assert.deepEqual([slow!["9"]!.inputs["steps"], slow!["2"]!.inputs["strength_model"], slow!["3"]!.inputs["shift_video"]], [12, 0.5, 6]);
  } finally { client.dispose(); }
});

test("refusals land before anything reaches the engine", async () => {
  const cases: Array<[string, SubmitRequest, RegExp]> = [
    ["a changed picture", { ...request(1), params: { ...request(1).params, referenceHashes: [hashOf(Uint8Array.from([0]))] } }, /changed since it was reviewed/],
    ["no recorded hashes", { ...request(1), params: { ...request(1).params, referenceHashes: undefined } }, /reviewed as/],
    ["a keyframe beside references", { ...request(1), params: { ...request(1).params, taskMode: "first-frame" } }, /keyframe and reference pictures/],
    ["no picture", { ...request(0), params: { ...request(0).params, references: [] } }, /at least one picture/],
    ["more pictures than carriers", request(3, {}, base.id), /./],
    ["768p", { ...request(1), model: "comfyui-h3-video-768" }, /H3 Video 768p takes no reference pictures yet/],
    ["the parent's identity", { ...request(1), recipe: comfyUiRecipeIdentity(base) }, /refused rather than run against a different graph/],
  ];
  // Three carriers exist; four pictures must refuse rather than drop one.
  const four = request(3);
  four.imageReferences = [...four.imageReferences!, four.imageReferences![0]!];
  four.params.references = [...(four.params.references as string[]), "artifacts/p3.png"];
  four.params.referenceHashes = [...(four.params.referenceHashes as string[]), hashOf(pictures[0]!)];
  cases[4] = ["more pictures than carriers", four, /up to 3 reference images/];
  for (const [what, input, refusal] of cases) {
    const { client, calls } = engine();
    try {
      await assert.rejects(client.submit("", input), refusal, what);
      assert.deepEqual(calls.filter((url) => !url.endsWith("/system_stats")), [], `${what}: nothing uploaded or queued`);
    } finally { client.dispose(); }
  }
});

test("a sixteen-digit recorded hash is held to its prefix, as older sidecars write it", async () => {
  const { client, graphs } = engine();
  try {
    const input = request(1);
    input.params.referenceHashes = [hashOf(pictures[0]!).slice(0, "sha256:".length + 16)];
    await client.submit("", input);
    assert.equal(graphs.length, 1);
  } finally { client.dispose(); }
});
