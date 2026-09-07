import type { ManifestModel } from "@arke-studio/contracts";
import type { ComfyUiRecipe, RecipeGraph, RecipeParamSpec } from "./recipes.js";

const source = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/a98869194787969724c7425d95d0ed73ce9202af";
const params: Record<string, RecipeParamSpec> = {
  prompt: { kind: "string", required: true, maxChars: 8000, bind: [["7", "prompt"]] },
  seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["9", "seed"]] },
  durationSec: { kind: "number-enum", values: [5], bind: [] },
  aspect: { kind: "string-enum", values: ["16:9", "9:16"], bind: [] },
  width: { kind: "int", required: true, internal: true, min: 480, max: 864, bind: [["7", "width"]] },
  height: { kind: "int", required: true, internal: true, min: 480, max: 864, bind: [["7", "height"]] },
  length: { kind: "int", required: true, internal: true, min: 124, max: 124, bind: [["7", "length"]] },
};
const graph: RecipeGraph = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
  "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", strength_model: 1 } },
  "3": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["2", 0], shift_video: 12, shift_audio: 3 } },
  "4": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
  "5": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
  "6": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
  "7": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { clip: ["4", 0], vae: ["5", 0], audio_vae: ["6", 0], prompt: "", width: 864, height: 480, length: 124, ref_image_size: "match" } },
  "8": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
  "9": { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["7", 0], negative: ["8", 0], latent_image: ["7", 1], seed: 0, steps: 4, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1 } },
  "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["5", 0] } },
  "11": { class_type: "VAEDecodeAudio", inputs: { samples: ["9", 0], vae: ["6", 0] } },
  "12": { class_type: "CreateVideo", inputs: { images: ["10", 0], audio: ["11", 0], fps: 24 } },
  "13": { class_type: "SaveVideo", inputs: { video: ["12", 0], filename_prefix: "arke-h3-reference", format: "mp4", codec: "h264" } },
};
type Attachment = NonNullable<ComfyUiRecipe["referenceFrame"]>;
const images: Attachment[] = [], videos: Attachment[] = [], audio: Attachment[] = [];
for (let i = 0; i < 9; i++) {
  const node = String(20 + i), param = `referenceImage${i}`, slot = `ref_images.ref_image_${i}`;
  params[param] = { kind: "string", internal: true, maxChars: 260, bind: [[node, "image"]] };
  graph[node] = { class_type: "LoadImage", inputs: { image: "" } };
  graph["7"]!.inputs[slot] = [node, 0];
  images.push({ param, nodes: [node], slot: ["7", slot] });
}
for (let i = 0; i < 3; i++) {
  const node = String(40 + i), split = String(50 + i), param = `referenceVideo${i}`, slot = `ref_videos.ref_video_${i}`;
  params[param] = { kind: "string", internal: true, maxChars: 260, bind: [[node, "file"]] };
  graph[node] = { class_type: "LoadVideo", inputs: { file: "" } };
  graph[split] = { class_type: "GetVideoComponents", inputs: { video: [node, 0] } };
  graph["7"]!.inputs[slot] = [split, 0];
  graph["7"]!.inputs[`ref_video_audios.ref_video_audio_${i}`] = [split, 1];
  videos.push({ param, nodes: [node, split], slot: ["7", slot], extraSlots: [["7", `ref_video_audios.ref_video_audio_${i}`]] });
  const audioNode = String(60 + i), audioParam = `referenceAudio${i}`, audioSlot = `ref_audios.ref_audio_${i}`;
  params[audioParam] = { kind: "string", internal: true, maxChars: 260, bind: [[audioNode, "audio"]] };
  graph[audioNode] = { class_type: "LoadAudio", inputs: { audio: "" } };
  graph["7"]!.inputs[audioSlot] = [audioNode, 0];
  audio.push({ param: audioParam, nodes: [audioNode], slot: ["7", audioSlot] });
}

/** Native R2V is a separate checkpoint from FL2VA. Bindings are included in recipe identity,
 * including soundtrack slots; dropping an unused video must drop both of its consumers. */
export const H3_REFERENCE: ComfyUiRecipe = {
  id: "comfyui-h3-reference-video", displayName: "Local · H3 Reference Video", capability: "video", recipeVersion: 1,
  engine: { minVersion: "0.33.1", exercisedThroughVersion: "0.33.1" },
  params, graph, referenceImages: images, referenceVideos: videos, referenceAudio: audio, outputNode: "13",
  requires: { customNodes: [], checkpoints: [
    { file: "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", sha256: "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779", sizeMb: 20000, url: `${source}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` },
    { file: "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", sha256: "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6", sizeMb: 14961, url: `${source}/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` },
    { file: "vae/minimax_h3_video_vae_fp16.safetensors", sha256: "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522", sizeMb: 4967, url: `${source}/vae/minimax_h3_video_vae_fp16.safetensors` },
    { file: "vae/minimax_h3_audio_vae_fp32.safetensors", sha256: "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48", sizeMb: 577, url: `${source}/vae/minimax_h3_audio_vae_fp32.safetensors` },
    { file: "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", sha256: "5b9ab5ade15d0775676d01a907268a69a1468dc6033b3b0d3ded5502f3ebb84c", sizeMb: 1866, url: `${source}/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` },
  ] },
  hardware: { minVramMb: 10000, minFreeVramMb: 4000, recommendedVramMb: 24000, minMemMb: 30720, minFreeMemMb: 4096,
    floorSource: "Mixed R2V verified 2026-09-07 on RTX 3080 10 GB / 32 GB RAM: two images, one 2s video with soundtrack and one 2s audio; 864×480×124 at four steps completed in 657s. Free RAM started at 4133 MiB and bottomed at 407 MiB. The 4 GB free-VRAM guard remains conservative from FL2VA; maximum-reference memory use is not measured." },
};

export const H3_REFERENCE_MODEL: ManifestModel = {
  id: H3_REFERENCE.id, displayName: H3_REFERENCE.displayName, provider: "comfyui", capability: "video",
  family: "minimax-h3",
  accepts: { referenceImages: 9, referenceVideos: 3, referenceAudio: 3, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { referenceSyntax: "minimax-h3", maxPromptChars: 8000, alwaysSound: true,
    maxDurationSec: 5, durations: { "5": "5" }, durationWire: "number", resolutions: ["480p"], aspects: ["16:9", "9:16"],
    maxReferenceVideoSec: 15, minReferenceVideoFileSec: 2, maxReferenceVideoFileSec: 5.2,
    maxReferenceAudioSec: 15, maxReferenceAudioFileSec: 5.2, maxCombinedReferences: 15 },
  speechVideo: "untested", pricing: { kind: "unmetered", typicalRunSec: 657 },
  requires: { vramMb: 10000, recommendedVramMb: 24000, memMb: 30720, diskMb: 42371, accelerator: ["cuda"] },
};
