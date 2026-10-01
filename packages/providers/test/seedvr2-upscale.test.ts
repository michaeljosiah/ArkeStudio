import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ManifestModelSchema, isUpscaler, modelForCapability } from "@arke-studio/contracts";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import {
  COMFYUI_MANIFEST_MODELS,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  recipeNodeClasses,
  substituteRecipeParams,
} from "../src/comfyui/recipes.js";
import { SHIPPED_MANIFEST } from "../src/index.js";
import type { FetchLike, SubmitRequest } from "../src/types.js";

/*
 * Upscale to 1080p (design turn 178): SeedVR2 3B on ComfyUI's own nodes, the graph proven on
 * 0.38.1 node for node, a source video in and nothing else, and only the saved result fetched.
 */

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const recipe = comfyUiRecipeById("comfyui-seedvr2-upscale")!;
const clip = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const hash16 = `sha256:${createHash("sha256").update(clip).digest("hex").slice(0, 16)}`;

function engine(history: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const graphs: Graph[] = [];
  const uploads: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/system_stats")) return Response.json({ system: { comfyui_version: "0.38.1" } });
    if (url.endsWith("/upload/image")) {
      const file = (init!.body as FormData).get("image") as File;
      uploads.push(file.name);
      return Response.json({ name: file.name });
    }
    if (url.endsWith("/prompt")) {
      graphs.push(JSON.parse(String(init!.body)).prompt);
      return Response.json({ prompt_id: "upscale" });
    }
    if (url.includes("/history/")) return Response.json(history);
    if (url.includes("/view?")) return new Response(new Uint8Array([1, 2, 3]));
    throw new Error(`Unexpected request ${url}`);
  };
  const client = new ComfyUiClient(fetch, () => "http://127.0.0.1:8188", async () => ({ ok: true }),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => {});
  return { client, calls, graphs, uploads };
}

function request(extra: Partial<SubmitRequest["params"]> = {}, more: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    model: recipe.id,
    capability: "video",
    recipe: comfyUiRecipeIdentity(recipe),
    params: {
      size: "1080p",
      aspect: "16:9",
      seed: 11,
      videoReferences: [".sessions/sess_x/media/tk_x/output-1.mp4"],
      sourceHash: hash16,
      sourceDurationSec: 7.3,
      ...extra,
    },
    videoReferences: [{ name: "reference-01.mp4", contentType: "video/mp4", data: clip }],
    ...more,
  };
}

test("the graph is the one proven on ComfyUI 0.38.1, on built-in nodes only", () => {
  const g = recipe.graph;
  assert.deepEqual(g["1"], { class_type: "LoadVideo", inputs: { file: "" } });
  assert.deepEqual(g["2"], { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } });
  assert.deepEqual(g["3"]!.inputs, { image: ["2", 0], upscale_method: "lanczos", width: 1920, height: 1080, crop: "center" });
  assert.deepEqual(g["4"], { class_type: "SeedVR2Preprocess", inputs: { resized_images: ["3", 0] } });
  assert.deepEqual(g["5"]!.inputs, { unet_name: "seedvr2_3b_int8_convrot.safetensors", weight_dtype: "default" });
  assert.deepEqual(g["6"]!.inputs, { vae_name: "seedvr2_ema_vae_fp16.safetensors" });
  const tiling = { tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 };
  assert.deepEqual(g["7"], { class_type: "VAEEncodeTiled", inputs: { pixels: ["4", 0], vae: ["6", 0], ...tiling } });
  assert.deepEqual(g["8"]!.inputs, { latent: ["7", 0], temporal_overlap: 1, chunking_mode: "manual", "chunking_mode.frames_per_chunk": 9 });
  assert.deepEqual(g["9"]!.inputs, { model: ["5", 0], vae_conditioning: ["8", 0] });
  assert.deepEqual(g["10"]!.inputs, {
    model: ["5", 0], seed: 0, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple",
    positive: ["9", 0], negative: ["9", 1], latent_image: ["8", 0], denoise: 1,
  });
  assert.deepEqual(g["11"]!.inputs, { latents: ["10", 0], temporal_overlap: ["8", 1] });
  assert.deepEqual(g["12"], { class_type: "VAEDecodeTiled", inputs: { samples: ["11", 0], vae: ["6", 0], ...tiling } });
  assert.deepEqual(g["13"]!.inputs, { images: ["12", 0], original_resized_images: ["3", 0], color_correction_method: "lab" });
  // The source's frame rate and sound go back in untouched.
  assert.deepEqual(g["14"]!.inputs, { images: ["13", 0], fps: ["2", 2], audio: ["2", 1] });
  assert.deepEqual(g["15"]!.inputs, { video: ["14", 0], filename_prefix: "arke-upscale", format: "mp4", codec: "h264" });
  assert.equal(recipe.outputNode, "15");
  assert.equal(recipe.outputPrefix, "arke-upscale");
  assert.deepEqual(recipe.requires.customNodes, []);
  assert.deepEqual(recipeNodeClasses(recipe).filter((name) => name.startsWith("SeedVR2")), [
    "SeedVR2Conditioning", "SeedVR2PostProcessing", "SeedVR2Preprocess", "SeedVR2TemporalChunk", "SeedVR2TemporalMerge",
  ]);
});

test("the weights are pinned to a Comfy-Org/SeedVR2 revision by sha256, and the floor is 0.38", () => {
  assert.deepEqual(recipe.engine, { minVersion: "0.38.0", exercisedThroughVersion: "0.38.1" });
  const revision = "https://huggingface.co/Comfy-Org/SeedVR2/resolve/df48879708206a403d2a61acd55578c2e80fd233";
  assert.deepEqual(recipe.requires.checkpoints.map(({ file, sha256, url }) => ({ file, sha256, url })), [
    {
      file: "diffusion_models/seedvr2_3b_int8_convrot.safetensors",
      sha256: "c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157",
      url: `${revision}/diffusion_models/seedvr2_3b_int8_convrot.safetensors`,
    },
    {
      file: "vae/seedvr2_ema_vae_fp16.safetensors",
      sha256: "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1",
      url: `${revision}/vae/seedvr2_ema_vae_fp16.safetensors`,
    },
  ]);
  assert.match(recipe.hardware.floorSource, /14\.3 min/);
  assert.equal(recipe.hardware.minMemMb, 30720, "system RAM was the tight resource");
});

test("the row is an upscaler: video by what it makes, never a pick or a fallback", () => {
  const row = COMFYUI_MANIFEST_MODELS.find((model) => model.id === recipe.id)!;
  assert.ok(ManifestModelSchema.safeParse(row).success);
  assert.deepEqual(row.upscale, { size: "1080p", minEngineVersion: recipe.engine.minVersion });
  assert.equal(isUpscaler(row), true);
  assert.equal(row.capability, "video");
  assert.equal(COMFYUI_MANIFEST_MODELS.filter(isUpscaler).length, 1);
  assert.notEqual(modelForCapability(SHIPPED_MANIFEST, { video: recipe.id }, "video")?.id, recipe.id);
  assert.notEqual(modelForCapability({ ...SHIPPED_MANIFEST, models: [row, ...SHIPPED_MANIFEST.models] }, null, "video")?.id, recipe.id);
  assert.ok(!(SHIPPED_MANIFEST.localPreference?.video ?? []).includes(recipe.id), "never recommended as a video model");
});

test("an upscale sends one MP4 under its content name, the frame by orientation, and no prompt", async () => {
  for (const [aspect, width, height] of [["16:9", 1920, 1080], ["9:16", 1080, 1920]] as const) {
    const { client, graphs, uploads } = engine();
    await client.submit("", request({ aspect }));
    assert.equal(uploads.length, 1);
    assert.match(uploads[0]!, /^[0-9a-f]{64}\.mp4$/, "LoadVideo lists only a file with a known extension");
    const graph = graphs[0]!;
    assert.equal(graph["1"]!.inputs["file"], uploads[0]);
    assert.equal(graph["3"]!.inputs["width"], width);
    assert.equal(graph["3"]!.inputs["height"], height);
    assert.equal(graph["10"]!.inputs["seed"], 11);
    assert.deepEqual(Object.keys(graph).sort(), Object.keys(recipe.graph).sort(), "nothing added, nothing dropped");
  }
});

test("refuses a changed source, a second input, another size or a prompt before anything is sent", async () => {
  const cases: Array<[SubmitRequest, RegExp]> = [
    [request({ sourceHash: "sha256:0000000000000000" }), /source has changed/],
    [request({}, { videoReferences: [] }), /exactly one source video/],
    [request({}, { imageReferences: [{ name: "a.png", contentType: "image/png", data: clip }] }), /takes one video and nothing else|takes no reference images/],
    [request({}, { videoReferences: [{ name: "a.webm", contentType: "video/webm", data: clip }] }), /needs an MP4 source/],
    [request({ size: "4k" }), /1080p|must be one of/],
    [request({ aspect: "1:1" }), /16:9 or 9:16|must be one of/],
    [request({ prompt: "make it sharper" }), /takes no prompt/],
  ];
  for (const [sent, refused] of cases) {
    const { client, calls } = engine();
    await assert.rejects(client.submit("", sent), refused);
    assert.equal(calls.some((url) => url.endsWith("/prompt") || url.endsWith("/upload/image")), false);
  }
});

test("the scalars bind and refuse like any recipe's, with the source name filled only after upload", () => {
  const graph = substituteRecipeParams(recipe, { size: "1080p", aspect: "16:9", seed: 3, width: 1920, height: 1080 });
  assert.equal(graph["1"]!.inputs["file"], "");
  assert.throws(() => substituteRecipeParams(recipe, { width: 3840, height: 2160 }), /is over 1920/);
});

test("only what SaveVideo saved under the recipe's prefix is fetched, never the input's preview", async () => {
  const { client, calls } = engine({
    upscale: {
      outputs: {
        "15": {
          images: [
            { filename: "input-preview.mp4", subfolder: "", type: "temp" },
            { filename: "arke-upscale_00001_.mp4", subfolder: "video", type: "output" },
          ],
        },
      },
    },
  });
  const files = await client.fetchArtifacts("", "upscale", { model: recipe.id } as never);
  assert.deepEqual(files.map((file) => file.name), ["output-1.mp4"]);
  assert.equal(calls.filter((url) => url.includes("/view?")).length, 1);
  assert.ok(calls.some((url) => url.includes("arke-upscale_00001_.mp4")));
});
