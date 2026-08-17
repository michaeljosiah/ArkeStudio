import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/** Where the Voxa sidecar is listening, or null when it is not running. */
export type SidecarBaseUrl = () => string | null;

/**
 * Kokoro — local speech, through the Voxa sidecar (design 70).
 *
 * The odd one in this registry, and deliberately so. Local synthesis already had a path: the
 * voice service calls the sidecar directly, out of band, producing no job, no ledger entry and
 * no take. That is right for an audition, and wrong for the bench, where **every take is a
 * job** — which is what makes takes numbered, priced, re-runnable and recoverable after a
 * crash. Rather than fork that machinery for one provider, local rides the same queue as the
 * cloud through this client.
 *
 * Two things follow from being local. There is no credential, so `validateKey` reports whether
 * the sidecar is *reachable* rather than whether a key authenticates — the manifest row is
 * gated by runtime detection, not by a secret. And the sidecar's port is assigned at launch,
 * so the base URL is resolved per call: a client that captured it at construction would keep
 * pointing at a dead port across a restart.
 */
export class KokoroClient implements ProviderClient {
  readonly id = "kokoro" as const;
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
    private readonly baseUrl: SidecarBaseUrl,
  ) {}

  /**
   * The remedy, not an ENOENT. A machine whose sidecar never started should read as "local
   * voice is not running", the same posture as the missing Higgsfield runner (R-4).
   */
  private require(): string {
    const base = this.baseUrl();
    if (base === null) {
      throw new Error("kokoro: local voice is not running — start Voxa in Settings, or choose a cloud voice");
    }
    return base;
  }

  async validateKey(): Promise<CapabilityProbe[]> {
    const base = this.baseUrl();
    if (base === null) {
      return [{ capability: "voice-tts", available: false, reason: "the Voxa sidecar is not running" }];
    }
    try {
      const res = await this.fetchImpl(`${base}/health`, { method: "GET" });
      if (res.status >= 400) {
        return [{ capability: "voice-tts", available: false, reason: `the Voxa sidecar answered HTTP ${res.status}` }];
      }
      return [{ capability: "voice-tts", available: true }];
    } catch (err) {
      return [
        { capability: "voice-tts", available: false, reason: `the Voxa sidecar could not be reached: ${String(err)}` },
      ];
    }
  }

  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    const base = this.require();
    const voiceId = String(request.params["voiceId"] ?? "");
    if (!voiceId) throw new Error("kokoro: params.voiceId is required");
    const text = String(request.params["text"] ?? "");
    // The delivery arrives already mapped to this engine's own vocabulary — Kokoro shapes pace
    // and nothing else, and a delivery it cannot express refused before reaching here.
    const shaping = (request.params["voiceSettings"] ?? {}) as Record<string, number>;
    const res = await this.fetchImpl(`${base}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: voiceId, text, ...shaping }),
    });
    if (res.status >= 400) throw new Error(`kokoro: synthesis failed (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    // The sidecar answers with RIFF/WAVE; anything else means the port belongs to something
    // that is not Voxa, which is worth saying before the bytes are filed as a take.
    const riff = data.length > 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46;
    if (!riff) throw new Error("kokoro: the sidecar did not answer with a WAV");
    const remoteId = `kokoro-${++this.counter}-${data.byteLength}`;
    this.completed.set(remoteId, [{ name: "speech.wav", contentType: "audio/wav", data }]);
    return { remoteId, acceptedAt: new Date().toISOString() };
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    return this.completed.has(remoteId)
      ? { state: "succeeded" }
      : { state: "failed", error: "kokoro: unknown request id (synchronous engine)" };
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const hit = this.completed.get(remoteId);
    if (!hit) throw new Error("kokoro: no cached result for this id");
    return hit;
  }

  async cancel(): Promise<void> {
    /* synchronous engine: by the time there is an id, the bytes already exist */
  }
}
