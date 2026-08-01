import type { ClientDeclarations, ProviderId } from "@arke-studio/contracts";
import { AnthropicClient } from "./clients/anthropic.js";
import { ElevenLabsClient } from "./clients/elevenlabs.js";
import { FalClient } from "./clients/fal.js";
import { HiggsfieldClient } from "./clients/higgsfield.js";
import { OllamaClient } from "./clients/ollama.js";
import { OpenAiClient } from "./clients/openai.js";
import type { FetchLike, ProviderClient } from "./types.js";

/**
 * The client registry (T-9): one instance per provider, declarations included. Kokoro and
 * whisper.cpp run inside the Voxa sidecar (SPEC-011) and have no HTTP client here — their
 * manifest entries are gated by runtime detection, not by a credential.
 */
export function createProviderClients(fetchImpl: FetchLike): Partial<Record<ProviderId, ProviderClient>> {
  return {
    fal: new FalClient(fetchImpl),
    higgsfield: new HiggsfieldClient(fetchImpl),
    openai: new OpenAiClient(fetchImpl),
    anthropic: new AnthropicClient(fetchImpl),
    elevenlabs: new ElevenLabsClient(fetchImpl),
    ollama: new OllamaClient(fetchImpl),
  };
}

/** The declarations table alone, for consumers that never dispatch (SPEC-009 strategy tests). */
export const PROVIDER_DECLARATIONS: Partial<Record<ProviderId, ClientDeclarations>> = Object.fromEntries(
  Object.entries(createProviderClients((() => Promise.reject(new Error("declarations-only"))) as FetchLike)).map(
    ([id, client]) => [id, client.declarations],
  ),
);
