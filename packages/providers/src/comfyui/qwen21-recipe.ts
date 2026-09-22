import type { ComfyUiRecipe } from "./recipes.js";

const SOURCE = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921";

/** Only the canvas measured on the reference 10 GB card is offered in v1. */
export const QWEN21_BUCKETS = { "1:1": { width: 1024, height: 1024 } };

/** SPEC-021 R-2/R-13/R-16: a separate, pinned recipe preserves existing Krea/SDXL jobs. */
export const QWEN21_IMAGE: ComfyUiRecipe = {
  id: "comfyui-qwen21-image",
  capability: "image",
  displayName: "Qwen Image 2.1 · Research",
  recipeVersion: 1,
  engine: { minVersion: "0.37.0", exercisedThroughVersion: "0.37.0" },
  params: {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["4", "prompt"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["6", "seed"]] },
    width: { kind: "int", internal: true, required: true, min: 1024, max: 1024, bind: [["5", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 1024, max: 1024, bind: [["5", "height"]] },
    reference1: { kind: "string", internal: true, maxChars: 260, bind: [["11", "image"]] },
  },
  graph: {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "4": { class_type: "TextEncodeQwenImage21", inputs: {
      clip: ["2", 0], vae: ["3", 0], prompt: "", negative_prompt: "", resolution: 1024,
      "images.image_1": ["31", 0],
    } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "KSampler", inputs: {
      model: ["10", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["4", 2],
      seed: 0, steps: 40, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
    } },
    "7": { class_type: "VAEDecodeTiled", inputs: { samples: ["6", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "arke-qwen21" } },
    "9": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "off", dtype: "default" } },
    "10": { class_type: "ArkeQwen21Runtime", inputs: { model: ["9", 0] } },
    "11": { class_type: "LoadImage", inputs: { image: "" } },
    // LoadImage separates alpha from RGB. Rejoin before encoding or transparent pixels'
    // hidden purple background becomes reference content. Crop, never stretch, to the canvas.
    "21": { class_type: "JoinImageWithAlpha", inputs: { image: ["11", 0], alpha: ["11", 1] } },
    "31": { class_type: "ImageScale", inputs: { image: ["21", 0], upscale_method: "lanczos", width: 1024, height: 1024, crop: "center" } },
  },
  referenceImages: [
    { param: "reference1", nodes: ["11", "21", "31"], slot: ["4", "images.image_1"] },
  ],
  // Editing must sample at the encoder's first-reference size. With no reference, the
  // declared empty canvas supplies the latent; positive and negative stay on the same node.
  referenceConditioning: { nodes: [], slot: ["6", "latent_image"], textOnly: ["5", 0] },
  outputNode: "8",
  requires: {
    checkpoints: [
      { file: "diffusion_models/qwen_image_2.1_int8_convrot.safetensors", sha256: "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d", sizeMb: 7257, url: `${SOURCE}/diffusion_models/qwen_image_2.1_int8_convrot.safetensors` },
      { file: "text_encoders/qwen3vl_8b_int8_convrot.safetensors", sha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f", sizeMb: 9351, url: `${SOURCE}/text_encoders/qwen3vl_8b_int8_convrot.safetensors` },
      { file: "vae/qwen_image_2.1_vae_bf16.safetensors", sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9", sizeMb: 676, url: `${SOURCE}/vae/qwen_image_2.1_vae_bf16.safetensors` },
    ],
    customNodes: [{ id: "ArkeQwen21Runtime", pinnedRef: "6a383324bdb2e4ee68935dc4873415b6f28c288eb5907ac0a05ab0c19a3849e1" }],
  },
  hardware: {
    minVramMb: 10240, minFreeVramMb: 6500, recommendedVramMb: 16384,
    minMemMb: 30720, minFreeMemMb: 10000,
    floorSource: "RTX 3080 10 GB / 32 GB Windows, ComfyUI 0.37.0 conservative profile; 1K repeated text and reference edit, about 9972 MiB RAM free before edit and 753 MiB minimum during it. Admission rounds up to 10000 MiB; see docs/development/qwen21.md.",
  },
};
