import type { ManifestModel } from "@arke-studio/contracts";
import { UPSCALE_DIMENSIONS } from "@arke-studio/contracts";
import type { ComfyUiRecipe } from "./recipes.js";

/**
 * Comfy-Org's SeedVR2 repackaging, pinned to the revision whose files were read on 2026-10-01.
 * The digests below are the Hugging Face LFS oids at that revision — the sha256 of the exact bytes
 * served — and were checked against the copies the measured run used.
 */
const SOURCE = "https://huggingface.co/Comfy-Org/SeedVR2/resolve/df48879708206a403d2a61acd55578c2e80fd233";

/** The prefix the output is saved under, and the one the fetch keeps (see `outputPrefix`). */
const OUTPUT_PREFIX = "arke-upscale";

/**
 * Local · SeedVR2 — a finished video take made into 1080p (design turn 178; SPEC-021 R-33).
 *
 * SeedVR2 3B (Apache-2.0) is a one-step diffusion restorer: the source is scaled to cover the
 * frame and centre-cropped (node 3, the same `ImageScale` H3 uses to fit a photo to its bucket),
 * encoded, cut into temporal chunks, restored in a single sampler step, merged, decoded, and
 * colour-corrected back towards the source in lab space. ComfyUI 0.38 ships every one of those
 * nodes, so no custom node is pinned (D11).
 *
 * Chunks are set by hand — 9 frames with 1 of overlap — rather than left to the node's automatic
 * mode, because that is what was run under the floor below: the chunk length is what bounds the
 * card, and an automatic choice is one nobody measured. The tiled VAE (512 px tiles, 128 overlap,
 * 64 frames with 8 of overlap) is the same reasoning for the encode and the decode.
 *
 * The frame count, the frame rate and the sound are the source's, copied: `GetVideoComponents`
 * splits the source into its frames, its audio and its rate, and `CreateVideo` puts the restored
 * frames back with the other two untouched. An upscale never re-times or re-voices a take.
 *
 * `LoadVideo.file` is a combo over the engine's `input/` directory and only lists a file whose
 * extension it knows, which is why the upload is named `<sha256>.mp4` like every other input.
 *
 * Measured through ComfyUI 0.38.1 on the reference machine (RTX 3080 10 GB, 31.9 GB RAM), 2026-10-01:
 *
 *   864×480,  2 s → 1920×1080   4.7 min    peak 6.8 GB on the card
 *   1344×768, 7 s → 1920×1080   14.3 min   peak 7.2 GB on the card, system RAM low-water 3 MB
 *
 * Every frame was kept and none froze. The card is not the tight resource here: system RAM is.
 * The 7 s run took free memory to the floor while the card had 2.8 GB to spare, so the
 * system-memory floor is the 32 GB class it ran on, and a longer source at 768p is where this
 * would give out first.
 */
export const SEEDVR2_UPSCALE: ComfyUiRecipe = {
  id: "comfyui-seedvr2-upscale",
  capability: "video",
  displayName: "Local · SeedVR2",
  recipeVersion: 1,
  // The SeedVR2 nodes arrived in ComfyUI 0.38.0; 0.38.1 is the newest engine this graph has run on.
  engine: { minVersion: "0.38.0", exercisedThroughVersion: "0.38.1" },
  params: {
    // The only size there is (design 178), and the frame it maps to by the source's orientation.
    size: { kind: "string-enum", values: ["1080p"], bind: [] },
    aspect: { kind: "string-enum", values: ["16:9", "9:16"], bind: [] },
    seed: { kind: "int", min: 0, max: 2 ** 31 - 1, bind: [["10", "seed"]] },
    width: { kind: "int", internal: true, required: true, min: 1080, max: 1920, bind: [["3", "width"]] },
    height: { kind: "int", internal: true, required: true, min: 1080, max: 1920, bind: [["3", "height"]] },
    // The uploaded source's name on the engine, resolved at dispatch like any reference file.
    // Not `required`: the scalars are checked before anything is uploaded, and this is filled
    // only once the engine has accepted the file (`videoInput` makes the client insist on one).
    videoFile: { kind: "string", internal: true, maxChars: 260, bind: [["1", "file"]] },
  },
  graph: {
    "1": { class_type: "LoadVideo", inputs: { file: "" } },
    "2": { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
    "3": {
      class_type: "ImageScale",
      inputs: { image: ["2", 0], upscale_method: "lanczos", width: 1920, height: 1080, crop: "center" },
    },
    "4": { class_type: "SeedVR2Preprocess", inputs: { resized_images: ["3", 0] } },
    "5": { class_type: "UNETLoader", inputs: { unet_name: "seedvr2_3b_int8_convrot.safetensors", weight_dtype: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: "seedvr2_ema_vae_fp16.safetensors" } },
    "7": {
      class_type: "VAEEncodeTiled",
      inputs: { pixels: ["4", 0], vae: ["6", 0], tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 },
    },
    "8": {
      class_type: "SeedVR2TemporalChunk",
      inputs: { latent: ["7", 0], temporal_overlap: 1, chunking_mode: "manual", "chunking_mode.frames_per_chunk": 9 },
    },
    "9": { class_type: "SeedVR2Conditioning", inputs: { model: ["5", 0], vae_conditioning: ["8", 0] } },
    "10": {
      class_type: "KSampler",
      inputs: {
        model: ["5", 0],
        seed: 0,
        steps: 1,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["9", 0],
        negative: ["9", 1],
        latent_image: ["8", 0],
        denoise: 1,
      },
    },
    "11": { class_type: "SeedVR2TemporalMerge", inputs: { latents: ["10", 0], temporal_overlap: ["8", 1] } },
    "12": {
      class_type: "VAEDecodeTiled",
      inputs: { samples: ["11", 0], vae: ["6", 0], tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 },
    },
    "13": {
      class_type: "SeedVR2PostProcessing",
      inputs: { images: ["12", 0], original_resized_images: ["3", 0], color_correction_method: "lab" },
    },
    "14": { class_type: "CreateVideo", inputs: { images: ["13", 0], fps: ["2", 2], audio: ["2", 1] } },
    "15": {
      class_type: "SaveVideo",
      inputs: { video: ["14", 0], filename_prefix: OUTPUT_PREFIX, format: "mp4", codec: "h264" },
    },
  },
  videoInput: { param: "videoFile" },
  outputNode: "15",
  outputPrefix: OUTPUT_PREFIX,
  stage: "upscaling",
  requires: {
    checkpoints: [
      {
        file: "diffusion_models/seedvr2_3b_int8_convrot.safetensors",
        sha256: "c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157",
        sizeMb: 3458,
        url: `${SOURCE}/diffusion_models/seedvr2_3b_int8_convrot.safetensors`,
      },
      {
        file: "vae/seedvr2_ema_vae_fp16.safetensors",
        sha256: "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1",
        sizeMb: 501,
        url: `${SOURCE}/vae/seedvr2_ema_vae_fp16.safetensors`,
      },
    ],
    customNodes: [],
  },
  hardware: {
    // The int8 convrot weights are CUDA kernels, as H3's are; nothing else was run.
    accelerator: "cuda",
    // The card class the runs were made on. Smaller cards were not tried, so none is claimed.
    minVramMb: 10000,
    // What the job adds to the card, not the card's peak: the 768p run peaked at 7,220 MiB from
    // 1,387 MiB already in use, so it needed ~5.8 GB. The first floor (7.4 GB, the peak) refused
    // every dispatch on the 10 GB card it was measured on, where the desktop alone holds 1.5–3.5 GB.
    minFreeVramMb: 6000,
    recommendedVramMb: 12000,
    // System RAM is what ran out first — 3 MB to spare at the 7 s run's low-water mark on a
    // 32 GB machine — so the 32 GB class is part of this floor, exactly as it is for H3.
    minMemMb: 30720,
    // No free-RAM floor: the runs recorded where free memory bottomed, not where it stood at
    // dispatch, and the floor is the difference between the two (issue 846's rule).
    floorSource:
      "measured through ComfyUI 0.38.1 on Arke reference hardware 2026-10-01: RTX 3080 10 GB, 31.9 GB RAM; " +
      "864×480×2 s to 1920×1080 in 4.7 min at a 6.8 GB card peak, and 1344×768×7 s to 1920×1080 in 14.3 min " +
      "at a 7.2 GB card peak with system RAM bottoming at 3 MB free",
  },
};

/** The two frames the recipe can be asked for, by the source's orientation. */
export const SEEDVR2_DIMENSIONS: Record<string, { width: number; height: number }> = { ...UPSCALE_DIMENSIONS };

/**
 * The manifest row (R-3): video by what it makes, an upscaler by what it is for. `upscale` keeps it
 * out of every picker and routing default; the bench offers it on a finished take instead.
 */
export const SEEDVR2_UPSCALE_MODEL: ManifestModel = {
  id: SEEDVR2_UPSCALE.id,
  provider: "comfyui",
  capability: "video",
  displayName: SEEDVR2_UPSCALE.displayName,
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { resolutions: ["1080p"], aspects: Object.keys(SEEDVR2_DIMENSIONS) },
  upscale: { size: "1080p", minEngineVersion: SEEDVR2_UPSCALE.engine.minVersion },
  pricing: { kind: "unmetered" },
  requires: {
    vramMb: SEEDVR2_UPSCALE.hardware.minVramMb,
    recommendedVramMb: SEEDVR2_UPSCALE.hardware.recommendedVramMb,
    memMb: SEEDVR2_UPSCALE.hardware.minMemMb,
    diskMb: 3959,
    accelerator: ["cuda"],
  },
};
