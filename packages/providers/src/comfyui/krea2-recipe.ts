import type { ComfyUiRecipe } from "./recipes.js";

const MODEL_SOURCE = "https://huggingface.co/Comfy-Org/Krea-2/resolve/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96";

/** Native 2K canvases, all divisible by the model's spatial stride. */
export const KREA2_BUCKETS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 2048, height: 2048 },
  "16:9": { width: 2048, height: 1152 },
  "9:16": { width: 1152, height: 2048 },
  "4:3": { width: 2048, height: 1536 },
  "3:4": { width: 1536, height: 2048 },
};

/**
 * The local Krea 2 Turbo image-edit workflow, using the installed FP8 variants. A separate
 * identity preserves SDXL jobs and their provenance. References condition the image encoder;
 * they are not starting latents or style references sent to Krea's hosted API (SPEC-021 §2.3).
 */
export const KREA2_IMAGE: ComfyUiRecipe = {
  id: "comfyui-krea2-image",
  capability: "image",
  displayName: "Krea 2",
  recipeVersion: 1,
  engine: { minVersion: "0.33.1", exercisedThroughVersion: "0.33.1" },
  params: {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["6", "text"], ["16", "text"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["3", "seed"]] },
    width: { kind: "int", internal: true, required: true, min: 1152, max: 2048, bind: [["5", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 1152, max: 2048, bind: [["5", "height"]] },
    reference1: { kind: "string", internal: true, maxChars: 260, bind: [["20", "image"]] },
    reference2: { kind: "string", internal: true, maxChars: 260, bind: [["21", "image"]] },
    reference3: { kind: "string", internal: true, maxChars: 260, bind: [["22", "image"]] },
    reference4: { kind: "string", internal: true, maxChars: 260, bind: [["23", "image"]] },
  },
  graph: {
    "10": { class_type: "UNETLoader", inputs: { unet_name: "krea2_turbo_fp8_scaled.safetensors", weight_dtype: "default" } },
    "11": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" } },
    "12": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["11", 0], text: "" } },
    "16": {
      class_type: "Krea2EditRebalance",
      inputs: {
        clip: ["11", 0], text: "", refocus_strength: 0.8, guidance_strength: 0.5,
        enable_split: true,
        image1: ["20", 0], image2: ["21", 0], image3: ["22", 0], image4: ["23", 0],
        image1_tokens: "normal", image2_tokens: "normal", image3_tokens: "normal", image4_tokens: "normal",
      },
    },
    "13": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 2048, height: 2048, batch_size: 1 } },
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["10", 0], positive: ["16", 0], negative: ["13", 0], latent_image: ["5", 0],
        // The publisher's eight-step baseline left strong residual noise at 2048² on the
        // reference RTX 3080. Sixteen steps resolved it with the same prompt, seed and weights.
        seed: 0, steps: 16, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["12", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "arke-krea2" } },
    "20": { class_type: "LoadImage", inputs: { image: "" } },
    "21": { class_type: "LoadImage", inputs: { image: "" } },
    "22": { class_type: "LoadImage", inputs: { image: "" } },
    "23": { class_type: "LoadImage", inputs: { image: "" } },
  },
  referenceImages: [
    { param: "reference1", nodes: ["20"], slot: ["16", "image1"] },
    { param: "reference2", nodes: ["21"], slot: ["16", "image2"] },
    { param: "reference3", nodes: ["22"], slot: ["16", "image3"] },
    { param: "reference4", nodes: ["23"], slot: ["16", "image4"] },
  ],
  referenceConditioning: { nodes: ["16"], slot: ["3", "positive"], textOnly: ["6", 0] },
  outputNode: "9",
  requires: {
    checkpoints: [
      {
        file: "diffusion_models/krea2_turbo_fp8_scaled.safetensors",
        sha256: "eb4dd8c612cfd10f64f25b057e6e6bbcb5737c94a7372177e456dbf7579502f1",
        sizeMb: 12533,
        url: `${MODEL_SOURCE}/diffusion_models/krea2_turbo_fp8_scaled.safetensors`,
      },
      {
        file: "text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
        sha256: "54bd5144df0bbc25dd6ccadfcb826b521445a1b06ae5a42570bdd2974ca87094",
        sizeMb: 5000,
        url: `${MODEL_SOURCE}/text_encoders/qwen3vl_4b_fp8_scaled.safetensors`,
      },
      {
        file: "vae/qwen_image_vae.safetensors",
        sha256: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
        sizeMb: 243,
        url: `${MODEL_SOURCE}/vae/qwen_image_vae.safetensors`,
      },
    ],
    customNodes: [{ id: "ComfyUI-ConditioningKrea2Rebalance", pinnedRef: "a0cd00681448ab63232463c83f12e0364456da59" }],
  },
  hardware: {
    minVramMb: 10240,
    minFreeVramMb: 4000,
    recommendedVramMb: 16384,
    minMemMb: 30720,
    floorSource: "2K text and one-reference runs verified on RTX 3080 10 GB, 32 GB system RAM; FP8 weights with CPU offload; free-VRAM floor is conservative",
  },
};
