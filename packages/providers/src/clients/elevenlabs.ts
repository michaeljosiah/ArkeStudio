import { createHash } from "node:crypto";
import type { CapabilityProbe, ClientDeclarations, VoiceCandidate } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import { SHIPPED_MANIFEST } from "../manifest-data.js";
import {
  ProviderAuthError,
  ProviderBusyError,
  ProviderPaymentRequiredError,
  ProviderRequestRejectedError,
  type FetchedArtifact,
  type FetchLike,
  type PollResult,
  type ProviderClient,
  type SubmitRequest,
  type SubmitResult,
} from "../types.js";

/**
 * The readers a voice is listed under: every shipped ElevenLabs speech row. A catalogue entry is
 * matched to a narrator or a sheet by provider, model and voice together, so a voice listed only
 * under Multilingual v2 could never be read by v3 — the row existed and nothing could reach it.
 */
const SPEECH_MODELS = SHIPPED_MANIFEST.models.filter((model) => model.provider === "elevenlabs" && model.capability === "voice-tts").map((model) => model.id);

/**
 * A professional clone is trained per model, and v4 needs its own pass ("open My Voices, hover
 * the voice, click + next to Eleven v4"), which the voice reports as one of its
 * `high_quality_base_model_ids`. Offering it to v4 before then would only fail at the read.
 */
function readsWith(voice: { category?: string; high_quality_base_model_ids?: unknown }, model: string): boolean {
  if (model !== "eleven_v4" || voice.category !== "professional" || !Array.isArray(voice.high_quality_base_model_ids)) return true;
  return voice.high_quality_base_model_ids.includes("eleven_v4");
}

/**
 * ElevenLabs names a refusal in `detail.status`, and two of them are not what their status
 * says: a spent character quota arrives as a 401, which read as a rejected key sends the person
 * to replace a key that works, and a full house — `too_many_concurrent_requests`,
 * `system_busy` — is a 429 that clears by itself. Either way the request was not taken.
 */
async function refusal(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { detail?: { status?: unknown; message?: unknown } } | null;
  const status = typeof body?.detail?.status === "string" ? body.detail.status : "";
  if (status === "quota_exceeded") return new ProviderPaymentRequiredError(`elevenlabs: this account's character quota is used up (HTTP ${res.status} quota_exceeded)`);
  if (res.status === 429) return new ProviderBusyError(`elevenlabs: ElevenLabs is busy (HTTP 429${status ? ` ${status}` : ""})`, { witnessed: true });
  const said = typeof body?.detail?.message === "string" && body.detail.message.trim() ? `: ${body.detail.message.trim().slice(0, 200)}` : "";
  if (res.status === 401 || res.status === 403) return new ProviderAuthError("elevenlabs", `elevenlabs: ${what} was rejected${said} (HTTP ${res.status})`);
  if (res.status >= 500) return new Error(`elevenlabs: ${what} failed (HTTP ${res.status})`);
  return new ProviderRequestRejectedError(`elevenlabs: ${what} failed (HTTP ${res.status}${status ? ` ${status}` : ""})`);
}

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
      // A key can be scoped. One without `user_read` authenticates and still cannot read the
      // subscription this probe asks for — ElevenLabs says so, by name — and calling that a
      // rejected key sent the owner to replace a key that may read perfectly well (2026-10-07).
      // Speech is offered on it, unquoted against the quota; a read the key cannot make is
      // refused at the read with ElevenLabs' own words.
      const missing = /missing the permission (\w+)/i.exec(probe.message)?.[1];
      if (probe.auth && missing === "user_read") {
        const reason = "this key cannot read the subscription (it lacks the User: Read permission), so its plan is unknown";
        return [{ capability: "voice-tts", available: true }, { capability: "voice-clone", available: false, reason }, { capability: "voice-conversion", available: false, reason }];
      }
      const said = probe.message.replace(/^elevenlabs: /, "").replace(/ \(HTTP \d+\)$/, "");
      const reason = probe.auth ? `ElevenLabs rejected this key: ${said}` : `ElevenLabs could not be reached: ${probe.message}`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
        { capability: "voice-conversion", available: false, reason },
      ];
    }
    const sub = probe.value.body as {
      tier?: string;
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
    const models = await tryProbe(() => jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/models`, { headers: this.headers(key) }));
    const conversionAvailable = !overQuota && models.ok && Array.isArray(models.value.body) && models.value.body.some(
      (m: { model_id?: string; can_do_voice_conversion?: boolean }) => m.model_id === "eleven_multilingual_sts_v2" && m.can_do_voice_conversion === true);
    return [tts, clone, conversionAvailable ? { capability: "voice-conversion", available: true, zeroRetention: sub?.tier === "enterprise" } : {
      capability: "voice-conversion", available: false, reason: "The account did not expose the Multilingual speech-to-speech model, or its quota is exhausted." }];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    if (request.capability === "voice-conversion") return this.convert(key, request);
    if (request.capability !== "voice-tts") throw new ProviderRequestRejectedError("elevenlabs: unsupported synthesis capability");
    const remoteId = `elevenlabs-${++this.counter}-${Date.now()}`;
    const voiceId = String(request.params["voiceId"] ?? "");
    if (!voiceId) throw new Error("elevenlabs: params.voiceId is required");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        model_id: request.model === "eleven-v3" ? "eleven_v3" : request.model,
        text: String(request.params["text"] ?? ""),
        ...(request.params["voiceSettings"] !== undefined ? { voice_settings: request.params["voiceSettings"] } : {}),
      }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (res.status >= 400) throw await refusal(res, res.status === 401 || res.status === 403 ? "the credential" : "synthesis");
    const data = new Uint8Array(await res.arrayBuffer());
    return {
      remoteId,
      acceptedAt: new Date().toISOString(),
      artifacts: [{ name: "speech.mp3", contentType: "audio/mpeg", data }],
    };
  }

  private async convert(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const input = request.audioInputs?.[0];
    const voiceId = request.params.voiceId;
    if (request.model !== "eleven_multilingual_sts_v2" || typeof voiceId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(voiceId) ||
      request.audioInputs?.length !== 1 || !input?.data.byteLength || !["audio/wav", "audio/mpeg"].includes(input.contentType) ||
      !Number.isFinite(input.durationSec) || input.durationSec <= 0 || input.durationSec > 300 ||
      input.hash !== `sha256:${createHash("sha256").update(input.data).digest("hex")}`) {
      throw new ProviderRequestRejectedError("elevenlabs: invalid voice-conversion input or target");
    }
    if (request.params.retention !== "provider-history" && request.params.retention !== "zero-retention") throw new ProviderRequestRejectedError("elevenlabs: choose a retention mode");
    const models = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/models`, { headers: this.headers(key) });
    if (models.status >= 400 || !Array.isArray(models.body) || !models.body.some((m: { model_id?: string; can_do_voice_conversion?: boolean }) =>
      m.model_id === request.model && m.can_do_voice_conversion === true)) throw new ProviderRequestRejectedError("elevenlabs: this account cannot use the selected voice conversion model");
    if (request.params.retention === "zero-retention") {
      const subscription = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/user/subscription`, { headers: this.headers(key) });
      if (subscription.status >= 400 || (subscription.body as { tier?: string })?.tier !== "enterprise") throw new ProviderRequestRejectedError("elevenlabs: zero retention requires an enterprise account");
    }
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(input.data)], { type: input.contentType }), input.name);
    form.append("model_id", request.model);
    form.append("file_format", "other");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128&enable_logging=${request.params.retention === "provider-history"}`, {
      method: "POST", headers: { "xi-api-key": key }, body: form, ...(request.signal ? { signal: request.signal } : {}),
    });
    if (res.status >= 400) throw await refusal(res, res.status === 401 || res.status === 403 ? "conversion permission" : "conversion");
    const data = new Uint8Array(await res.arrayBuffer());
    if (!data.length) throw new Error("elevenlabs: conversion returned empty audio");
    return { remoteId: res.headers.get("request-id") ?? `elevenlabs-sts-${++this.counter}-${Date.now()}`,
      acceptedAt: new Date().toISOString(), artifacts: [{ name: "conversion.mp3", contentType: "audio/mpeg", data }] };
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
  async listVoicesCatalog(key: string): Promise<VoiceCandidate[]> {
    type Voice = { voice_id?: string; name?: string; labels?: Record<string, string>; description?: string | null; preview_url?: string | null;
      category?: string; high_quality_base_model_ids?: unknown };
    const voices: Voice[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (token) query.set("next_page_token", token);
      const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v2/voices?${query}`, { headers: this.headers(key) });
      const page = body as { voices?: Voice[]; has_more?: boolean; next_page_token?: string } | null;
      if (status >= 400 || !Array.isArray(page?.voices)) throw new Error("ElevenLabs voice catalogue could not be loaded.");
      voices.push(...page.voices);
      if (!page.has_more) break;
      token = page.next_page_token;
      if (!token || tokens.has(token) || tokens.size >= 1000) throw new Error("ElevenLabs returned an incomplete voice catalogue.");
      tokens.add(token);
    } while (true);
    const unique = new Map(voices.filter(v => typeof v.voice_id === "string" && typeof v.name === "string").map(v => [v.voice_id!, v]));
    return [...unique.values()].flatMap((v) => SPEECH_MODELS.filter((model) => readsWith(v, model)).map((model) => ({
        provider: "elevenlabs",
        model,
        voiceId: v.voice_id!,
        label: v.name!,
        attributes: Object.values(v.labels ?? {}).filter(s => typeof s === "string").map((s) => s.toLowerCase()),
        ...(v.description ? { description: v.description } : {}),
        facets: Object.fromEntries(["language", "accent", "gender", "style"].flatMap(facet => {
          const value = v.labels?.[facet] ?? (facet === "style" ? v.labels?.["use_case"] ?? v.labels?.["descriptive"] : undefined);
          return typeof value === "string" && value.trim() ? [[facet, value.trim().toLowerCase()]] : [];
        })),
        ...(v.preview_url?.startsWith("https://") ? { previewUrl: v.preview_url } : {}),
        local: false,
        canClone: true, // ElevenLabs supports cloning; each engine declares its own capability
      })));
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
