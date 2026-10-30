import type { ManifestModel } from "@arke-studio/contracts";
import type { ComfyUiRecipe, RecipeCheckpoint, RecipeGraph, RecipeParamSpec } from "./recipes.js";

const h3Source = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/a98869194787969724c7425d95d0ed73ce9202af";
const pikaSource = "https://huggingface.co/Pika-Labs/Pika-H3-Flex/resolve/3ff166447d5edb1406107ab8370c42000ce173e4/comfy/loras";
const shared: readonly RecipeCheckpoint[] = [
  { file: "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", sha256: "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6", sizeMb: 14961, url: `${h3Source}/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` },
  { file: "vae/minimax_h3_video_vae_fp16.safetensors", sha256: "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522", sizeMb: 4967, url: `${h3Source}/vae/minimax_h3_video_vae_fp16.safetensors` },
  { file: "vae/minimax_h3_audio_vae_fp32.safetensors", sha256: "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48", sizeMb: 577, url: `${h3Source}/vae/minimax_h3_audio_vae_fp32.safetensors` },
];
const dimensions480 = { "16:9": { width: 864, height: 480 }, "9:16": { width: 480, height: 864 } };
const dimensions768 = { "16:9": { width: 1344, height: 768 }, "9:16": { width: 768, height: 1344 } };
const frames: Record<string, number> = { "5": 124, "10": 243, "15": 362 };

interface Preset {
  id: string;
  displayName: string;
  reference: boolean;
  resolution: "480p" | "768p";
  seconds: readonly number[];
  typicalRunSec: number;
}

/** SPEC-021 R-2/R-3: the measured Pika presets are separate identities from H3's turbo recipes. */
function author(preset: Preset) {
  const { id, displayName, reference, resolution, seconds } = preset;
  const dimensions = resolution === "480p" ? dimensions480 : dimensions768;
  const canvas = dimensions["16:9"];
  const backbone = reference ? "ref2va" : "fl2va";
  const diffusion = `minimax_h3_${backbone}_pruned_int8_convrot.safetensors`;
  const lora = `pika_h3_flex_${backbone}_comfy_bf16.safetensors`;
  const checkpoints: RecipeCheckpoint[] = [
    { file: `diffusion_models/${diffusion}`, sha256: reference ? "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779" : "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a", sizeMb: 20000, url: `${h3Source}/diffusion_models/${diffusion}` },
    ...shared,
    { file: `loras/${lora}`, sha256: reference ? "e4d058fbd027377b925a0ee607b514ddd9037873fee3afa05d73b302e6f7f8e1" : "68783e6447696ec365d13c0554941e070bee4cfea13c37da52498ec4f9a53f89", sizeMb: 1866, url: `${pikaSource}/${lora}` },
  ];
  const params: Record<string, RecipeParamSpec> = {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["7", "prompt"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["15", "noise_seed"]] },
    durationSec: { kind: "number-enum", values: seconds, bind: [] },
    aspect: { kind: "string-enum", values: Object.keys(dimensions), bind: [] },
    width: { kind: "int", required: true, internal: true, min: Math.min(canvas.width, canvas.height), max: Math.max(canvas.width, canvas.height), bind: [["7", "width"], ...(!reference ? [["18", "width"]] as const : [])] },
    height: { kind: "int", required: true, internal: true, min: Math.min(canvas.width, canvas.height), max: Math.max(canvas.width, canvas.height), bind: [["7", "height"], ...(!reference ? [["18", "height"]] as const : [])] },
    length: { kind: "int", required: true, internal: true, min: 124, max: frames[String(Math.max(...seconds))]!, bind: [["7", "length"]] },
    referenceFile: { kind: "string", internal: true, maxChars: 260, bind: [["14", "image"]] },
  };
  // The released adapter's six-step LCM schedule is fixed. Generic H3 sampling and additional
  // adapters are deliberately undeclared: either would change the distillation contract.
  const graph: RecipeGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: diffusion, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: lora, strength_model: 1 } },
    "3": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["2", 0], shift_video: 12, shift_audio: 3 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "7": { class_type: reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", inputs: {
      clip: ["4", 0], vae: ["5", 0], prompt: "", ...canvas, length: 124,
      ...(reference ? { audio_vae: ["6", 0], ref_image_size: "match", "ref_images.ref_image_0": ["14", 0] } : { first_frame: ["18", 0] }),
    } },
    "8": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["7", 0] } },
    "9": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["15", 0], guider: ["8", 0], sampler: ["16", 0], sigmas: ["17", 0], latent_image: ["7", 1] } },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["5", 0] } },
    "11": { class_type: "VAEDecodeAudio", inputs: { samples: ["9", 0], vae: ["6", 0] } },
    "12": { class_type: "CreateVideo", inputs: { images: ["10", 0], audio: ["11", 0], fps: 24 } },
    "13": { class_type: "SaveVideo", inputs: { video: ["12", 0], filename_prefix: `arke-${id}`, format: "mp4", codec: "h264" } },
    "14": { class_type: "LoadImage", inputs: { image: "" } },
    "15": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
    "16": { class_type: "KSamplerSelect", inputs: { sampler_name: "lcm" } },
    "17": { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0" } },
  };
  if (!reference) graph["18"] = { class_type: "ImageScale", inputs: { image: ["14", 0], upscale_method: "lanczos", ...canvas, crop: "center" } };
  const attachment: NonNullable<ComfyUiRecipe["referenceFrame"]> = reference
    ? { param: "referenceFile", nodes: ["14"], slot: ["7", "ref_images.ref_image_0"] }
    : { param: "referenceFile", nodes: ["14", "18"], slot: ["7", "first_frame"] };
  const recipe: ComfyUiRecipe = {
    id, displayName, capability: "video", recipeVersion: 1,
    engine: { minVersion: "0.38.0", exercisedThroughVersion: "0.38.0" },
    params, graph, ...(reference ? { referenceImages: [attachment] } : { referenceFrame: attachment }),
    outputNode: "13", outputPrefix: `arke-${id}`,
    requires: { checkpoints, customNodes: [] },
    hardware: { accelerator: "cuda", minVramMb: 10000, recommendedVramMb: 10000, minMemMb: 30720,
      floorSource: "Measured 2026-10-30 on RTX 3080 10 GiB / approximately 32 GiB RAM, ComfyUI 0.38.0, INT8-convrot H3, NVFP4 encoder, FP16 video VAE and BF16 Pika adapter. Six-step LCM; one synthetic fixture/seed and at most one picture. 480p 5/10/15s and 768p 5s completed within 20 minutes. Lower hardware and maximum upstream reference counts are unmeasured; see the Pika setup note." },
  };
  const model: ManifestModel = {
    id, displayName, provider: "comfyui", capability: "video", family: "minimax-h3",
    accepts: { referenceImages: 1, referenceRoles: false, startFrame: false, endFrame: false },
    ...(!reference ? { modes: { generate: { locked: [] }, "first-frame": { locked: [] } } } : {}),
    limits: { maxPromptChars: 2000, alwaysSound: true, maxDurationSec: Math.max(...seconds),
      durations: Object.fromEntries(seconds.map(second => [String(second), String(second)])), durationWire: "number",
      resolutions: [resolution], aspects: Object.keys(dimensions), ...(reference ? { referenceSyntax: "minimax-h3", maxCombinedReferences: 1 } : {}),
    },
    speechVideo: "untested", pricing: { kind: "unmetered", typicalRunSec: preset.typicalRunSec },
    requires: { vramMb: recipe.hardware.minVramMb, recommendedVramMb: recipe.hardware.recommendedVramMb,
      memMb: recipe.hardware.minMemMb!, diskMb: checkpoints.reduce((sum, file) => sum + file.sizeMb, 0), accelerator: ["cuda"] },
  };
  return { recipe, model, derivation: { dimensions, framesBySeconds: Object.fromEntries(seconds.map(second => [String(second), frames[String(second)]!])) } };
}

const presets: Preset[] = [
  { id: "comfyui-pika-h3-flex", displayName: "Local · Pika H3 Flex", reference: false, resolution: "480p", seconds: [5, 10, 15], typicalRunSec: 840 },
  { id: "comfyui-pika-h3-flex-768", displayName: "Local · Pika H3 Flex 768p", reference: false, resolution: "768p", seconds: [5], typicalRunSec: 850 },
  { id: "comfyui-pika-h3-flex-reference", displayName: "Local · Pika H3 Flex Reference", reference: true, resolution: "480p", seconds: [5, 15], typicalRunSec: 700 },
  { id: "comfyui-pika-h3-flex-reference-768", displayName: "Local · Pika H3 Flex Reference 768p", reference: true, resolution: "768p", seconds: [5], typicalRunSec: 890 },
];
const authored = presets.map(author);

export const PIKA_H3_FLEX_RECIPES = authored.map(entry => entry.recipe);
export const PIKA_H3_FLEX_MODELS = authored.map(entry => entry.model);
export const PIKA_H3_FLEX_DERIVATIONS = Object.fromEntries(authored.map(entry => [entry.recipe.id, entry.derivation]));
