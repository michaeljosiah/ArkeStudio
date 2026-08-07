import type { ClientDeclarations, ProviderId } from "@arke-studio/contracts";
import { AnthropicClient } from "./clients/anthropic.js";
import { ElevenLabsClient } from "./clients/elevenlabs.js";
import { FalClient } from "./clients/fal.js";
import { HiggsfieldClient } from "./clients/higgsfield.js";
import { OllamaClient } from "./clients/ollama.js";
import { OpenAiClient } from "./clients/openai.js";
import { captureProviderClient } from "./capture.js";
import { missingHiggsfieldRunner } from "./higgsfield-cli.js";
import type { CommandRunner, FetchLike, ProviderCallCapture, ProviderClient } from "./types.js";

export interface ProviderClientDeps {
  fetch: FetchLike;
  /**
   * The Higgsfield CLI, already bound to a discovered command. Omitted when no CLI was found:
   * every call then fails with the remedy rather than an ENOENT, so an unset-up machine reads
   * as "Higgsfield is not installed" instead of as the shot having failed (R-4).
   */
  higgsfield?: CommandRunner;
  capture?: ProviderCallCapture;
}

/**
 * The client registry (T-9): one instance per provider, declarations included. Kokoro and
 * whisper.cpp run inside the Voxa sidecar (SPEC-011) and have no client here — their manifest
 * entries are gated by runtime detection, not by a credential.
 *
 * Higgsfield is the one client that is not an HTTP client (issue #137): it drives the vendor's
 * CLI as a subprocess and still takes `fetch`, because results are URLs and the bytes come
 * over HTTP. Only that download half passes through `captureProviderClient` — the subprocess
 * calls produce no ProviderCallRecord yet.
 */
export function createProviderClients(deps: ProviderClientDeps): Partial<Record<ProviderId, ProviderClient>> {
  const { fetch: fetchImpl, capture } = deps;
  const higgsfield = deps.higgsfield ?? missingHiggsfieldRunner();
  return {
    fal: captureProviderClient("fal", (fetch) => new FalClient(fetch), fetchImpl, capture),
    higgsfield: captureProviderClient(
      "higgsfield",
      (fetch) => new HiggsfieldClient(higgsfield, fetch),
      fetchImpl,
      capture,
    ),
    openai: captureProviderClient("openai", (fetch) => new OpenAiClient(fetch), fetchImpl, capture),
    anthropic: captureProviderClient("anthropic", (fetch) => new AnthropicClient(fetch), fetchImpl, capture),
    elevenlabs: captureProviderClient("elevenlabs", (fetch) => new ElevenLabsClient(fetch), fetchImpl, capture),
    ollama: captureProviderClient("ollama", (fetch) => new OllamaClient(fetch), fetchImpl, capture),
  };
}

/** The declarations table alone, for consumers that never dispatch (SPEC-009 strategy tests). */
export const PROVIDER_DECLARATIONS: Partial<Record<ProviderId, ClientDeclarations>> = Object.fromEntries(
  Object.entries(
    createProviderClients({
      fetch: (() => Promise.reject(new Error("declarations-only"))) as FetchLike,
      higgsfield: () => Promise.reject(new Error("declarations-only")),
    }),
  ).map(([id, client]) => [id, client.declarations]),
);
