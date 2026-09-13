import { breezeDirection, DeliverySchema, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import {
  ProviderAuthError,
  ProviderBusyError,
  ProviderRequestRejectedError,
  type FetchedArtifact,
  type FetchLike,
  type PollResult,
  type ProviderClient,
  type SubmitRequest,
  type SubmitResult,
  type VoiceCatalogueClient,
} from "../types.js";

/** The manifest row's id. There is no `providerModelId`: Breeze routes by language (SPEC-046 §2.4). */
export const BREEZE_MODEL = "breeze-tts-2";

/**
 * Breeze's error envelope: `{ ok: false, code, detail, error }`. The code is what decides the
 * class of a failure; the status alone would put a full generation pool (429) and an empty
 * account (402) in the same bucket as a bad request.
 */
type BreezeError = { ok?: boolean; code?: string; detail?: string; error?: string };

/** Codes Breeze itself marks retryable in its reference: the request is fine and the service is not, for now. */
const TRANSIENT_CODES = new Set([
  "GENERATION_CONCURRENCY_EXCEEDED", "RATE_LIMITED", "GENERATION_CAPACITY_EXCEEDED", "DISPATCH_TIMEOUT",
  "GENERATION_INTERRUPTED", "GENERATION_FAILED", "GENERATION_INVALID_RESPONSE", "UPSTREAM_GENERATION_ERROR",
  "GENERATION_TIMEOUT", "UPSTREAM_TIMEOUT", "INTERNAL_ERROR", "GENERATION_NOT_READY",
]);

/**
 * BreezeBlue — Breeze TTS 2 as a hosted reader of the world's voices (SPEC-046 §2.4).
 *
 * The one voice client in the catalogue that takes direction as words: a tag in the text
 * (`(whispers)`), a sentence beside it (`instructions`), and a guidance scale. The numbers arrive
 * as `voiceSettings` like every provider's; the words are read back from the delivery's name
 * through the contract's table, so the mapping lives in one place and this client only places it.
 *
 * A cloned voice is a slot on the account, saved once by the library (R-13); this client reads
 * whatever `voiceId` it is given and refuses a bare clip, because a clip with no slot behind it
 * is not something Breeze can speak from in one call.
 *
 * The probe is the balance read: it answers both halves of SPEC-008 R-3 — the key authenticates,
 * and the account can pay — in credits, the vendor's denomination, never converted (R-2).
 */
export class BreezeBlueClient implements ProviderClient, VoiceCatalogueClient {
  readonly id = "breezeblue" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://api.breeze.blue",
  ) {}

  // The header name is ElevenLabs' — Breeze copied it. Never the query string the docs also
  // accept: a key in a URL lands in every log between here and the vendor.
  private headers(key: string): Record<string, string> {
    return { "xi-api-key": key, "Content-Type": "application/json" };
  }

  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/account/balance`, { headers: this.headers(key) }),
    );
    if (!probe.ok) {
      const reason = probe.auth ? "BreezeBlue rejected this key" : `BreezeBlue could not be reached: ${probe.message}`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
      ];
    }
    const balance = (probe.value.body as { balance?: unknown } | null)?.balance;
    if (probe.value.status >= 400 || typeof balance !== "number") {
      const reason = `BreezeBlue answered HTTP ${probe.value.status} to the balance read`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
      ];
    }
    if (balance <= 0) {
      const reason = `the key authenticates but the balance is ${balance.toLocaleString("en-US")} credits — top up on breezeblue.ai`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
      ];
    }
    return [
      { capability: "voice-tts", available: true },
      { capability: "voice-clone", available: true },
    ];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    if (request.capability !== "voice-tts") throw new ProviderRequestRejectedError("breezeblue: unsupported synthesis capability");
    const text = String(request.params["text"] ?? "");
    if (text.trim() === "") throw new ProviderRequestRejectedError("breezeblue: there is no text to read");
    const voiceId = typeof request.params["voiceId"] === "string" ? request.params["voiceId"] : "";
    if (voiceId === "" || !/^[A-Za-z0-9_-]+$/.test(voiceId)) {
      throw new ProviderRequestRejectedError(
        request.voiceReference !== undefined
          ? "breezeblue: a cloned voice must be saved into a Breeze voice slot before it can read — the library does that on first use"
          : "breezeblue: a read needs a voice id",
      );
    }
    const delivery = DeliverySchema.safeParse(request.params["delivery"]);
    const direction = delivery.success ? breezeDirection(delivery.data) : {};
    const settings = isNumberRecord(request.params["voiceSettings"]) ? request.params["voiceSettings"] : {};
    const language = typeof request.params["language"] === "string" && /^[A-Za-z]{2}$/.test(request.params["language"]) ? request.params["language"].toLowerCase() : undefined;
    // Tags are per language on Breeze — parentheses in English, the language's own word in
    // brackets elsewhere. Without a known English line the tag stays out and the sentence
    // carries the delivery alone (R-23); nothing here translates a tag.
    const tagged = direction.tag !== undefined && (language === undefined || language === "en") ? `(${direction.tag}) ${text}` : text;
    const remoteId = `breezeblue-${++this.counter}-${Date.now()}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        text: tagged,
        ...(language !== undefined ? { language_code: language } : {}),
        ...(direction.instruction !== undefined ? { instructions: direction.instruction } : {}),
        ...(Object.keys(settings).length > 0 ? { voice_settings: settings } : {}),
      }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (res.status >= 400) throw await this.failure(res);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length === 0) throw new Error("breezeblue: synthesis returned empty audio");
    return {
      remoteId: res.headers.get("history-item-id") ?? remoteId,
      acceptedAt: new Date().toISOString(),
      artifacts: [{ name: "speech.wav", contentType: "audio/wav", data }],
    };
  }

  /** Read the envelope and hand back the class the code calls for (SPEC-046 R-26, R-27). */
  private async failure(res: Response): Promise<Error> {
    const body = (await res.json().catch(() => null)) as BreezeError | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const said = typeof body?.detail === "string" && body.detail.trim() !== "" ? body.detail.trim() : typeof body?.error === "string" ? body.error.trim() : "";
    const message = said === "" ? `HTTP ${res.status}` : `${said} (HTTP ${res.status})`;
    if (res.status === 401 || res.status === 403) return new ProviderAuthError("breezeblue", `breezeblue: the credential was rejected — ${message}`);
    if (res.status === 402) return new ProviderRequestRejectedError(`breezeblue: the account cannot pay for this read — ${message}; top up on breezeblue.ai`);
    if (TRANSIENT_CODES.has(code)) {
      const wait = res.headers.get("retry-after");
      return new ProviderBusyError(`breezeblue: ${said || code || "busy"}${wait ? ` — retry after ${wait}s` : ""} (HTTP ${res.status})`);
    }
    if (res.status >= 500) return new Error(`breezeblue: synthesis failed — ${message}`);
    return new ProviderRequestRejectedError(`breezeblue: synthesis failed — ${message}`);
  }

  async poll(_key: string, _remoteId: string): Promise<PollResult> {
    return { state: "failed", error: "breezeblue: synchronous results must be returned by submit" };
  }

  async fetchArtifacts(_key: string, _remoteId: string): Promise<FetchedArtifact[]> {
    throw new Error("breezeblue: synchronous artifacts are returned by submit");
  }

  async cancel(): Promise<void> {
    /* synchronous API */
  }

  /**
   * The public catalogue as picker candidates (SPEC-046 R-32): the voice's language, accent,
   * gender, age band and tags become attributes `rankVoices` can match. Saved voices — the
   * account's own clones — are left out here; the library addresses those by its own ids.
   */
  async listVoicesCatalog(key: string): Promise<
    Array<{ provider: string; model: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
  > {
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/voices?page_size=100`, {
      headers: this.headers(key),
    });
    if (status >= 400) return [];
    const voices = (body as { voices?: Array<Record<string, unknown>> } | null)?.voices ?? [];
    return voices
      .filter((v) => typeof v["voice_id"] === "string" && typeof v["name"] === "string" && (v["origin"] === undefined || v["origin"] === "public"))
      .map((v) => ({
        provider: "breezeblue",
        model: BREEZE_MODEL,
        voiceId: v["voice_id"] as string,
        label: v["name"] as string,
        attributes: [v["language_code"], v["accent"], v["gender"], v["age"], ...(Array.isArray(v["tags"]) ? v["tags"] : [])]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .map((s) => s.toLowerCase()),
        local: false,
        canClone: false,
      }));
  }
}

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((n) => typeof n === "number");
