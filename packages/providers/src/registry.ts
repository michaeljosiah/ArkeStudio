import type { ClientDeclarations, ProviderId } from "@arke-studio/contracts";
import { AnthropicClient } from "./clients/anthropic.js";
import { ComfyUiClient, type ComfyUiPreflight, type EngineBaseUrl } from "./clients/comfyui.js";
import { ElevenLabsClient } from "./clients/elevenlabs.js";
import { FalClient } from "./clients/fal.js";
import { HiggsfieldClient } from "./clients/higgsfield.js";
import { IndexTtsClient, type EngineBaseUrl as IndexTtsBaseUrl } from "./clients/indextts.js";
import { KokoroClient, type SidecarBaseUrl } from "./clients/kokoro.js";
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
  /**
   * Where the Voxa sidecar is listening, resolved per call. Omitted where local voice cannot
   * run at all — the Kokoro client is then absent rather than present and always failing.
   */
  voxa?: SidecarBaseUrl;
  /**
   * Where the IndexTTS engine is listening (SPEC-022), resolved per call for the same reason
   * Voxa's is: the port is assigned at launch, and a client that captured it at construction
   * would keep pointing at a dead port across a restart. Omitted where local cloned voice cannot
   * run — the client is then absent rather than present and always failing.
   */
  indextts?: IndexTtsBaseUrl;
  /**
   * The ComfyUI engine (SPEC-021): where it listens right now, and the pre-flight verification
   * every submit re-runs before touching the wire (§2.5). Omitted where no engine service is
   * wired — the client is then absent rather than present and dispatching unverified.
   */
  comfyui?: { baseUrl: EngineBaseUrl; preflight: ComfyUiPreflight };
  capture?: ProviderCallCapture;
}

/**
 * The client registry (T-9): one instance per provider, declarations included.
 *
 * Kokoro is here (design 70) but is not a cloud client: it reaches the local Voxa sidecar over
 * loopback and has no credential, so its manifest row is gated by runtime detection rather
 * than by a secret. It exists so a local read is a job like any other — numbered, priced at
 * nothing, re-runnable and recoverable — instead of a second path around the queue. whisper.cpp
 * is still absent: transcription never travels this way.
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
    // The only client taking both seams: the CLI carries submit, poll and status, and the
    // artifact bytes still arrive over HTTP. Both halves are instrumented.
    higgsfield: captureProviderClient(
      "higgsfield",
      (fetch, run) => new HiggsfieldClient(run, fetch),
      fetchImpl,
      capture,
      higgsfield,
    ),
    openai: captureProviderClient("openai", (fetch) => new OpenAiClient(fetch), fetchImpl, capture),
    anthropic: captureProviderClient("anthropic", (fetch) => new AnthropicClient(fetch), fetchImpl, capture),
    elevenlabs: captureProviderClient("elevenlabs", (fetch) => new ElevenLabsClient(fetch), fetchImpl, capture),
    ollama: captureProviderClient("ollama", (fetch) => new OllamaClient(fetch), fetchImpl, capture),
    ...(deps.voxa === undefined
      ? {}
      : {
          kokoro: captureProviderClient(
            "kokoro",
            (fetch) => new KokoroClient(fetch, deps.voxa!),
            fetchImpl,
            capture,
          ),
        }),
    ...(deps.indextts === undefined
      ? {}
      : {
          indextts: captureProviderClient(
            "indextts",
            (fetch) => new IndexTtsClient(fetch, deps.indextts!),
            fetchImpl,
            capture,
          ),
        }),
    ...(deps.comfyui === undefined
      ? {}
      : {
          comfyui: captureProviderClient(
            "comfyui",
            (fetch) => new ComfyUiClient(fetch, deps.comfyui!.baseUrl, deps.comfyui!.preflight),
            fetchImpl,
            capture,
          ),
        }),
  };
}

/** The declarations table alone, for consumers that never dispatch (SPEC-009 strategy tests). */
export const PROVIDER_DECLARATIONS: Partial<Record<ProviderId, ClientDeclarations>> = Object.fromEntries(
  Object.entries(
    createProviderClients({
      fetch: (() => Promise.reject(new Error("declarations-only"))) as FetchLike,
      higgsfield: () => Promise.reject(new Error("declarations-only")),
      comfyui: {
        baseUrl: () => null,
        preflight: () => Promise.reject(new Error("declarations-only")),
      },
    }),
  ).map(([id, client]) => [id, client.declarations]),
);
