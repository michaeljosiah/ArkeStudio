import type { ComfyUiRecipe } from "./recipes.js";

const SOURCE = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921";

/**
 * The 2K tier, and the default: the publisher's recommended native canvases (QwenLM/Qwen-Image-2.1
 * README). 16:9 at 2752×1536 is larger than the audiobook's 1080p frame, so nothing is upscaled.
 * Each was run on the reference 10 GB card through the ordinary engine (2026-10-10).
 */
export const QWEN21_BUCKETS_2K: Record<string, { width: number; height: number }> = {
  "1:1": { width: 2048, height: 2048 },
  "16:9": { width: 2752, height: 1536 },
  "9:16": { width: 1536, height: 2752 },
  "4:3": { width: 2400, height: 1792 },
  "3:4": { width: 1792, height: 2400 },
};

/**
 * The 1K tier: Qwen-Image's canvases near 1.5 megapixels, about 2.5 times quicker than 2K with
 * the same likeness and less detail. v1 offered 1024² only, under the conservative profile.
 */
export const QWEN21_BUCKETS_1K: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1328, height: 1328 },
  "16:9": { width: 1664, height: 928 },
  "9:16": { width: 928, height: 1664 },
  "4:3": { width: 1472, height: 1104 },
  "3:4": { width: 1104, height: 1472 },
};

/** Each tier's canvases by the resolution word the manifest row declares for it. */
export const QWEN21_TIER_BUCKETS: Record<string, Record<string, { width: number; height: number }>> = {
  "2752": QWEN21_BUCKETS_2K,
  "1664": QWEN21_BUCKETS_1K,
};

/** One carrier pair per picture: the file, then its alpha rejoined before encoding. */
const carriers = (n: number) => ({
  [`1${n}`]: { class_type: "LoadImage", inputs: { image: "" } },
  // LoadImage separates alpha from RGB. Rejoin before encoding or transparent pixels'
  // hidden purple background becomes reference content.
  [`2${n}`]: { class_type: "JoinImageWithAlpha", inputs: { image: [`1${n}`, 0], alpha: [`1${n}`, 1] } },
});

/**
 * SPEC-021 R-2/R-13/R-16. Version 2 (2026-10-10) runs on the ordinary engine: ComfyUI 0.38.1
 * completed text and one- to three-picture jobs back to back without the conservative profile,
 * its runtime guard or the prefix-cache workaround v1 needed on 0.37.0. Pictures keep their own
 * shape — the encoder scales each to about 1024² at multiples of 32 — and the canvas comes from
 * the chosen aspect, so a reference says who is in the picture rather than how it is framed.
 *
 * Three pictures, not the encoder's ten: a woman, a man and a place each kept their identity, but
 * with four (a woman, two men and a place) the second man's face replaced the first's — two
 * copies of one man. Likeness is this recipe's reason for being, so it offers what held.
 */
export const QWEN21_IMAGE: ComfyUiRecipe = {
  id: "comfyui-qwen21-image",
  capability: "image",
  displayName: "Qwen Image 2.1 · Research",
  recipeVersion: 2,
  // 0.38.0 is the managed pin (R-21); the ordinary-engine runs above were on 0.38.1.
  engine: { minVersion: "0.38.0", exercisedThroughVersion: "0.38.1" },
  params: {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["4", "prompt"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["6", "seed"]] },
    width: { kind: "int", internal: true, required: true, min: 928, max: 2752, bind: [["5", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 928, max: 2752, bind: [["5", "height"]] },
    reference1: { kind: "string", internal: true, maxChars: 260, bind: [["11", "image"]] },
    reference2: { kind: "string", internal: true, maxChars: 260, bind: [["12", "image"]] },
    reference3: { kind: "string", internal: true, maxChars: 260, bind: [["13", "image"]] },
  },
  graph: {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "4": { class_type: "TextEncodeQwenImage21", inputs: {
      clip: ["2", 0], vae: ["3", 0], prompt: "", negative_prompt: "", resolution: 1024,
      "images.image_1": ["21", 0], "images.image_2": ["22", 0], "images.image_3": ["23", 0],
    } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 2752, height: 1536, batch_size: 1 } },
    "6": { class_type: "KSampler", inputs: {
      model: ["9", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0],
      // The publisher's own default. ComfyUI's template samples 25, which held the likeness
      // too, but at 2K 40 drew the brows, lips and skin closer to the reference on the same seed
      // (204 s against 132 s on the reference card).
      seed: 0, steps: 40, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
    } },
    "7": { class_type: "VAEDecodeTiled", inputs: { samples: ["6", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "arke-qwen21" } },
    "9": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } },
    ...carriers(1), ...carriers(2), ...carriers(3),
  },
  referenceImages: [1, 2, 3].map(n => ({ param: `reference${n}`, nodes: [`1${n}`, `2${n}`], slot: ["4", `images.image_${n}`] as const })),
  outputNode: "8",
  requires: {
    checkpoints: [
      { file: "diffusion_models/qwen_image_2.1_int8_convrot.safetensors", sha256: "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d", sizeMb: 7257, url: `${SOURCE}/diffusion_models/qwen_image_2.1_int8_convrot.safetensors` },
      { file: "text_encoders/qwen3vl_8b_int8_convrot.safetensors", sha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f", sizeMb: 9351, url: `${SOURCE}/text_encoders/qwen3vl_8b_int8_convrot.safetensors` },
      { file: "vae/qwen_image_2.1_vae_bf16.safetensors", sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9", sizeMb: 676, url: `${SOURCE}/vae/qwen_image_2.1_vae_bf16.safetensors` },
    ],
    customNodes: [],
  },
  hardware: {
    accelerator: "cuda", minVramMb: 10240, minFreeVramMb: 6500, recommendedVramMb: 16384,
    minMemMb: 30720, minFreeMemMb: 10000,
    floorSource: "RTX 3080 10 GB / 32 GB Windows, ComfyUI 0.38.1 ordinary engine, 2026-10-10: every 2K canvas at 40 steps in 199–237 s, and text and one- to three-reference jobs at 1K, at a 9.4–9.7 GB whole-card peak; available RAM fell to tens of MiB while the models loaded on a busy desktop. Admission keeps v1's free-memory floors; see docs/development/qwen21.md.",
  },
};
