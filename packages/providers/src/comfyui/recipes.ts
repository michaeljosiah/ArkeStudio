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
  capability: "image" | "video";
  displayName: string;
  recipeVersion: number;
  params: Record<string, RecipeParamSpec>;
  graph: RecipeGraph;
  /** The one node whose outputs are fetched (§2.6) — never every image the history names. */
  outputNode: string;
  requires: {
    checkpoints: readonly RecipeCheckpoint[];
    customNodes: readonly RecipeCustomNode[];
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

export const COMFYUI_RECIPES: readonly ComfyUiRecipe[] = deepFreeze([DRAFT_IMAGE, DRAFT_VIDEO]);

export function comfyUiRecipeById(modelId: string): ComfyUiRecipe | null {
  return COMFYUI_RECIPES.find((recipe) => recipe.id === modelId) ?? null;
}

/** Seconds → Wan frame count, for the client's derivation. Exported for the tests' arithmetic. */
export function wanFramesForSeconds(seconds: number): number | null {
  return WAN_FRAMES_BY_SECONDS[String(seconds)] ?? null;
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

export const COMFYUI_MANIFEST_MODELS: ManifestModel[] = [
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
];

// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
