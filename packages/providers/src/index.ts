/**
 * The provider layer (SPEC-008): clients with capability declarations, the shipped model
 * manifest, and local runtime detection. Vocabulary (capabilities, provider ids, pricing,
 * declarations) lives in @arke-studio/contracts so the renderer shares it.
 */
export { AnthropicClient } from "./clients/anthropic.js";
export {
  ComfyUiClient,
  COMFYUI_VERSION_FLOOR,
  meetsVersionFloor,
  type ComfyUiPreflight,
  type EngineBaseUrl,
} from "./clients/comfyui.js";
export {
  callerParamNames,
  canonicalJson,
  COMFYUI_MANIFEST_MODELS,
  COMFYUI_RECIPES,
  comfyUiRecipeById,
  comfyUiRecipeIdentity,
  recipeDependencyDigest,
  recipeNodeClasses,
  recipeTemplateDigest,
  SDXL_BUCKETS,
  substituteRecipeParams,
  WAN_DIMENSIONS,
  wanFramesForSeconds,
  type ComfyUiRecipe,
  type RecipeCheckpoint,
  type RecipeCustomNode,
  type RecipeGraph,
  type RecipeParamSpec,
  type RecipeParamValues,
} from "./comfyui/recipes.js";
export { redactComfyUiBody } from "./comfyui/redact.js";
export { ElevenLabsClient } from "./clients/elevenlabs.js";
export { FalClient } from "./clients/fal.js";
export { HiggsfieldClient } from "./clients/higgsfield.js";
export { OllamaClient } from "./clients/ollama.js";
export { OpenAiClient } from "./clients/openai.js";
export { jsonRequest, tryProbe } from "./clients/http.js";
export { requireModel, SHIPPED_MANIFEST } from "./manifest-data.js";
export { createProviderClients, PROVIDER_DECLARATIONS, type ProviderClientDeps } from "./registry.js";
export {
  discoverHiggsfield,
  higgsfieldRunner,
  higgsfieldSignIn,
  higgsfieldSelectWorkspace,
  higgsfieldWhoAmI,
  higgsfieldWorkspaces,
  lazyHiggsfieldRunner,
  missingHiggsfieldRunner,
  type DiscoveredHiggsfield,
  type HiggsfieldDiscoveryOptions,
} from "./higgsfield-cli.js";
export { captureProviderClient } from "./capture.js";
export { probeRuntime, type ProbeDeps } from "./runtime-detect.js";
export { gateLocalRuntimes } from "@arke-studio/contracts";
export {
  ProviderAuthError,
  ProviderRequestRejectedError,
  type CommandResult,
  type CommandRunner,
  type FetchedArtifact,
  type FetchLike,
  type PollResult,
  type ProviderClient,
  type ProviderCallCapture,
  type ProviderCallContext,
  type VoiceCatalogueClient,
  type SubmitRequest,
  type SubmitResult,
} from "./types.js";
