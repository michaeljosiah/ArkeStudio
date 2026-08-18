import { ModelManifestSchema, type ModelManifest } from "@arke-studio/contracts";
import { COMFYUI_MANIFEST_MODELS } from "./comfyui/recipes.js";
import { FAL_MODELS } from "./fal-catalogue.generated.js";

/**
 * The shipped model manifest (SPEC-008 §2.5, D9): read at start, never fetched at run time.
 * Drift detection (R-13) is the guard against it going stale.
 *
 * The FAL rows are generated from fal's own catalogue — see
 * scripts/sync-fal-catalogue.mjs. They used to be written from memory, and were wrong: a model
 * named "Seedance 2.0" pointed at the v1 route. Everything else here is still hand-maintained
 * from provider pricing pages, because those providers publish no catalogue we can read.
 *
 * Prices are integer micro-dollars (R-14).
 */
export const SHIPPED_MANIFEST: ModelManifest = ModelManifestSchema.parse({
  manifestVersion: 16,
  generated: "2026-08-18",
  models: [
    // ---- fal: generated from the live catalogue ---------------------------
    ...FAL_MODELS.map((model) => ({
      ...model,
      accepts: { ...model.accepts, referenceRoles: false },
    })),
    // ---- comfyui: projected from the shipped recipe catalogue (SPEC-021 R-3) ----
    // Rows like any other — capability copy, estimates and pass packing need no special case —
    // and deliberately no graph: the projection in comfyui/recipes.ts is the whole boundary.
    ...COMFYUI_MANIFEST_MODELS,
    // ---- image ------------------------------------------------------------
    // Higgsfield rows are keyed on the CLI's `job_type`, because that is the string
    // `generate create` dispatches to. `higgsfield model list --json` is the authority for
    // them, not the CLI repository's MODELS.md: the live catalogue carries 77 job types
    // against MODELS.md's 55, and `display_name` is not unique — four distinct job types all
    // report "Nano Banana Pro". The previous rows were written from the HTTP docs and neither
    // one dispatched: "soul-2.0" is spelled `text2image_soul_v2`, and "halcyon-1.5" does not
    // exist in the catalogue at all, under that or any other name.
    {
      id: "text2image_soul_v2",
      provider: "higgsfield",
      capability: "image",
      displayName: "Higgsfield Soul 2.0",
      accepts: { referenceImages: 1, referenceRoles: false, startFrame: false, endFrame: false },
      limits: {
        // The route calls this `quality`, not `resolution` — see SIZE_FLAG in the client.
        resolutions: ["1.5k", "2k"],
        tiers: { "1K": "1.5k", "2K": "2k" },
        aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
      },
      pricing: { kind: "perImage", microUsdPerImage: 60000 },
    },
    // ---- video ------------------------------------------------------------
    // Deliberately none. The catalogue has 22 video job types, and Higgsfield publishes no
    // price list we can read — the removed row's per-second figure belonged to a model that
    // does not exist, so it cannot be carried to a real one. A video row lands when its price
    // does; offering one at a guessed rate would put a wrong number in front of a user before
    // they spend (R-14).
    {
      id: "gpt-image-2",
      provider: "openai",
      capability: "image",
      displayName: "GPT Image 2",
      accepts: { referenceImages: 16, referenceRoles: false, startFrame: false, endFrame: false },
      limits: {
        // 32000 is what OpenAI documents for the GPT image models on the images endpoint (the
        // older DALL·E rows are 1000 and 4000), and what fal's schema for the same model behind
        // its own gateway declares — two sources, one of them the provider's. Transcribed, not
        // chosen: a cap invented here would refuse briefs the model would have taken.
        maxPromptChars: 32000,
        // One tier, because the route has one size per shape: `size` is an enum — 1024x1024,
        // 1536x1024, 1024x1536 — and nothing else is accepted. The row used to claim 2048 as
        // well, which put a 2K button in the picker that scaled portrait to 1366x2048 and was
        // rejected at validation every time, in 1.3s, for the same estimated price as the 1K
        // that works (#223). A tier the picker offers has to be one dispatch can reach.
        resolutions: ["1024"],
        tiers: { "1K": "1024" },
        aspects: ["1:1", "3:2", "2:3"],
      },
      // Medium output is documented up to $0.053. The $0.10/reference allowance deliberately
      // errs high because OpenAI bills mandatory high-fidelity input tokens but does not publish
      // a GPT Image 2 input-token formula.
      pricing: { kind: "perImage", microUsdPerImage: 53000, microUsdPerReferenceImage: 100000 },
    },
    // ---- llm (direct, non-authoring — authoring routes through the harness) -
    {
      id: "gpt-5.2",
      provider: "openai",
      capability: "llm",
      displayName: "GPT-5.2",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 400000 },
      pricing: { kind: "perToken", microUsdPerMillionInput: 1250000, microUsdPerMillionOutput: 10000000 },
    },
    {
      id: "claude-sonnet-5",
      provider: "anthropic",
      capability: "llm",
      displayName: "Claude Sonnet 5",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 1000000 },
      pricing: { kind: "perToken", microUsdPerMillionInput: 3000000, microUsdPerMillionOutput: 15000000 },
    },
    {
      id: "llama3.3-70b",
      provider: "ollama",
      capability: "llm",
      displayName: "Llama 3.3 70B",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 128000 },
      pricing: { kind: "unmetered" },
      requires: { vramMb: 42000, diskMb: 40000 },
    },
    {
      id: "llama3.1-8b",
      provider: "ollama",
      capability: "llm",
      displayName: "Llama 3.1 8B",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 128000 },
      pricing: { kind: "unmetered" },
      requires: { vramMb: 6000, diskMb: 5000 },
    },
    {
      id: "gemma4-e2b-it-qat",
      provider: "ollama",
      capability: "llm",
      displayName: "Gemma 4 E2B (quantised)",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 128000 },
      pricing: { kind: "unmetered" },
      requires: { vramMb: 6300, diskMb: 4300 },
    },
    {
      id: "gemma4-12b",
      provider: "ollama",
      capability: "llm",
      displayName: "Gemma 4 12B",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 256000 },
      pricing: { kind: "unmetered" },
      requires: { vramMb: 9600, diskMb: 7600 },
    },
    {
      id: "gemma4-26b",
      provider: "ollama",
      capability: "llm",
      displayName: "Gemma 4 26B",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxContextTokens: 256000 },
      pricing: { kind: "unmetered" },
      requires: { vramMb: 20000, diskMb: 18000 },
    },
    // ---- voice ------------------------------------------------------------
    {
      id: "eleven_multilingual_v2",
      provider: "elevenlabs",
      capability: "voice-tts",
      displayName: "Eleven Multilingual v2",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
    },
    {
      id: "kokoro-82m",
      provider: "kokoro",
      capability: "voice-tts",
      displayName: "Kokoro 82M",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "unmetered" },
      requires: { memMb: 4000, diskMb: 400 },
    },
    {
      id: "whisper-large-v3",
      provider: "whispercpp",
      capability: "voice-stt",
      displayName: "Whisper Large v3",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "unmetered" },
      requires: { memMb: 4000, diskMb: 3100 },
    },
  ],
});

/** Manifest lookup that refuses the unknown (R-12, D4): a reason, never an attempt. */
export function requireModel(
  manifest: ModelManifest,
  modelId: string,
): { ok: true; model: ModelManifest["models"][number] } | { ok: false; reason: string } {
  const model = manifest.models.find((m) => m.id === modelId);
  if (!model) {
    return {
      ok: false,
      reason: `"${modelId}" is not in the model manifest (v${manifest.manifestVersion}, ${manifest.generated}) — dispatching without an estimate is refused`,
    };
  }
  return { ok: true, model };
}
