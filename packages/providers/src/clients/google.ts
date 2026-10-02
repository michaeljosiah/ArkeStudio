import type { CapabilityProbe, ClientDeclarations, SpeechUsage, VoiceCandidate } from "@arke-studio/contracts";
import { randomUUID } from "node:crypto";
import { GOOGLE_FREE_LIMIT, speechInputFits } from "@arke-studio/contracts";
import { GEMINI_SPEECH_INPUT_BYTES, geminiSpeechModel } from "../gemini-tts-models.js";
import { googleVoiceDesignBody, googleVoiceDesignResult, googleDesignedVoicePage, requireGoogleVoiceId } from "./google-voices.js";
import type { VoiceDesignClient, VoiceDesignInput } from "../types.js";
import { ProviderAuthError, ProviderBusyError, ProviderFreeLimitError, ProviderPaymentRequiredError, ProviderRequestRejectedError,
  type FetchLike, type PollResult, type SubmitRequest, type SubmitResult, type VoiceCatalogueClient } from "../types.js";

export const GEMINI_TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"] as const;
// Reviewed 2026-09-27, https://ai.google.dev/gemini-api/docs/speech-generation.
// A catalogue read never synthesizes an audition or creates a custom voice.
export const GEMINI_PRESETS = [
  ["Zephyr", "bright"], ["Puck", "upbeat"], ["Charon", "informative"], ["Kore", "firm"],
  ["Fenrir", "excitable"], ["Leda", "youthful"], ["Orus", "firm"], ["Aoede", "breezy"],
  ["Callirrhoe", "easy-going"], ["Autonoe", "bright"], ["Enceladus", "breathy"], ["Iapetus", "clear"],
  ["Umbriel", "easy-going"], ["Algieba", "smooth"], ["Despina", "smooth"], ["Erinome", "clear"],
  ["Algenib", "gravelly"], ["Rasalgethi", "informative"], ["Laomedeia", "upbeat"], ["Achernar", "soft"],
  ["Alnilam", "firm"], ["Schedar", "even"], ["Gacrux", "mature"], ["Pulcherrima", "forward"],
  ["Achird", "friendly"], ["Zubenelgenubi", "casual"], ["Vindemiatrix", "gentle"],
  ["Sadachbia", "lively"], ["Sadaltager", "knowledgeable"], ["Sulafat", "warm"],
] as const;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * The live service can name a model as a resource, `models/gemini-3.8-flash-tts`, while requests
 * send the bare id. On 2026-10-01 a voice creation Google completed and billed was refused as
 * "mismatched metadata" for exactly that spelling. Only this one prefix reads as the same model;
 * anything else still has to match the pinned id.
 */
export function bareModel(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/^models\//, "") : value;
}

/** Prefer modality counts; totals are usable only because this client sends text and asks for audio alone. */
export function geminiSpeechUsage(value: unknown): SpeechUsage {
  const usage = record(value);
  const modalityCount = (rows: unknown, modality: string): number | undefined => {
    if (!Array.isArray(rows)) return undefined;
    const matching = rows.map(record).filter(row => row.modality === modality);
    if (matching.length !== 1) return undefined;
    return count(matching[0]!.tokens);
  };
  const inputTextTokens = modalityCount(usage.input_tokens_by_modality, "text") ?? count(usage.total_input_tokens);
  const outputAudioTokens = modalityCount(usage.output_tokens_by_modality, "audio") ?? count(usage.total_output_tokens);
  return { ...(inputTextTokens !== undefined ? { inputTextTokens } : {}), ...(outputAudioTokens !== undefined ? { outputAudioTokens } : {}) };
}

/**
 * Whether a 429 is the free tier's daily quota (design turn 182), which resets at midnight
 * Pacific and is not worth retrying, rather than a per-minute limit, which is. Reviewed
 * 2026-10-02 against Google's errors and rate-limit pages: the Interactions API says
 * `{"error":{"code":"quota_exceeded"}}` for the daily quota and `rate_limit_exceeded` /
 * `too_many_requests` for the per-minute ones; the older shape is RESOURCE_EXHAUSTED with a
 * QuotaFailure whose quota id ends `-FreeTier` (a per-minute free quota says `PerMinute` in it)
 * or whose metric names `free_tier`. Anything unrecognised retries, as every 429 did before.
 */
export function googleFreeDailyLimit(body: unknown): boolean {
  const error = record(record(body).error);
  if (error.code === "quota_exceeded") return true;
  const details = Array.isArray(error.details) ? error.details.map(record) : [];
  return details.some(detail => (Array.isArray(detail.violations) ? detail.violations.map(record) : []).some(violation => {
    const id = typeof violation.quotaId === "string" ? violation.quotaId : "";
    const metric = typeof violation.quotaMetric === "string" ? violation.quotaMetric : "";
    const free = id.endsWith("-FreeTier") || /free_tier/i.test(metric);
    return free && !/PerMinute/i.test(id) && !/per_minute/i.test(metric);
  }));
}

/** Unary only: a complete, validated WAV is the one artifact, never streamed PCM fragments. */
export function geminiWav(data: Uint8Array): boolean {
  const bytes = Buffer.from(data);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let format = false;
  let audio = false;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end > bytes.length) return false;
    const kind = bytes.toString("ascii", at, at + 4);
    if (kind === "fmt ") {
      if (format || size < 16 || bytes.readUInt16LE(at + 8) !== 1 || bytes.readUInt16LE(at + 10) !== 1
        || bytes.readUInt32LE(at + 12) !== 24000 || bytes.readUInt32LE(at + 16) !== 48000
        || bytes.readUInt16LE(at + 20) !== 2 || bytes.readUInt16LE(at + 22) !== 16) return false;
      format = true;
    }
    if (kind === "data") {
      if (audio || size === 0 || size % 2 !== 0) return false;
      audio = true;
    }
    at = end + size % 2;
  }
  return at === bytes.length && format && audio;
}

/**
 * SPEC-049 R-3, R-8..R-10, R-29. Exact Interactions schema, reviewed against Google's speech
 * guide and API reference. No idempotency or lookup promise: a lost synchronous response is
 * uncertain. Custom-voice creation and project-scoped bindings belong to separate operations.
 */
export class GoogleClient implements VoiceCatalogueClient, VoiceDesignClient {
  readonly id = "google" as const;
  readonly declarations: ClientDeclarations = { supportsIdempotencyKey: false, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false };

  constructor(private readonly fetchImpl: FetchLike, private readonly baseUrl = "https://generativelanguage.googleapis.com") {}

  private headers(key: string): Record<string, string> { return { "x-goog-api-key": key, "Content-Type": "application/json" }; }

  async createDesignedVoice(key: string, input: VoiceDesignInput, signal?: AbortSignal) {
    const body = googleVoiceDesignBody(input);
    const response = await this.fetchImpl(`${this.baseUrl}/v1beta/voices`, {
      method: "POST", headers: this.headers(key), body: JSON.stringify(body), signal, redirect: "error",
    });
    await this.checkStatus(response);
    // There is no documented idempotency key or unique-name lookup. A broken/lost response
    // is uncertain, not proof that no voice was created, and is never retried by this client.
    let result: unknown;
    try { result = await response.json(); }
    catch { return { problem: "Google voice creation outcome is uncertain; do not repeat the creation" }; }
    return googleVoiceDesignResult(result, { model: input.model });
  }

  async getDesignedVoice(key: string, remoteId: string, signal?: AbortSignal) {
    requireGoogleVoiceId(remoteId);
    const response = await this.fetchImpl(`${this.baseUrl}/v1beta/voices/${encodeURIComponent(remoteId)}`, {
      headers: this.headers(key), signal, redirect: "error",
    });
    if (response.status === 404) return null;
    await this.checkStatus(response);
    return googleVoiceDesignResult(await response.json(), { remoteId });
  }

  async listDesignedVoices(key: string, pageToken?: string, signal?: AbortSignal) {
    if (pageToken !== undefined && (typeof pageToken !== "string" || pageToken.length === 0 || pageToken.length > 4096)) throw new ProviderRequestRejectedError("Google: invalid voice page token");
    const query = new URLSearchParams({ type: "prompted", page_size: "50" });
    if (pageToken) query.set("page_token", pageToken);
    const response = await this.fetchImpl(`${this.baseUrl}/v1beta/voices?${query}`, {
      headers: this.headers(key), signal, redirect: "error",
    });
    await this.checkStatus(response);
    return googleDesignedVoicePage(await response.json(), pageToken);
  }

  private async models(key: string): Promise<Set<string>> {
    const available = new Set<string>();
    const seen = new Set<string>();
    let page = "";
    for (let i = 0; i < 20; i++) {
      const response = await this.fetchImpl(`${this.baseUrl}/v1beta/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: this.headers(key), redirect: "error" });
      await this.checkStatus(response);
      const body = record(await response.json());
      if (!Array.isArray(body.models)) throw new Error("Google returned no model catalogue");
      for (const item of body.models) {
        const name = record(item).name;
        if (typeof name === "string") available.add(name.replace(/^models\//, ""));
      }
      const next = body.nextPageToken;
      if (next === undefined || next === "") return available;
      if (typeof next !== "string" || seen.has(next)) throw new Error("Google repeated its model catalogue page");
      seen.add(next); page = next;
    }
    throw new Error("Google model catalogue exceeded the page limit");
  }

  async validateKey(key: string): Promise<CapabilityProbe[]> {
    try {
      const models = await this.models(key);
      const available = GEMINI_TTS_MODELS.some(model => models.has(model));
      return [{ capability: "voice-tts", available, authenticated: true,
        reason: available ? "Model listed; speech quota and synthesis are checked on the first authorised read" : "This Google project does not list Gemini 3.8 TTS" }];
    } catch (error) {
      return [{ capability: "voice-tts", available: false, reason: error instanceof Error ? error.message : "Google could not be reached" }];
    }
  }

  /** The live library owns its metadata; never infer accent or gender from a preset name. */
  private async prebuiltVoices(key: string, signal?: AbortSignal): Promise<Omit<VoiceCandidate, "model">[]> {
    const voices = new Map<string, Omit<VoiceCandidate, "model">>();
    const seen = new Set<string>();
    let page = "";
    const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
    for (let i = 0; i < 1000; i++) {
      const query = new URLSearchParams({ type: "prebuilt", page_size: "1000" });
      if (page) query.set("page_token", page);
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1beta/voices?${query}`, { headers: this.headers(key), redirect: "error", signal });
      await this.checkStatus(response);
      const body = record(await response.json());
      if (body.voices !== undefined && !Array.isArray(body.voices)) throw new Error("Google returned an invalid voice catalogue");
      for (const item of (body.voices ?? []) as unknown[]) {
        const row = record(item);
        if (row.type !== "prebuilt") throw new Error("Google returned a non-prebuilt voice in the preset catalogue");
        const id = text(row.id);
        if (!id || id.startsWith("voice_") || id.startsWith("voicekey_")) throw new Error("Google returned an invalid preset identity");
        const trait = GEMINI_PRESETS.find(([name]) => name === id)?.[1];
        const language = text(row.language_code), accent = text(row.accent), gender = text(row.gender);
        const style = text(row.persona) || trait || text(row.context);
        voices.set(id, { provider: this.id, voiceId: id, label: text(row.display_name) || id,
          description: text(row.description),
          attributes: [...new Set([language, accent, gender, style, text(row.context), text(row.pitch), trait ?? ""].filter(Boolean))],
          facets: { ...(language ? { language } : {}), ...(accent ? { accent } : {}),
            ...(gender ? { gender } : {}), ...(style ? { style } : {}) },
          local: false, canClone: false });
      }
      const next = body.next_page_token;
      if (next === undefined || next === "") return [...voices.values()];
      if (typeof next !== "string" || !next.trim() || next.length > 4096 || seen.has(next)) throw new Error("Google repeated or invalidated its voice catalogue page");
      seen.add(next); page = next;
    }
    throw new Error("Google voice catalogue exceeded the page limit");
  }

  async listVoicesCatalog(key: string): Promise<VoiceCandidate[]> {
    const models = await this.models(key);
    const enabled = GEMINI_TTS_MODELS.filter(model => models.has(model));
    if (!enabled.length) return [];
    const voices = await this.prebuiltVoices(key);
    return enabled.flatMap(model => voices.map(voice => ({ ...voice, model })));
  }

  private async checkStatus(response: Response): Promise<void> {
    if (response.ok) return;
    if (response.status === 400) {
      const error = record(record(await response.json().catch(() => null)).error);
      const details = Array.isArray(error.details) ? error.details.map(record) : [];
      if (details.some(detail => detail.reason === "API_KEY_INVALID")) throw new ProviderAuthError(this.id, "Google rejected this API key");
    }
    if (response.status === 401) throw new ProviderAuthError(this.id, "Google rejected this credential (HTTP 401)");
    if (response.status === 403) throw new ProviderRequestRejectedError("Google refused access: check this key's project, API permissions and billing (HTTP 403)");
    if (response.status === 402) throw new ProviderPaymentRequiredError("Google asked for payment for this request (HTTP 402 payment_required)");
    if (response.status === 429) {
      if (googleFreeDailyLimit(await response.json().catch(() => null))) {
        throw new ProviderFreeLimitError(`${GOOGLE_FREE_LIMIT} (HTTP 429 free daily quota)`);
      }
      throw new ProviderBusyError("Google's project quota was reached (HTTP 429)", { witnessed: true });
    }
    if (response.status >= 500) throw new Error(`Google synthesis outcome is uncertain (HTTP ${response.status})`);
    throw new ProviderRequestRejectedError(`Google refused this request (HTTP ${response.status})`);
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    if (request.capability !== "voice-tts" || !GEMINI_TTS_MODELS.some(model => model === request.model)) throw new ProviderRequestRejectedError("Google: unsupported speech model");
    if (request.voiceDesign === true) {
      const result = await this.createDesignedVoice(key, {
        model: request.model, name: request.params.name as string,
        description: request.params.text as string, language: request.params.language as string,
      }, request.signal);
      if (!result.remoteId) throw new Error(result.problem ?? "Google voice creation outcome is uncertain; do not repeat it automatically");
      return { remoteId: result.remoteId, acceptedAt: new Date().toISOString(),
        ...(result.speechUsage ? { speechUsage: result.speechUsage } : {}),
        ...(result.sample ? { artifacts: [result.sample] } : {}),
        ...(result.problem ? { error: result.problem } : {}),
      };
    }
    const text = request.params.text;
    let voice = request.params.voiceId;
    if (request.designedVoice) {
      if (request.designedVoice.target !== voice || typeof voice !== "string" || !voice.startsWith("designed:")) throw new ProviderRequestRejectedError("Google: the saved voice binding does not match this read");
      const bound = await this.getDesignedVoice(key, request.designedVoice.remoteId, request.signal);
      if (!bound?.voice || Date.parse(bound.voice.expiresAt) <= Date.now()) throw new ProviderRequestRejectedError("Google: this saved voice is expired or unavailable with the current key");
      voice = bound.voice.remoteId;
    }
    const delivery = request.params.delivery;
    const mappings = geminiSpeechModel("flash").cadence!.deliveryMappings;
    if (delivery !== undefined && (typeof delivery !== "string" || !Object.hasOwn(mappings, delivery))) throw new ProviderRequestRejectedError("Google: unsupported speech delivery");
    const instructions = request.params.instructions ?? (typeof delivery === "string" ? mappings[delivery]?.instruction : undefined);
    if (typeof text !== "string" || text.trim() === "") throw new ProviderRequestRejectedError("Google: no words to read");
    if (typeof voice !== "string" || (!request.designedVoice && (voice.startsWith("voice_") || voice.startsWith("voicekey_") || voice.startsWith("designed:") || voice.startsWith("clone:") || !voice.trim()))) throw new ProviderRequestRejectedError("Google: choose a supported preset voice; saved project voices need a verified binding");
    if (request.voiceReference !== undefined) throw new ProviderRequestRejectedError("Google: a reference recording requires a separately authorised replication operation");
    if (instructions !== undefined && typeof instructions !== "string") throw new ProviderRequestRejectedError("Google: invalid speech direction");
    if (request.params.voiceSettings !== undefined && Object.keys(record(request.params.voiceSettings)).length > 0) throw new ProviderRequestRejectedError("Google: numeric voice settings are unsupported; use structured speech direction");
    // This is a byte budget, not a claim about Google's tokenizer. It deliberately leaves room
    // for metadata; a counted-token compiler can later pack requests closer to the service cap.
    if (!speechInputFits(text, { maxSpeechUtf8Bytes: GEMINI_SPEECH_INPUT_BYTES }, instructions as string | undefined)) throw new ProviderRequestRejectedError("Google: this read needs smaller parts including its direction");
    if (!request.designedVoice && !GEMINI_PRESETS.some(([id]) => id === voice)) {
      const library = await this.prebuiltVoices(key, request.signal);
      if (!library.some(candidate => candidate.voiceId === voice)) throw new ProviderRequestRejectedError("Google: this preset is no longer in the voice catalogue");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1beta/interactions`, {
      method: "POST", headers: this.headers(key), signal: request.signal, redirect: "error",
      body: JSON.stringify({ model: request.model, store: false,
        input: [{ type: "user_input", content: [{ type: "text", text,
          ...(instructions ? { annotations: [{ type: "speech_metadata", style: instructions }] } : {}) }] }],
        response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
        generation_config: { max_output_tokens: 16384, speech_config: [{ voice }] },
      }),
    });
    await this.checkStatus(response);
    const body = record(await response.json());
    // Live store:false responses omit the server id. This local receipt identifies the inline
    // result in the journal; it is never offered as a remotely pollable or recoverable resource.
    const remoteId = typeof body.id === "string" && body.id.length > 0 ? body.id
      : body.id === undefined && body.object === "interaction" ? `google-inline:${randomUUID()}` : null;
    if (remoteId === null) throw new Error("Google returned no interaction identity; the outcome is uncertain");
    const result = { remoteId, acceptedAt: new Date().toISOString(), speechUsage: geminiSpeechUsage(body.usage) };
    if (bareModel(body.model) !== request.model) return { ...result, error: "Google returned a different or unidentified model; this read was not kept" };
    if (body.status !== "completed") return { ...result, error: "Google did not complete this read; partial audio was not kept" };
    const audio = (Array.isArray(body.steps) ? body.steps : []).flatMap(step => {
      const row = record(step);
      return row.type === "model_output" && Array.isArray(row.content) ? row.content.map(record).filter(content => content.type === "audio") : [];
    });
    if (audio.length !== 1 || audio[0]!.mime_type !== "audio/wav" || typeof audio[0]!.data !== "string"
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio[0]!.data)) return { ...result, error: "Google returned no single complete WAV read" };
    const data = Buffer.from(audio[0]!.data, "base64");
    if (!geminiWav(data)) return { ...result, error: "Google returned incomplete or incompatible WAV audio" };
    return { ...result, artifacts: [{ name: "speech.wav", contentType: "audio/wav", data }] };
  }

  async poll(): Promise<PollResult> { return { state: "failed", error: "Google unary speech is returned by submit; no recoverable remote audio was recorded" }; }
  async fetchArtifacts(): Promise<never> { throw new Error("Google unary audio must be made durable from the submission response"); }
  async cancel(): Promise<void> { /* Aborting the host request stops waiting; it does not promise a refund. */ }
}
