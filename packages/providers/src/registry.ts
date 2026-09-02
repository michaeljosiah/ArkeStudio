import type { ClientDeclarations, ProviderId } from "@arke-studio/contracts";
import { AnthropicClient } from "./clients/anthropic.js";
import {
  ComfyUiClient,
  type ComfyUiPreflight,
  type EngineBaseUrl,
  type EngineLocality,
  type ProgressSocket,
} from "./clients/comfyui.js";
import { ElevenLabsClient } from "./clients/elevenlabs.js";
import { FalClient } from "./clients/fal.js";
import { HiggsfieldClient } from "./clients/higgsfield.js";
import { KokoroClient, type KokoroSynthesize, type SidecarBaseUrl } from "./clients/kokoro.js";
import { OllamaClient } from "./clients/ollama.js";
import { OpenAiClient } from "./clients/openai.js";
import { WhisperCppClient, type WhisperTranscribe } from "./clients/whispercpp.js";
import { captureProviderClient } from "./capture.js";
import { missingHiggsfieldRunner } from "./higgsfield-cli.js";
import type { CommandRunner, FetchLike, ProviderCallCapture, ProviderClient, ProviderTransport } from "./types.js";

export interface ProviderClientDeps {
  fetch: FetchLike;
  /** Desktop-owned cloud HTTP policy. Local engines retain their own scoped transports. */
  transport?: ProviderTransport;
  /**
   * The Higgsfield CLI, already bound to a discovered command. Omitted when no CLI was found:
   * every call then fails with the remedy rather than an ENOENT, so an unset-up machine reads
   * as "Higgsfield is not installed" instead of as the shot having failed (R-4).
   */
  higgsfield?: CommandRunner;
  /**
   * Where the Voxa sidecar is listening, resolved per call. Omitted where local voice cannot
   * run at all — the Kokoro and whisper.cpp clients are then absent rather than present and
   * always failing.
   */
  voxa?: SidecarBaseUrl;
  /** Host-owned synthesis path shared with direct Voxa callers, including its global scheduler. */
  voxaSynthesize?: KokoroSynthesize;
  /** Host-owned transcription path shared with direct Voxa callers, including its cancellation. */
  voxaTranscribe?: WhisperTranscribe;
  /**
   * The ComfyUI engine (SPEC-021): where it listens right now, and the pre-flight verification
   * every submit re-runs before touching the wire (§2.5). Omitted where no engine service is
   * wired — the client is then absent rather than present and dispatching unverified.
   */
  comfyui?: {
    /** A transport scoped to the engine, where loopback connection policy may differ from cloud HTTP. */
    fetch?: FetchLike;
    baseUrl: EngineBaseUrl;
    preflight: ComfyUiPreflight;
    /** Opens the engine's progress socket (SPEC-021 D16); omitted, jobs simply report no figure. */
    openSocket?: (url: string) => ProgressSocket;
    /** Free graphics memory right now, in MB, or null where the device cannot be asked. */
    freeVramMb?: () => Promise<number | null>;
    locality?: EngineLocality;
  };
  capture?: ProviderCallCapture;
}

/**
 * The client registry (T-9): one instance per provider, declarations included.
 *
 * Kokoro and whisper.cpp are here (design 70, issue 462) but are not cloud clients: they reach
 * the local Voxa sidecar over loopback and have no credential, so their manifest rows are gated
 * by runtime detection rather than by a secret. They exist so a local read is a job like any
 * other — numbered, priced at nothing, re-runnable and recoverable — instead of a second path
 * around the queue. Both are absent when no sidecar is wired, rather than present and always
 * failing; that absence is the whole point, because a keyless provider with no client reads as
 * *available* to `deriveCapabilityAvailability` and there is nothing behind it.
 *
 * Push-to-talk dictation is deliberately NOT this path and keeps calling the sidecar directly:
 * its recording is dropped the moment there is a transcript (SPEC-018 R-13), and a job would
 * journal the one thing that must not persist.
 *
 * Higgsfield is the one client driven partly as a subprocess (issue #137): submit, poll and
 * status calls are captured as ProviderCallRecords with method EXEC, while artifact bytes are
 * downloaded and captured over HTTP. Both seams pass through captureProviderClient.
 */
export function createProviderClients(deps: ProviderClientDeps): Partial<Record<ProviderId, ProviderClient>> {
  const { fetch: fetchImpl, capture, transport } = deps;
  const higgsfield = deps.higgsfield ?? missingHiggsfieldRunner();
  return {
    fal: captureProviderClient("fal", (fetch) => new FalClient(fetch), fetchImpl, capture, undefined, transport),
    // The only client taking both seams: the CLI carries submit, poll and status, and the
    // artifact bytes still arrive over HTTP. Both halves are instrumented.
    higgsfield: captureProviderClient(
      "higgsfield",
      (fetch, run) => new HiggsfieldClient(run, fetch),
      fetchImpl,
      capture,
      higgsfield,
      transport,
      (operation) => operation === "fetch-artifacts",
    ),
    openai: captureProviderClient("openai", (fetch) => new OpenAiClient(fetch), fetchImpl, capture, undefined, transport),
    anthropic: captureProviderClient(
      "anthropic",
      (fetch) => new AnthropicClient(fetch),
      fetchImpl,
      capture,
      undefined,
      transport,
    ),
    elevenlabs: captureProviderClient(
      "elevenlabs",
      (fetch) => new ElevenLabsClient(fetch),
      fetchImpl,
      capture,
      undefined,
      transport,
    ),
    ollama: captureProviderClient("ollama", (fetch) => new OllamaClient(fetch), fetchImpl, capture),
    ...(deps.voxa === undefined
      ? {}
      : {
          kokoro: captureProviderClient(
            "kokoro",
            (fetch) => new KokoroClient(fetch, deps.voxa!, deps.voxaSynthesize),
            fetchImpl,
            capture,
          ),
          whispercpp: captureProviderClient(
            "whispercpp",
            (fetch) => new WhisperCppClient(fetch, deps.voxa!, deps.voxaTranscribe),
            fetchImpl,
            capture,
          ),
        }),
    ...(deps.comfyui === undefined
      ? {}
      : {
          comfyui: captureProviderClient(
            "comfyui",
            (fetch) =>
              new ComfyUiClient(
                fetch,
                deps.comfyui!.baseUrl,
                deps.comfyui!.preflight,
                deps.comfyui!.openSocket,
                deps.comfyui!.freeVramMb,
                deps.comfyui!.locality,
              ),
            deps.comfyui!.fetch ?? fetchImpl,
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
      // Wired so the table covers the sidecar-backed providers too. A null base URL is the
      // "not running" answer every one of their calls already handles, and reading declarations
      // makes no call at all.
      voxa: () => null,
      comfyui: {
        baseUrl: () => null,
        preflight: () => Promise.reject(new Error("declarations-only")),
      },
    }),
  ).map(([id, client]) => [id, client.declarations]),
);
