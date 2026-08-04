import { ModelManifestSchema, type ModelManifest } from "@arke-studio/contracts";
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
  manifestVersion: 10,
  generated: "2026-08-02",
  models: [
    // ---- fal: generated from the live catalogue ---------------------------
    ...FAL_MODELS.map((model) => ({
      ...model,
      accepts: { ...model.accepts, referenceRoles: false },
    })),
    // ---- video ------------------------------------------------------------
    {
      id: "halcyon-1.5",
      provider: "higgsfield",
      capability: "video",
      displayName: "Halcyon 1.5",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: true, endFrame: true },
      limits: { maxDurationSec: 12, resolutions: ["720p", "1080p"], aspects: ["16:9", "9:16"] },
      pricing: { kind: "perSecond", microUsdPerSecond: 35000 },
    },
    // ---- image ------------------------------------------------------------
    {
      id: "soul-2.0",
      provider: "higgsfield",
      capability: "image",
      displayName: "Soul 2.0",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { resolutions: ["1080p", "4k"], aspects: ["16:9", "1:1"] },
      pricing: { kind: "perImage", microUsdPerImage: 60000, byResolution: { "4k": 120000 } },
    },
    {
      id: "gpt-image-2",
      provider: "openai",
      capability: "image",
      displayName: "GPT Image 2",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { resolutions: ["1024", "2048"], aspects: ["1:1", "3:2", "2:3"] },
      pricing: { kind: "perImage", microUsdPerImage: 40000 },
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
      id: "eleven-v3",
      provider: "elevenlabs",
      capability: "voice-tts",
      displayName: "Eleven v3",
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
