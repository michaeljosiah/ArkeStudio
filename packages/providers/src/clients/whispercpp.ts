import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";
import type { SidecarBaseUrl } from "./kokoro.js";

/** Queue-backed calls receive the desktop's single Voxa client, so all whisper work shares its lane. */
export type WhisperTranscribe = (
  input: { audio: Uint8Array; contentType: string },
  options?: { signal?: AbortSignal },
) => Promise<string>;

/**
 * whisper.cpp — local transcription, through the Voxa sidecar (issue 462).
 *
 * Kokoro's twin, and for the same reason. Local transcription already had a path: dictation
 * calls the sidecar directly, out of band, producing no job, no ledger entry and no artefact,
 * and dropping the recording the moment it has a transcript (SPEC-018 R-13). That is right for
 * speaking into a composer, and wrong for anything that needs the transcript to *survive* —
 * numbered, re-runnable, recoverable after a crash, and landed where the rest of a production's
 * work lands. Rather than fork the queue for one provider, transcription that must persist rides
 * the same lane as the cloud through this client, and dictation keeps its direct path untouched.
 *
 * The provider table said whisper.cpp served `voice-stt` while the registry built nothing for it
 * (issue 462). `whispercpp` takes no credential, so its status was `configured` from birth and
 * `untested` forever — which `deriveCapabilityAvailability` reads as *available*. The capability
 * was being offered by a row, not by a runtime. What closes that is a client whose `validateKey`
 * asks the sidecar whether Whisper is actually loaded.
 *
 * Two things follow from being local, both inherited from Kokoro. There is no credential, so
 * `validateKey` reports whether the engine is *reachable and loaded* rather than whether a key
 * authenticates. And the sidecar's port is assigned at launch, so the base URL is resolved per
 * call: a client that captured it at construction would keep pointing at a dead port across a
 * restart.
 */
export class WhisperCppClient implements ProviderClient {
  readonly id = "whispercpp" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: SidecarBaseUrl,
    private readonly transcribe?: WhisperTranscribe,
  ) {}

  /**
   * The remedy, not an ECONNREFUSED. A machine whose sidecar never started should read as
   * "local transcription is not running", the same posture as the missing Higgsfield runner (R-4).
   */
  private require(): string {
    const base = this.baseUrl();
    if (base === null) {
      throw new Error("whispercpp: local transcription is not running — start Voxa in Settings");
    }
    return base;
  }

  async validateKey(): Promise<CapabilityProbe[]> {
    const base = this.baseUrl();
    if (base === null) {
      return [{ capability: "voice-stt", available: false, reason: "the Voxa sidecar is not running" }];
    }
    try {
      const res = await this.fetchImpl(`${base}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3_000),
      });
      if (res.status >= 400) {
        return [{ capability: "voice-stt", available: false, reason: `the Voxa sidecar answered HTTP ${res.status}` }];
      }
      const body = (await res.json().catch(() => null)) as {
        engineStatus?: { whisper?: { ready?: unknown; reason?: unknown } };
      } | null;
      const whisper = body?.engineStatus?.whisper;
      if (whisper?.ready === true) return [{ capability: "voice-stt", available: true }];
      if (whisper?.ready === false) {
        const reason = typeof whisper.reason === "string" ? whisper.reason : "Whisper is not ready";
        return [{ capability: "voice-stt", available: false, reason }];
      }
      return [
        { capability: "voice-stt", available: false, reason: "the Voxa health response omitted Whisper readiness" },
      ];
    } catch (err) {
      return [
        { capability: "voice-stt", available: false, reason: `the Voxa sidecar could not be reached: ${String(err)}` },
      ];
    }
  }

  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    const base = this.require();
    // The recording arrives on its own field, never in `params` — see PreparedAudioSource.
    const source = request.audioSource;
    if (!source || source.data.byteLength === 0) {
      throw new Error("whispercpp: request.audioSource is required — there is nothing to transcribe");
    }
    const directTranscription = this.transcribe;
    const text = directTranscription
      ? await directTranscription(
          { audio: source.data, contentType: source.contentType },
          request.signal === undefined ? undefined : { signal: request.signal },
        )
      : await this.fetchImpl(`${base}/stt`, {
          method: "POST",
          headers: { "Content-Type": source.contentType },
          body: source.data,
          signal: request.signal === undefined
            ? AbortSignal.timeout(60_000)
            : AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
        }).then(async (res) => {
          if (res.status >= 400) throw new Error(`whispercpp: transcription failed (HTTP ${res.status})`);
          const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
          if (typeof body?.text !== "string") {
            // A port that belongs to something other than Voxa answers 200 with anything at
            // all. Saying so beats filing whatever it was as a transcript.
            throw new Error("whispercpp: the sidecar did not answer with a transcript");
          }
          return body.text;
        });
    const trimmed = text.trim();
    // Silence is a real outcome, but an empty artifact is not one the landing path can verify —
    // it reads as "empty download", which blames the transport for a recording with no speech
    // in it. Naming it here is the honest answer, and the re-run is the person's to choose.
    if (trimmed.length === 0) {
      throw new Error("whispercpp: the recording transcribed to nothing — no speech was detected");
    }
    const data = new TextEncoder().encode(trimmed);
    const remoteId = `whispercpp-${++this.counter}-${data.byteLength}`;
    return {
      remoteId,
      acceptedAt: new Date().toISOString(),
      artifacts: [{ name: "transcript.txt", contentType: "text/plain; charset=utf-8", data }],
    };
  }

  async poll(_key: string, _remoteId: string): Promise<PollResult> {
    return { state: "failed", error: "whispercpp: synchronous results must be returned by submit" };
  }

  async fetchArtifacts(_key: string, _remoteId: string): Promise<FetchedArtifact[]> {
    throw new Error("whispercpp: synchronous artifacts are returned by submit");
  }

  async cancel(): Promise<void> {
    /* synchronous engine: by the time there is an id, the transcript already exists */
  }
}
