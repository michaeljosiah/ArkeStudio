import { createHash } from "node:crypto";
import type { ManifestModel, RecipeIdentity } from "@arke-studio/contracts";

/**
 * The recipe catalogue (SPEC-021 §2.3): hand-authored, shipped, versioned — never fetched,
 * never user-editable. A recipe is the only unit of dispatchable work (R-1): the graph in here
 * is private to this package and the coordinator's dispatch path, and what everything else sees
 * is the manifest projection at the bottom of this file, which carries no graph at all.
 *
 * Both shipped recipes run on ComfyUI core nodes alone (D11) — that is part of why these two
 * models were chosen — so `customNodes` is empty twice over, while the verification machinery
 * that would pin one stays real and tested.
 *
 * Every digest in this file was verified against the publisher's own metadata on 2026-08-18
 * (Hugging Face LFS oids — the sha256 of the exact bytes served). Changing any pinned value,
 * any graph, or any binding is a new `recipeVersion`, never an edit in place (§2.3).
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One node of an API-format prompt graph: a class and its inputs. Links are [nodeId, output]. */
export interface RecipeGraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type RecipeGraph = Record<string, RecipeGraphNode>;

/**
 * One parameter a recipe accepts. `bind` names the exact input slots the value lands in —
 * substitution can reach those slots and nothing else, which is what makes R-2's bounded
 * schema a mechanical guarantee rather than a review comment. A param with no bindings is an
 * input to the client's own derivation (aspect, seconds) and never touches the graph itself.
 * `internal` params are computed by the client (frame counts, snapped dimensions) and refused
 * from callers.
 */
export interface RecipeParamSpec {
  kind: "string" | "int" | "number-enum" | "string-enum";
  required?: boolean;
  internal?: boolean;
  maxChars?: number;
  min?: number;
  max?: number;
  values?: readonly (string | number)[];
  bind: ReadonlyArray<readonly [nodeId: string, inputKey: string]>;
}

export interface RecipeCheckpoint {
  /** Path relative to the resolved models folder — subdir is ComfyUI's own convention. */
  file: string;
  sha256: string;
  sizeMb: number;
  /** Where Arke offers to fetch it from; presence detection never needs this. */
  url: string;
}

export interface RecipeCustomNode {
  id: string;
  pinnedRef: string;
}

export interface ComfyUiRecipe {
  id: string;
  /**
   * `voice-tts` joins image and video (SPEC-021, amended 2026-08-19). Voxa covers preset speech and
   * cannot clone, so a voice whose identity is a reference clip needs a model an ONNX sidecar cannot
   * host — and everything else a recipe already gets (discovery, weights, gating, pinned nodes)
   * applies to it unchanged.
   */
  capability: "image" | "video" | "voice-tts";
  displayName: string;
  recipeVersion: number;
  params: Record<string, RecipeParamSpec>;
  graph: RecipeGraph;
  /** The one node whose outputs are fetched (§2.6) — never every image the history names. */
  outputNode: string;
  requires: {
    checkpoints: readonly RecipeCheckpoint[];
    customNodes: readonly RecipeCustomNode[];
    /**
     * A shipped graph whose complete immutable dependency closure is not yet known cannot be
     * offered as ready. This is deliberately data on the recipe rather than a UI exception: the
     * coordinator, picker and enqueue admission all consume the same refusal.
     */
    unavailableReason?: string;
  };
  hardware: {
    minVramMb: number;
    recommendedVramMb: number;
    /** Where the floor came from, so nobody mistakes a transcription for a measurement (§1.4). */
    floorSource: string;
  };
}

// ---------------------------------------------------------------------------
// The shipped pair (§2.3, D11)
// ---------------------------------------------------------------------------

const HF = "https://huggingface.co";

/**
 * Local · Draft Image — SDXL Base 1.0 on the basic text-to-image graph the engine has run
 * since 2023. One checkpoint, zero custom nodes, every class in core.
 */
const DRAFT_IMAGE: ComfyUiRecipe = {
  id: "comfyui-draft-image",
  capability: "image",
  displayName: "Local · Draft Image",
  recipeVersion: 1,
  params: {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["6", "text"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["3", "seed"]] },
    width: { kind: "int", internal: true, required: true, min: 256, max: 2048, bind: [["5", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 256, max: 2048, bind: [["5", "height"]] },
  },
  graph: {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps: 25,
        cfg: 7.0,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "7": {
      class_type: "CLIPTextEncode",
      // A fixed draft-quality negative: recipe-authoring, not a control (§2.1's test).
      inputs: { text: "blurry, deformed, watermark, text", clip: ["4", 1] },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "arke" } },
  },
  outputNode: "9",
  requires: {
    checkpoints: [
      {
        file: "checkpoints/sd_xl_base_1.0.safetensors",
        sha256: "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
        sizeMb: 6617,
        url: `${HF}/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors`,
      },
    ],
    customNodes: [],
  },
  hardware: {
    minVramMb: 6000,
    recommendedVramMb: 8000,
    floorSource: "transcribed from the model publisher's stated requirement; not yet measured on Arke reference hardware",
  },
};

/** 24 fps; a Wan latent length must be 4k+1 frames, so the offered seconds map to exactly these. */
export const WAN_FRAMES_BY_SECONDS: Record<string, number> = { "2": 49, "3": 73, "5": 121 };

/**
 * Local · Draft Video — Wan 2.2 5B (TI2V), the engine vendor's own repackaged files in their
 * documented folders, on the core node set introduced for it. Text-to-video only in v1: the
 * latent node takes an optional start image this recipe deliberately does not bind (R-2).
 */
const DRAFT_VIDEO: ComfyUiRecipe = {
  id: "comfyui-draft-video",
  capability: "video",
  displayName: "Local · Draft Video",
  recipeVersion: 1,
  params: {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["5", "text"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["8", "seed"]] },
    durationSec: { kind: "number-enum", values: [2, 3, 5], bind: [] },
    aspect: { kind: "string-enum", values: ["16:9", "9:16"], bind: [] },
    length: { kind: "int", internal: true, required: true, min: 1, max: 121, bind: [["7", "length"]] },
    width: { kind: "int", internal: true, required: true, min: 256, max: 1280, bind: [["7", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 256, max: 1280, bind: [["7", "height"]] },
  },
  graph: {
    "1": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
    },
    "2": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "wan2.2_vae.safetensors" } },
    "4": { class_type: "ModelSamplingSD3", inputs: { shift: 8.0, model: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "static, blurred, watermark, text", clip: ["1", 0] } },
    "7": {
      class_type: "Wan22ImageToVideoLatent",
      inputs: { width: 1280, height: 704, length: 121, batch_size: 1, vae: ["3", 0] },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps: 30,
        cfg: 5.0,
        sampler_name: "uni_pc",
        scheduler: "simple",
        denoise: 1,
        model: ["4", 0],
        positive: ["5", 0],
        negative: ["6", 0],
        latent_image: ["7", 0],
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: 24 } },
    "11": {
      class_type: "SaveVideo",
      inputs: { video: ["10", 0], filename_prefix: "arke", format: "mp4", codec: "h264" },
    },
  },
  outputNode: "11",
  requires: {
    checkpoints: [
      {
        file: "diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
        sha256: "456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e",
        sizeMb: 9537,
        url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`,
      },
      {
        file: "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        sha256: "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
        sizeMb: 6424,
        url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`,
      },
      {
        file: "vae/wan2.2_vae.safetensors",
        sha256: "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
        sizeMb: 1344,
        url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors`,
      },
    ],
    customNodes: [],
  },
  hardware: {
    minVramMb: 8000,
    recommendedVramMb: 12000,
    floorSource: "transcribed from the engine vendor's stated 8 GB requirement for this model; not yet measured on Arke reference hardware",
  },
};


/** 24 fps; an H3 latent length sits on the model's 17k+5 frame grid, so the offered seconds map to exactly these. */
export const H3_FRAMES_BY_SECONDS: Record<string, number> = { "5": 124, "10": 243, "15": 362 };

/**
 * Local · H3 Video — MiniMax H3 FL2VA (open-sourced 2026-08-03) with Alibaba-lineage 8-step turbo
 * distillation, on core nodes alone (D11 holds: the PDD variant of the acceleration LoRA needs a
 * custom node, so this recipe ships the Comfy-Org repackaged turbo LoRA that core loaders take).
 * The first recipe whose output carries sound: H3 generates video and stereo audio in one pass,
 * and `CreateVideo` muxes both into the same mp4 the arrival path already accepts.
 *
 * The graph was read off a running v0.33.1 engine's `/object_info` (2026-08-28), not from
 * documentation, because the t2v assembly is not where documentation points: `MiniMaxH3ImageToVideo`
 * takes the prompt as a STRING (with the clip and video VAE) and emits the positive conditioning
 * and the joint AV latent itself. With `first_frame`/`last_frame` left unbound it IS the
 * text-to-video graph — the frames stay deliberately unbound in v1 (R-2), the same doctrine as the
 * Wan draft's unbound start image. `ConditioningZeroOut` fills the sampler's required negative
 * slot; at the distilled cfg 1.0 it is never evaluated. Euler, 8 steps, cfg 1.0 and sigma shift
 * 12/3 are the distillation's own contract (guidance is baked into the adapter), and 12/3 are the
 * `MiniMaxH3SigmaShift` node's own defaults.
 *
 * File choices follow the publisher's guidance for this hardware class: `pruned_int8_convrot`
 * diffusion (adaLN tables precomputed, cu130 kernels) and the `nvfp4_awq` text encoder (no
 * Blackwell requirement). Every digest is the Hugging Face LFS oid — the sha256 of the exact bytes
 * served — read 2026-08-28. The weights are under the MiniMax H3 Community License, whose
 * territorial terms are under review; the catalogue records that fact rather than deciding it.
 *
 * Verified end to end on 2026-08-28: this exact graph produced 5.17s of 864×480 video with native
 * stereo audio on the reference RTX 3080 in 14m53s, fetched back through the same paths every
 * other recipe uses.
 */
const H3_VIDEO: ComfyUiRecipe = {
  id: "comfyui-h3-video",
  capability: "video",
  displayName: "Local · H3 Video",
  recipeVersion: 1,
  params: {
    prompt: { kind: "string", required: true, maxChars: 2000, bind: [["7", "prompt"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["9", "seed"]] },
    durationSec: { kind: "number-enum", values: [5, 10, 15], bind: [] },
    aspect: { kind: "string-enum", values: ["16:9", "9:16"], bind: [] },
    length: { kind: "int", internal: true, required: true, min: 5, max: 362, bind: [["7", "length"]] },
    width: { kind: "int", internal: true, required: true, min: 256, max: 1344, bind: [["7", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 256, max: 1344, bind: [["7", "height"]] },
  },
  graph: {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" },
    },
    "2": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["1", 0],
        lora_name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        strength_model: 1.0,
      },
    },
    "3": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["2", 0], shift_video: 12.0, shift_audio: 3.0 } },
    "4": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" },
    },
    "5": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "7": {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: { clip: ["4", 0], vae: ["5", 0], prompt: "", width: 864, height: 480, length: 124 },
    },
    "8": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
    "9": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps: 8,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["3", 0],
        positive: ["7", 0],
        negative: ["8", 0],
        latent_image: ["7", 1],
      },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["5", 0] } },
    "11": { class_type: "VAEDecodeAudio", inputs: { samples: ["9", 0], vae: ["6", 0] } },
    "12": { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: 24, audio: ["11", 0] } },
    "13": {
      class_type: "SaveVideo",
      inputs: { video: ["12", 0], filename_prefix: "arke", format: "mp4", codec: "h264" },
    },
  },
  outputNode: "13",
  requires: {
    checkpoints: [
      {
        file: "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        sha256: "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a",
        sizeMb: 20000,
        url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`,
      },
      {
        file: "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        sha256: "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6",
        sizeMb: 14961,
        url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`,
      },
      {
        file: "vae/minimax_h3_video_vae_fp16.safetensors",
        sha256: "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522",
        sizeMb: 4967,
        url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors`,
      },
      {
        file: "vae/minimax_h3_audio_vae_fp32.safetensors",
        sha256: "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48",
        sizeMb: 577,
        url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors`,
      },
      {
        file: "loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        sha256: "2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e",
        sizeMb: 1866,
        url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`,
      },
    ],
    customNodes: [],
  },
  hardware: {
    // The gate reads TOTAL VRAM (SPEC-022 §2.6's lesson), and 10 GB is what was actually proven:
    // the run below completed with ~6 GB of the card already held by other applications, streaming
    // the 20 GB transformer through dynamic VRAM loading. Community reports put 8 GB cards through
    // reduced runs, but nothing below 10 GB was measured here, so nothing below 10 GB is claimed.
    minVramMb: 10000,
    recommendedVramMb: 24000,
    floorSource:
      "measured through ComfyUI on Arke reference hardware 2026-08-28: RTX 3080 10 GB, ~6 GB already in use by " +
      "other applications, 864×480×124 frames at 8 steps completed in 14m53s with peak card usage 9699 MB and " +
      "system RAM bottoming at 933 MB free of 32 GB — 32 GB system RAM is effectively part of this floor",
  },
};

/**
 * Local · Cloned Voice — IndexTTS 2.5 through TTS-Audio-Suite (SPEC-022).
 *
 * The first recipe that needs a custom node, and the first whose input is **a file the app owns**
 * rather than a prompt. Both facts are load-bearing, and both were read off a running engine
 * (`/object_info`, 2026-08-19) rather than from documentation, because the documented shape and the
 * real one differ in three ways that would each have produced a recipe that validates and fails:
 *
 *   1. `UnifiedTTSTextNode.narrator_voice` is an enum scanned from the suite's own
 *      `voices_examples/`. A cloned clip cannot be named there. It arrives instead through
 *      `CharacterVoicesNode.opt_audio_input`, whose `NARRATOR_VOICE` feeds the wildcard
 *      `opt_narrator` — and `narrator_voice` stays `"none"` while the connection wins.
 *   2. `UnifiedTTSTextNode` emits an AUDIO tensor, not a file. Without `SaveAudio` after it there is
 *      nothing on disk for `fetchArtifacts` to fetch.
 *   3. `IndexTTSEngineNode` requires sixteen inputs. A dispatch missing three of them is refused by
 *      the engine's own validation, which is how the first attempt at this graph was caught.
 *
 * The clip reaches `LoadAudio` by **filename**, because that input is a combo over the engine's
 * `input/` directory — so a cloned voice's recording is uploaded to the engine (`POST /upload/image`
 * takes audio) and the returned name bound here. No other recipe needs this; see SPEC-022 §2.11.
 *
 * Verified end to end on 2026-08-19: this graph produced 4.59s of cloned speech on an RTX 3080 and
 * the output was fetched back through the same `/view` path the client uses.
 */
const CLONED_VOICE: ComfyUiRecipe = {
  id: "comfyui-cloned-voice",
  capability: "voice-tts",
  displayName: "Local · Cloned Voice",
  recipeVersion: 1,
  params: {
    // The words, verbatim — a line to speak, never a prompt describing a performance
    // (SPEC-011 turn 70). The cap is ours: the node chunks longer text, and a scene line that
    // needs chunking is a line that should have been two.
    /*
     * One segment's worth, and no more.
     *
     * 2000 was this recipe's own guess at "long enough to be someone else's problem", and it was
     * wrong in the direction that matters: at 300 tokens a segment the engine takes roughly 400
     * characters, and anything past that is a second full pass over the model rather than a
     * little more audio. The recipe already held that a line needing chunking is a line that
     * should have been two; this is that belief with the arithmetic done.
     */
    text: { kind: "string", required: true, maxChars: 400, bind: [["4", "text"]] },
    // The uploaded clip's filename on the engine, resolved from the voice library before dispatch.
    // Internal because the user picks a VOICE, never a filename.
    speakerFile: { kind: "string", internal: true, required: true, maxChars: 260, bind: [["1", "audio"]] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["4", "seed"]] },
  },
  graph: {
    "1": { class_type: "LoadAudio", inputs: { audio: "" } },
    "2": {
      class_type: "CharacterVoicesNode",
      // `customized: true` with `voice_name: "none"` is what makes the connected audio the voice
      // rather than a preset. reference_text stays empty: IndexTTS does not need the clip
      // transcribed, and inventing one would put words in the reference it never said.
      inputs: {
        voice_name: "none",
        reference_text: "",
        trim_start: 0.0,
        trim_end: 0.0,
        customized: true,
        opt_audio_input: ["1", 0],
      },
    },
    "3": {
      class_type: "IndexTTSEngineNode",
      // All sixteen, at the node's own defaults except model_path. `use_deepspeed: false` matches
      // SPEC-022 §2.6's constraint; `use_cuda_kernel` is absent from this node entirely, so the
      // trap measured at 2x slower cannot be set here at all.
      inputs: {
        model_path: "IndexTTS-2.5",
        device: "auto",
        emotion_alpha: 1.0,
        use_random: false,
        // The node's ceiling, not its default of 120 (SPEC-022 §2.6).
        //
        // Chunking is not a cost that scales: each segment is a full pass over the model, and on
        // a 10 GB card the second one thrashes. Measured on the reference machine, a 174-character
        // line split at 120 and the passes ran 25 steps in 7m49s and then 678s PER STEP — the card
        // 92% full and ~9 GB of the process paged to disk. One pass is the difference between a
        // preview that lands and one that never does, so the segment is as large as the node
        // allows and `text` is capped to fit inside it.
        max_text_tokens_per_segment: 300,
        interval_silence: 200,
        temperature: 0.8,
        top_p: 0.8,
        top_k: 30,
        do_sample: true,
        length_penalty: 0.0,
        /*
         * One beam, not the node's default of three.
         *
         * Beam search keeps every candidate sequence alive through decoding, so three beams is
         * roughly three times the decoder's memory — spent during exactly the stage that ran the
         * reference machine out of card. It is also the slowest of the decoding strategies the
         * engine offers. With `do_sample` on, beams were doing very little for a single spoken
         * line anyway: sampling is what gives the delivery its variation, and the seed is what
         * makes it repeatable.
         */
        num_beams: 1,
        repetition_penalty: 10.0,
        /*
         * 1000, not the node's default of 1500. This is the ceiling on how much audio one pass
         * may generate, and it costs memory and time in proportion. The published guidance for
         * cards at or below 10 GB is 1000, and 1000 mel tokens is far more speech than the 400
         * characters `text` now admits.
         */
        max_mel_tokens: 1000,
        // Half precision on CUDA: about half the memory of fp32 for a very small quality cost,
        // and the engine's own default on this hardware.
        use_fp16: true,
        use_deepspeed: false,
      },
    },
    "4": {
      class_type: "UnifiedTTSTextNode",
      inputs: {
        TTS_engine: ["3", 0],
        text: "",
        // Stays "none". The clip arrives on opt_narrator, and a preset named here would compete
        // with the voice the user actually chose.
        narrator_voice: "none",
        seed: 0,
        opt_narrator: ["2", 0],
      },
    },
    // Core SaveAudio supports FLAC (not WAV). FLAC is therefore the declared end-to-end contract:
    // provider metadata, sanitizer, verifier, cache and media server all consume this output.
    "5": { class_type: "SaveAudio", inputs: { audio: ["4", 0], filename_prefix: "arke_voice" } },
  },
  outputNode: "5",
  requires: {
    // The old path delegated roughly 10.2 GB of model and auxiliary downloads to the node at
    // first generation. SPEC-028 forbids that. The repository does not yet contain exact URLs,
    // sizes and sha256 digests for that closure, nor a digest-pinned archive containing the node
    // and its locked Python dependencies, so this recipe remains explicitly unavailable rather
    // than pretending an empty checkpoint list is ready.
    checkpoints: [],
    customNodes: [
      { id: "TTS-Audio-Suite", pinnedRef: "dedd982ab999633d5296c3e5a152ef772941fb82" },
    ],
    unavailableReason:
      "Cloned voice setup is unavailable in this build: the immutable TTS-Audio-Suite archive, locked Python dependencies, and complete hashed IndexTTS 2.5 model files are not published in the setup catalogue.",
  },
  hardware: {
    // Raised from 6000 after the first end-to-end dispatch through ComfyUI failed to finish on a
    // card that cleared the old floor twice over (SPEC-022 §2.6). 5.44 GB was a true measurement
    // of the model on the Python harness and a false statement of what this recipe needs: the
    // engine hosting it costs more, and the machine it runs on already had 3.36 GB of its card
    // spoken for. The gate reads TOTAL VRAM, so the headroom has to live in the floor.
    minVramMb: 8000,
    recommendedVramMb: 12000,
    floorSource:
      "measured through ComfyUI on Arke reference hardware 2026-08-19: RTX 3080, 3.36 GB already in use by other applications, peak 9.35 GB and still climbing when the run was killed. A lower bound, not a peak — the true peak could not be measured on a card that could not hold it",
  },
};

export const COMFYUI_RECIPES: readonly ComfyUiRecipe[] = deepFreeze([DRAFT_IMAGE, DRAFT_VIDEO, H3_VIDEO, CLONED_VOICE]);

export function comfyUiRecipeById(modelId: string): ComfyUiRecipe | null {
  return COMFYUI_RECIPES.find((recipe) => recipe.id === modelId) ?? null;
}

/** Seconds → Wan frame count, for the client's derivation. Exported for the tests' arithmetic. */
export function wanFramesForSeconds(seconds: number): number | null {
  return WAN_FRAMES_BY_SECONDS[String(seconds)] ?? null;
}

/** Seconds → H3 frame count (17k+5 at 24 fps), for the client's derivation. */
export function h3FramesForSeconds(seconds: number): number | null {
  return H3_FRAMES_BY_SECONDS[String(seconds)] ?? null;
}

// ---------------------------------------------------------------------------
// Identity (§2.11): digests over canonical bytes, computed once at module load
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted, recursively — the digest input must not depend on authoring order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function recipeTemplateDigest(recipe: ComfyUiRecipe): string {
  return sha256Hex(canonicalJson(recipe.graph));
}

/** Order-independent over the dependency set: same pins, same digest, however they are listed. */
export function recipeDependencyDigest(recipe: ComfyUiRecipe): string {
  const lines = [
    ...recipe.requires.checkpoints.map((c) => `checkpoint:${c.file}:${c.sha256}`),
    ...recipe.requires.customNodes.map((n) => `node:${n.id}:${n.pinnedRef}`),
  ].sort();
  return sha256Hex(lines.join("\n"));
}

/** The identity frozen onto a job at enqueue (R-15). */
export function comfyUiRecipeIdentity(recipe: ComfyUiRecipe): RecipeIdentity {
  return {
    id: recipe.id,
    version: recipe.recipeVersion,
    templateDigest: recipeTemplateDigest(recipe),
    dependencyDigest: recipeDependencyDigest(recipe),
  };
}

/** Every class_type a recipe's graph uses — what the `/object_info` compatibility probe asks for (D14). */
export function recipeNodeClasses(recipe: ComfyUiRecipe): string[] {
  return [...new Set(Object.values(recipe.graph).map((node) => node.class_type))].sort();
}

// ---------------------------------------------------------------------------
// Substitution (T-3): typed values into declared leaf slots, and nothing else
// ---------------------------------------------------------------------------

export type RecipeParamValues = Record<string, string | number>;

function checkValue(recipe: ComfyUiRecipe, name: string, spec: RecipeParamSpec, value: string | number): void {
  const fail = (why: string): never => {
    throw new Error(`${recipe.id}: param "${name}" ${why}`);
  };
  switch (spec.kind) {
    case "string": {
      if (typeof value !== "string") fail("must be a string");
      if (spec.maxChars !== undefined && (value as string).length > spec.maxChars) {
        fail(`is over ${spec.maxChars} characters`);
      }
      return;
    }
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) fail("must be an integer");
      if (spec.min !== undefined && (value as number) < spec.min) fail(`is under ${spec.min}`);
      if (spec.max !== undefined && (value as number) > spec.max) fail(`is over ${spec.max}`);
      return;
    }
    case "number-enum":
    case "string-enum": {
      if (!spec.values?.includes(value)) {
        fail(`must be one of ${spec.values?.join(", ") ?? "(nothing)"}`);
      }
      return;
    }
  }
}

/**
 * Build the dispatchable graph: validate every value against the recipe's own schema, then
 * write each into the slots its binding names. The guarantees R-2 needs are mechanical here:
 *
 * - An unknown param refuses — there is no way to reach a slot the recipe did not declare.
 * - A binding can only replace a scalar input. A slot currently holding a link (an array) is
 *   structure, and substitution refuses it rather than severing an edge.
 * - Node ids, class types and output selection are not inputs, so no binding can name them.
 * - A missing required param refuses, so no placeholder default ever ships as real work.
 */
export function substituteRecipeParams(recipe: ComfyUiRecipe, values: RecipeParamValues): RecipeGraph {
  for (const name of Object.keys(values)) {
    if (!(name in recipe.params)) {
      throw new Error(`${recipe.id}: "${name}" is not a parameter of this recipe`);
    }
  }
  for (const [name, spec] of Object.entries(recipe.params)) {
    if (spec.required === true && values[name] === undefined) {
      throw new Error(`${recipe.id}: param "${name}" is required`);
    }
  }
  const graph: RecipeGraph = structuredClone(recipe.graph) as RecipeGraph;
  for (const [name, value] of Object.entries(values)) {
    const spec = recipe.params[name]!;
    checkValue(recipe, name, spec, value);
    for (const [nodeId, inputKey] of spec.bind) {
      const node = graph[nodeId];
      if (!node) throw new Error(`${recipe.id}: binding for "${name}" names a node "${nodeId}" the graph does not have`);
      const current = node.inputs[inputKey];
      if (Array.isArray(current)) {
        throw new Error(`${recipe.id}: binding for "${name}" targets a link slot "${nodeId}.${inputKey}" — structure is not substitutable`);
      }
      if (!(inputKey in node.inputs)) {
        throw new Error(`${recipe.id}: binding for "${name}" targets "${nodeId}.${inputKey}", which the template does not declare`);
      }
      node.inputs[inputKey] = value;
    }
  }
  return graph;
}

/** The params callers may send — everything not internal. The client refuses the rest. */
export function callerParamNames(recipe: ComfyUiRecipe): Set<string> {
  return new Set(
    Object.entries(recipe.params)
      .filter(([, spec]) => spec.internal !== true)
      .map(([name]) => name),
  );
}

// ---------------------------------------------------------------------------
// The manifest projection (R-3): rows like any other, and no graph anywhere
// ---------------------------------------------------------------------------

/**
 * Aspect → SDXL-native bucket. The training buckets, not arithmetic: an off-bucket size
 * generates worse, so the recipe snaps rather than scales.
 */
export const SDXL_BUCKETS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1216, height: 832 },
  "2:3": { width: 832, height: 1216 },
  "4:3": { width: 1152, height: 896 },
  "3:4": { width: 896, height: 1152 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
};

export const WAN_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 704 },
  "9:16": { width: 704, height: 1280 },
};

/**
 * The verified 480p-class sizes, not the node's 1344×768 native default: the floor above was
 * measured at exactly these, and a size nobody has run is a promise nobody has kept. Raise them
 * from a measured run on bigger hardware, never from the node's defaults.
 */
export const H3_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 864, height: 480 },
  "9:16": { width: 480, height: 864 },
};

/**
 * Which tables derive a video recipe's internal params (frames, pixels) from the caller's chosen
 * seconds and aspect. Keyed by recipe id because the derivation is recipe arithmetic — Wan's 4k+1
 * against H3's 17k+5 — and the client dispatching them should hold no model names of its own.
 */
export const VIDEO_DERIVATIONS: Record<
  string,
  { dimensions: Record<string, { width: number; height: number }>; framesBySeconds: Record<string, number> }
> = {
  [DRAFT_VIDEO.id]: { dimensions: WAN_DIMENSIONS, framesBySeconds: WAN_FRAMES_BY_SECONDS },
  [H3_VIDEO.id]: { dimensions: H3_DIMENSIONS, framesBySeconds: H3_FRAMES_BY_SECONDS },
};

export const COMFYUI_MANIFEST_MODELS: ManifestModel[] = [
  {
    id: CLONED_VOICE.id,
    provider: "comfyui",
    capability: "voice-tts",
    displayName: CLONED_VOICE.displayName,
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    // maxPromptChars is the LINE's cap, not a prompt's — the words are the content (turn 70).
    limits: { maxPromptChars: 400, audioFormat: "flac" },
    // Unmetered, and therefore no per-character figure: a local read costs nothing, where an
    // ElevenLabs row states an exact price (SPEC-022 §1.3, turn 70's no-tilde rule).
    pricing: { kind: "unmetered" },
    requires: { vramMb: CLONED_VOICE.hardware.minVramMb, diskMb: 10500 },
  },
  {
    id: DRAFT_IMAGE.id,
    provider: "comfyui",
    capability: "image",
    displayName: DRAFT_IMAGE.displayName,
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: {
      maxPromptChars: 2000,
      resolutions: ["1024"],
      tiers: { "1K": "1024" },
      aspects: Object.keys(SDXL_BUCKETS),
    },
    pricing: { kind: "unmetered" },
    requires: { vramMb: DRAFT_IMAGE.hardware.minVramMb },
  },
  {
    id: DRAFT_VIDEO.id,
    provider: "comfyui",
    capability: "video",
    displayName: DRAFT_VIDEO.displayName,
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {
      maxPromptChars: 2000,
      maxDurationSec: 5,
      // Seconds → seconds: the wire word is the number itself, and the client derives the
      // engine's frame count from it (wanFramesForSeconds). durationWire "number" so
      // dispatchDuration hands the client a number, the same contract the wan fal rows use.
      durations: { "2": "2", "3": "3", "5": "5" },
      durationWire: "number",
      resolutions: ["704p"],
      aspects: Object.keys(WAN_DIMENSIONS),
    },
    pricing: { kind: "unmetered" },
    requires: { vramMb: DRAFT_VIDEO.hardware.minVramMb },
  },
  {
    id: H3_VIDEO.id,
    provider: "comfyui",
    capability: "video",
    displayName: H3_VIDEO.displayName,
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {
      maxPromptChars: 2000,
      maxDurationSec: 15,
      // Seconds → seconds, exactly as the wan row: the wire word is the number itself and the
      // client derives the 17k+5 frame count from it (h3FramesForSeconds).
      durations: { "5": "5", "10": "10", "15": "15" },
      durationWire: "number",
      resolutions: ["480p"],
      aspects: Object.keys(H3_DIMENSIONS),
    },
    pricing: { kind: "unmetered" },
    requires: { vramMb: H3_VIDEO.hardware.minVramMb, diskMb: 42371 },
  },
];

// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
