import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/**
 * ElevenLabs — direct voice provider. The subscription read is the probe: free, and it names
 * plan limits, so "authenticates but out of characters" is distinguishable from "invalid key"
 * (R-3). History listing exists → reconciliation can search recent generations (T-9). Costs
 * come back as character counts, never dollars → manifest-derived (R-17).
 */
export class ElevenLabsClient implements ProviderClient {
  readonly id = "elevenlabs" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: true,
    reportsCost: false,
  };

  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://api.elevenlabs.io",
  ) {}

  private headers(key: string): Record<string, string> {
    return { "xi-api-key": key, "Content-Type": "application/json" };
  }

  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/user/subscription`, { headers: this.headers(key) }),
    );
    if (!probe.ok) {
      const reason = probe.auth ? "ElevenLabs rejected this key" : `ElevenLabs could not be reached: ${probe.message}`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
      ];
    }
    const sub = probe.value.body as {
      character_count?: number;
      character_limit?: number;
      can_use_instant_voice_cloning?: boolean;
    } | null;
    const used = sub?.character_count ?? 0;
    const limit = sub?.character_limit ?? 0;
    const overQuota = limit > 0 && used >= limit;
    const tts: CapabilityProbe = overQuota
      ? {
          capability: "voice-tts",
          available: false,
          reason: `the key authenticates but the character quota is exhausted (${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} used)`,
        }
      : { capability: "voice-tts", available: true };
    const clone: CapabilityProbe = sub?.can_use_instant_voice_cloning
      ? { capability: "voice-clone", available: true }
      : { capability: "voice-clone", available: false, reason: "this plan does not include voice cloning" };
    return [tts, clone];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const remoteId = `elevenlabs-${++this.counter}-${Date.now()}`;
    const voiceId = String(request.params["voiceId"] ?? "");
    if (!voiceId) throw new Error("elevenlabs: params.voiceId is required");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        model_id: request.model,
        text: String(request.params["text"] ?? ""),
        ...(request.params["voiceSettings"] !== undefined ? { voice_settings: request.params["voiceSettings"] } : {}),
      }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`elevenlabs: the credential was rejected (HTTP ${res.status})`);
    }
    if (res.status >= 400) throw new Error(`elevenlabs: synthesis failed (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    return {
      remoteId,
      acceptedAt: new Date().toISOString(),
      artifacts: [{ name: "speech.mp3", contentType: "audio/mpeg", data }],
    };
  }

  async poll(_key: string, _remoteId: string): Promise<PollResult> {
    return { state: "failed", error: "elevenlabs: synchronous results must be returned by submit" };
  }

  async fetchArtifacts(_key: string, _remoteId: string): Promise<FetchedArtifact[]> {
    throw new Error("elevenlabs: synchronous artifacts are returned by submit");
  }

  async cancel(): Promise<void> {
    /* synchronous API */
  }

  /** The cloud voice catalogue (SPEC-011 R-6): labels plus descriptive attributes for matching. */
  async listVoicesCatalog(key: string): Promise<
    Array<{ provider: string; model: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
  > {
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/voices`, {
      headers: this.headers(key),
    });
    if (status >= 400) return [];
    const voices =
      (body as { voices?: Array<{ voice_id?: string; name?: string; labels?: Record<string, string> }> } | null)
        ?.voices ?? [];
    return voices
      .filter((v) => typeof v.voice_id === "string" && typeof v.name === "string")
      .map((v) => ({
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        voiceId: v.voice_id!,
        label: v.name!,
        attributes: Object.values(v.labels ?? {}).map((s) => s.toLowerCase()),
        local: false,
        canClone: true, // ElevenLabs supports cloning; each engine declares its own capability
      }));
  }

  /**
   * Reconciliation strategy B (supportsListRecent): the recent-generation history. ElevenLabs
   * carries no caller metadata, so `idempotencyKey` is never present — the reconciler treats a
   * keyless listing as inconclusive and escalates to asking the user rather than guessing.
   */
  async listRecent(key: string): Promise<Array<{ remoteId: string; idempotencyKey?: string; createdAt: string }>> {
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/history?page_size=25`, {
      headers: this.headers(key),
    });
    if (status >= 400) return [];
    const items = (body as { history?: Array<{ history_item_id?: string; date_unix?: number }> } | null)?.history ?? [];
    return items
      .filter((h) => typeof h.history_item_id === "string")
      .map((h) => ({
        remoteId: h.history_item_id!,
        createdAt: h.date_unix !== undefined ? new Date(h.date_unix * 1000).toISOString() : "",
      }));
  }
}
