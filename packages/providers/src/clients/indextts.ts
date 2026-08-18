import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/** Where the IndexTTS engine is listening, or null when it is not running. */
export type EngineBaseUrl = () => string | null;

/**
 * IndexTTS 2.5 — local cloned speech, through a supervised engine on loopback (SPEC-022).
 *
 * Deliberately the Kokoro client with a different base URL and a richer body, because being local
 * changes nothing about how a take is made: every take is a job, so local rides the same queue as
 * the cloud rather than forking the machinery. There is no credential, so `validateKey` reports
 * whether the engine is *reachable*; the manifest row is gated by hardware detection instead
 * (`requires.vramMb`, R-22). The port is assigned at launch, so the base URL is resolved per call.
 *
 * The one real difference from Kokoro is what a voice IS. Kokoro takes a preset name; this engine
 * clones from a clip, so the request carries a resolved path to that clip. Resolution happens
 * before dispatch — the library owns the id→clip mapping (SPEC-022 §2.3) and the engine stays
 * ignorant of it, which is what keeps the engine a synthesiser rather than a second catalogue.
 */
export class IndexTtsClient implements ProviderClient {
  readonly id = "indextts" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  private readonly completed = new Map<string, FetchedArtifact[]>();
  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: EngineBaseUrl,
  ) {}

  /**
   * The remedy, not an ENOENT. A machine whose engine never started should read as "local cloned
   * voice is not running", the same posture as the missing Higgsfield runner and Kokoro (R-4).
   */
  private require(): string {
    const base = this.baseUrl();
    if (base === null) {
      throw new Error(
        "indextts: the local voice engine is not running — start it in Settings, or choose a cloud voice",
      );
    }
    return base;
  }

  /**
   * Reachability, per capability. Both are reported because the engine unlocks both by existing:
   * it synthesises and it clones, and neither is gated by a secret (SPEC-022 §1.3).
   */
  async validateKey(): Promise<CapabilityProbe[]> {
    const base = this.baseUrl();
    const unavailable = (reason: string): CapabilityProbe[] => [
      { capability: "voice-tts", available: false, reason },
      { capability: "voice-clone", available: false, reason },
    ];
    if (base === null) return unavailable("the local voice engine is not running");
    try {
      const res = await this.fetchImpl(`${base}/health`, { method: "GET" });
      if (res.status >= 400) return unavailable(`the local voice engine answered HTTP ${res.status}`);
      // Readiness is not liveness: the process answers long before it can speak, because weights
      // load and the first synthesis compiles. A `ready: false` engine is reachable and NOT usable,
      // and saying so is the difference between a wait and a failed take (SPEC-022 §2.2).
      const body = (await res.json().catch(() => null)) as { ready?: boolean; reason?: string } | null;
      if (body?.ready === false) {
        return unavailable(body.reason ?? "the local voice engine is still starting");
      }
      return [
        { capability: "voice-tts", available: true },
        { capability: "voice-clone", available: true },
      ];
    } catch (err) {
      return unavailable(`the local voice engine could not be reached: ${String(err)}`);
    }
  }

  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    const base = this.require();
    // The clip, already resolved from the voice library. A voice id alone would make the engine
    // look up something only the app can know.
    const speakerFile = String(request.params["speakerFile"] ?? "");
    if (!speakerFile) throw new Error("indextts: params.speakerFile is required");
    const text = String(request.params["text"] ?? "");
    // The delivery arrives already mapped to this engine's vocabulary — an 8-float emotion vector
    // plus alpha and a duration factor — or absent, and absent means the model's own defaults.
    const shaping = (request.params["voiceSettings"] ?? {}) as Record<string, unknown>;
    const res = await this.fetchImpl(`${base}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: speakerFile, text, ...shaping }),
    });
    if (res.status >= 400) throw new Error(`indextts: synthesis failed (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    // The engine answers with RIFF/WAVE; anything else means the port belongs to something that is
    // not our engine, which is worth saying before the bytes are filed as a take.
    const riff = data.length > 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46;
    if (!riff) throw new Error("indextts: the engine did not answer with a WAV");
    const remoteId = `indextts-${++this.counter}-${data.byteLength}`;
    this.completed.set(remoteId, [{ name: "speech.wav", contentType: "audio/wav", data }]);
    return { remoteId, acceptedAt: new Date().toISOString() };
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    return this.completed.has(remoteId)
      ? { state: "succeeded" }
      : { state: "failed", error: "indextts: unknown request id (synchronous engine)" };
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const hit = this.completed.get(remoteId);
    if (!hit) throw new Error("indextts: no cached result for this id");
    return hit;
  }

  async cancel(): Promise<void> {
    /* synchronous engine: by the time there is an id, the bytes already exist */
  }
}
