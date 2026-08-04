import type { ClientDeclarations, ProviderId } from "@arke-studio/contracts";
import { AnthropicClient } from "./clients/anthropic.js";
import { ElevenLabsClient } from "./clients/elevenlabs.js";
import { FalClient } from "./clients/fal.js";
import { HiggsfieldClient } from "./clients/higgsfield.js";
import { OllamaClient } from "./clients/ollama.js";
import { OpenAiClient } from "./clients/openai.js";
import { captureProviderClient } from "./capture.js";
import type { FetchLike, ProviderCallCapture, ProviderClient } from "./types.js";

/**
 * The client registry (T-9): one instance per provider, declarations included. Kokoro and
 * whisper.cpp run inside the Voxa sidecar (SPEC-011) and have no HTTP client here — their
 * manifest entries are gated by runtime detection, not by a credential.
 */
export function createProviderClients(fetchImpl: FetchLike, capture?: ProviderCallCapture): Partial<Record<ProviderId, ProviderClient>> {
  return {
    fal: captureProviderClient("fal", (fetch) => new FalClient(fetch), fetchImpl, capture),
    higgsfield: captureProviderClient("higgsfield", (fetch) => new HiggsfieldClient(fetch), fetchImpl, capture),
    openai: captureProviderClient("openai", (fetch) => new OpenAiClient(fetch), fetchImpl, capture),
    anthropic: captureProviderClient("anthropic", (fetch) => new AnthropicClient(fetch), fetchImpl, capture),
    elevenlabs: captureProviderClient("elevenlabs", (fetch) => new ElevenLabsClient(fetch), fetchImpl, capture),
    ollama: captureProviderClient("ollama", (fetch) => new OllamaClient(fetch), fetchImpl, capture),
  };
}

/** The declarations table alone, for consumers that never dispatch (SPEC-009 strategy tests). */
export const PROVIDER_DECLARATIONS: Partial<Record<ProviderId, ClientDeclarations>> = Object.fromEntries(
  Object.entries(createProviderClients((() => Promise.reject(new Error("declarations-only"))) as FetchLike)).map(
    ([id, client]) => [id, client.declarations],
  ),
);
