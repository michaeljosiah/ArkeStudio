import { breezeDirection, DeliverySchema, HOSTED_VOICE_READERS, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
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
export const BREEZE_MODEL = HOSTED_VOICE_READERS["breezeblue"]!;
/** The vendor's cap on one request's text, tag included (probed 2026-09-13: 1,001 → 422). */
export const BREEZE_TEXT_CAP = 1000;
/** How much of the ~6,900-voice public catalogue the picker gets: three pages of Breeze's trend rank. */
export const BREEZE_CATALOGUE_PAGES = 3;

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
  "GENERATION_TIMEOUT", "UPSTREAM_TIMEOUT", "INTERNAL_ERROR", "GENERATION_NOT_READY", "VOICE_CLONE_FAILED",
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
      // `/v1/balance`, as the OpenAPI block says — not the docs navigation's `account/balance`, which 404s.
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/balance`, { headers: this.headers(key) }),
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
      // Both halves of R-3, kept apart (issue 1167): the key was accepted, the account cannot
      // pay. Said as `authenticated` so Settings offers a top-up rather than a replacement key.
      const reason = `the key authenticates but the balance is ${balance.toLocaleString("en-US")} credits — top up on breezeblue.ai`;
      return [
        { capability: "voice-tts", available: false, authenticated: true, reason },
        { capability: "voice-clone", available: false, authenticated: true, reason },
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
    // A cloned voice reads from the slot the host ensured (R-13); a preset reads from its own id.
    // A clip with no slot behind it is not something Breeze can speak from in one call.
    const voiceId = request.voiceReference !== undefined
      ? (request.voiceReference.remoteVoiceId ?? "")
      : typeof request.params["voiceId"] === "string" ? request.params["voiceId"] : "";
    if (voiceId === "" || !/^[A-Za-z0-9_-]+$/.test(voiceId)) {
      throw new ProviderRequestRejectedError(
        request.voiceReference !== undefined
          ? "breezeblue: a cloned voice must be saved into a Breeze voice slot before it can read — the library does that on first use"
          : "breezeblue: a read needs a voice id",
      );
    }
    const delivery = DeliverySchema.safeParse(request.params["delivery"]);
    const direction = delivery.success ? breezeDirection(delivery.data) : {};
    // A performance job arrives already decorated — `mapCadence` put the tag in the text and
    // lifted the sentence out as `instructions` (issue 1149) — so it names no delivery here, and
    // the sentence rides as it was mapped rather than being re-derived.
    const instruction = typeof request.params["instructions"] === "string" && request.params["instructions"].trim() !== "" ? request.params["instructions"] : direction.instruction;
    const settings = isNumberRecord(request.params["voiceSettings"]) ? request.params["voiceSettings"] : {};
    const language = typeof request.params["language"] === "string" && /^[A-Za-z]{2}$/.test(request.params["language"]) ? request.params["language"].toLowerCase() : undefined;
    // Tags are per language on Breeze — parentheses in English, the language's own word in
    // brackets elsewhere. The tag goes in only when the line is stated to be English; unknown is
    // not English, and a French line read with `(whispers)` spoken aloud is paid output wasted
    // (R-23, codex on PR 1153). The sentence carries the delivery whatever the language.
    const tagged = direction.tag !== undefined && language === "en" ? `(${direction.tag}) ${text}` : text;
    // The tag counts against the vendor's cap, and the caller measured the text without it: a
    // 995-character whisper is refused here, named, rather than as a 422 after the wire.
    if (tagged.length > BREEZE_TEXT_CAP) {
      throw new ProviderRequestRejectedError(
        `breezeblue: the line is ${tagged.length - BREEZE_TEXT_CAP} characters over Breeze's ${BREEZE_TEXT_CAP}${tagged !== text ? ` once the (${direction.tag}) tag is counted` : ""} — shorten it`,
      );
    }
    const remoteId = `breezeblue-${++this.counter}-${Date.now()}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        text: tagged,
        ...(language !== undefined ? { language_code: language } : {}),
        ...(instruction !== undefined ? { instructions: instruction } : {}),
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
    // A 403 is a bad key only when Breeze's own code says so (`AUTH_*`); its bare `FORBIDDEN` is
    // a refusal of this request, and reporting that as a rejected credential sends the person to
    // Settings to fix a key that is fine — the failure R-24 names for Mistral's 403.
    if (res.status === 401 || (res.status === 403 && code.startsWith("AUTH_"))) return new ProviderAuthError("breezeblue", `breezeblue: the credential was rejected — ${message}`);
    if (res.status === 402) return new ProviderRequestRejectedError(`breezeblue: the account cannot pay for this read — ${message}; top up on breezeblue.ai`);
    if (TRANSIENT_CODES.has(code)) {
      const wait = res.headers.get("retry-after");
      // A 4xx witnessed the refusal — the pool was full, nothing ran. A 5xx with a retryable
      // code is the vendor's word that it is safe to try again, which is not the same as proof
      // that nothing was charged; that one is held for the person, as every 5xx is.
      return new ProviderBusyError(`breezeblue: ${said || code || "busy"}${wait ? ` — retry after ${wait}s` : ""} (HTTP ${res.status})`, { witnessed: res.status < 500 });
    }
    if (res.status >= 500) return new Error(`breezeblue: synthesis failed — ${message}`);
    return new ProviderRequestRejectedError(`breezeblue: synthesis failed — ${message}`);
  }

  /**
   * Save a clip as a voice on the account — Breeze's two-step clone, preview then save (SPEC-046
   * §2.4). The service transcribes the first sixty seconds and keeps at most thirty, so nothing on
   * this side writes a transcript. Saving consumes a voice slot (5 · 20 · 50 · 300 by plan); the
   * preview is what bills — a read of the default script the service writes for the recording,
   * at the per-character rate (probed 2026-09-15: 89 characters, 168 units, 16.8 credits on this
   * clip) — and the save bills nothing.
   *
   * Live, the preview takes `name` and `files` and nothing else: the docs' `text`,
   * `instructions` and `language_code` are each `400 "Clone previews generate their script and
   * language automatically; unsupported fields: …"`, so the charge cannot be shortened with a
   * script of our own. The save takes a language but holds the vendor's own analysis of the
   * recording above it — `422 "Saved voice must use the analyzed reference language"`.
   * That analysis is the transcript's language, which the vendor has and this side does not, so
   * the save defers to it and answers with what the vendor heard; the library records the
   * difference (R-13), and reads still state the library's language as the speech language.
   */
  async saveVoice(key: string, input: { name: string; clip: Uint8Array; contentType: "audio/wav" | "audio/mpeg"; language?: string }, signal?: AbortSignal): Promise<{ voiceId: string; language?: string }> {
    const form = new FormData();
    form.append("name", input.name.slice(0, 80));
    form.append("files", new Blob([new Uint8Array(input.clip)], { type: input.contentType }), input.contentType === "audio/wav" ? "voice.wav" : "voice.mp3");
    const preview = await this.fetchImpl(`${this.baseUrl}/v1/voice-previews/clone`, { method: "POST", headers: { "xi-api-key": key }, body: form, ...(signal ? { signal } : {}) });
    if (preview.status >= 400) throw await this.failure(preview);
    const generated = ((await preview.json().catch(() => null)) as { generated_voice_id?: unknown } | null)?.generated_voice_id;
    if (typeof generated !== "string" || generated === "") throw new Error("breezeblue: the clone preview carried no generated_voice_id");
    const save = (language: string | undefined) =>
      this.fetchImpl(`${this.baseUrl}/v1/voice-previews/${encodeURIComponent(generated)}/save`, {
        method: "POST", headers: this.headers(key), body: JSON.stringify({ voice_name: input.name.slice(0, 80), ...(language !== undefined ? { language_code: language } : {}) }), ...(signal ? { signal } : {}),
      });
    let saved = await save(input.language);
    let deferred = false;
    if (saved.status === 422 && input.language !== undefined) {
      const detail = ((await saved.clone().json().catch(() => null)) as BreezeError | null)?.detail;
      if (typeof detail === "string" && /analy[sz]ed reference language/i.test(detail)) {
        signal?.throwIfAborted();
        saved = await save(undefined);
        deferred = true;
      }
    }
    if (saved.status >= 400) throw await this.failure(saved);
    const body = (await saved.json().catch(() => null)) as { voice_id?: unknown; language_code?: unknown } | null;
    const voiceId = body?.voice_id;
    if (typeof voiceId !== "string" || voiceId === "") throw new Error("breezeblue: saving the voice returned no voice_id");
    return { voiceId, ...(deferred && typeof body?.language_code === "string" ? { language: body.language_code } : {}) };
  }

  /** Remove a saved voice (R-15). A voice already gone is not an error: the outcome is the same. */
  async deleteVoice(key: string, voiceId: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(voiceId)) throw new ProviderRequestRejectedError("breezeblue: not a voice id");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: { "xi-api-key": key }, ...(signal ? { signal } : {}) });
    if (res.status === 404) return;
    if (res.status >= 400) throw await this.failure(res);
  }

  /**
   * The account's own voice saved under exactly this name (R-13): the library names a slot with
   * the clip's hash, so a save whose answer never landed is found here rather than made again.
   * `search` matches names by prefix and substring too, so the match is checked exactly. A
   * listing that fails is thrown, never read as "none": an unanswered listing after an
   * uncertain save is exactly when a second save would charge twice (codex on PR 1153).
   */
  async findVoice(key: string, name: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/voices?voice_type=personal&search=${encodeURIComponent(name)}&page_size=100`, { headers: this.headers(key), ...(signal ? { signal } : {}) });
    if (res.status >= 400) throw await this.failure(res);
    const body = (await res.json().catch(() => null)) as { voices?: unknown } | null;
    // A 2xx that is not a list has not answered either: `null` means the account listed and
    // holds none, and a save follows only that.
    if (!Array.isArray(body?.voices)) throw new Error("breezeblue: the voice listing was not a list");
    const match = (body.voices as Array<Record<string, unknown>>).find((v) => v["name"] === name && typeof v["voice_id"] === "string");
    return match ? (match["voice_id"] as string) : null;
  }

  /** Whether the account still holds the voice: a slot deleted in Breeze's console, or one saved under another account's key, reads false. */
  async hasVoice(key: string, voiceId: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(voiceId)) return false;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { "xi-api-key": key }, ...(signal ? { signal } : {}) });
    if (res.status === 404 || res.status === 403) return false;
    if (res.status >= 400) throw await this.failure(res);
    return true;
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
   * gender, age band, tones and category become attributes `rankVoices` can match. The live
   * catalogue holds ~6,900 public voices (read 2026-09-13) at 100 a page, and the default
   * listing is newest-first — so this asks for the vendor's own trend rank and follows the pages
   * for a bounded run: the picker gets the most popular few hundred, a ranked slice stated as
   * such, not the whole shelf and not the newest hundred (codex on PR 1153). A page that fails
   * ends the run with what was read. Saved voices — the account's own clones — are
   * `visibility: private` and left out; the library addresses those by its own ids.
   */
  async listVoicesCatalog(key: string): Promise<
    Array<{ provider: string; model: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
  > {
    const voices: Array<Record<string, unknown>> = [];
    // The trend sort pages by token, not by number (issue 1168): `page=2` is a 400 — "sort=trend
    // uses next_page_token pagination; page must be 1" — and a rejected call in the ledger on
    // every listing. Each page's body names the next; the filters stay the same; no token is
    // the end whatever `has_more` says.
    let token: string | null = null;
    for (let page = 1; page <= BREEZE_CATALOGUE_PAGES; page += 1) {
      const { status, body } = await jsonRequest(
        this.fetchImpl, this.id,
        `${this.baseUrl}/v1/voices?voice_type=default&sort=trend&sort_direction=desc&page_size=100${token !== null ? `&next_page_token=${encodeURIComponent(token)}` : ""}`,
        { headers: this.headers(key) },
      ).catch(() => ({ status: 599, body: null }));
      if (status >= 400) break;
      const listed = (body as { voices?: Array<Record<string, unknown>>; has_more?: unknown; next_page_token?: unknown } | null);
      voices.push(...(listed?.voices ?? []));
      token = typeof listed?.next_page_token === "string" && listed.next_page_token !== "" ? listed.next_page_token : null;
      if (listed?.has_more !== true || token === null) break;
    }
    return voices
      .filter((v) => typeof v["voice_id"] === "string" && typeof v["name"] === "string" && (v["visibility"] === undefined || v["visibility"] === "public"))
      .map((v) => ({
        provider: "breezeblue",
        model: BREEZE_MODEL,
        voiceId: v["voice_id"] as string,
        label: v["name"] as string,
        attributes: [v["language_code"], v["accent"], v["gender"], v["age"], v["primary_category_code"],
          ...(Array.isArray(v["tone"]) ? v["tone"] : []), ...(Array.isArray(v["tags"]) ? v["tags"] : [])]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .map((s) => s.toLowerCase()),
        local: false,
        canClone: false,
      }));
  }
}

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((n) => typeof n === "number");
