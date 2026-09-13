import { DeliverySchema, fishDirection, HOSTED_VOICE_READERS, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
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
  type VoiceSlotClient,
} from "../types.js";

/** The manifest row's stable id, and the model Fish serves behind it (the `model` header). */
export const FISH_MODEL = HOSTED_VOICE_READERS["fishaudio"]!;
export const FISH_PROVIDER_MODEL = "s2.1-pro";
/** Our cap on one read's text (SPEC-046 R-9): Fish publishes none. The row declares it; the client enforces it. */
export const FISH_TEXT_CAP = 2000;
/** How much of the public library the picker gets: three pages of the most-used licensed voices. */
export const FISH_CATALOGUE_PAGES = 3;

const WAV_HEADER = [0x52, 0x49, 0x46, 0x46]; // "RIFF"

/** Fish's error body: `{ status, message }` on every refusal (its docs' Errors page). */
type FishError = { status?: number; message?: string };

/**
 * Fish Audio — S2.1-Pro as a hosted reader of the world's voices (SPEC-046 §2.9).
 *
 * A model on the account is state, as a Breeze slot is: a cloned voice is saved once as a
 * private voice model (`POST /model`, `train_mode: fast`, usable at once) and read thereafter by
 * `reference_id`. The stateless alternative — `references[{audio, text}]` inline on every call —
 * needs the clip's exact transcript, which the library does not hold, and MessagePack rather
 * than JSON; the model path transcribes for itself. So this client is the slot shape, not the
 * Voxtral shape.
 *
 * Direction is a `[bracket]` phrase in the text, read by the model as language rather than as a
 * control token, so the phrases live in the contract's `FISH_DELIVERY` table and are placed here.
 * `speed` travels as `prosody.speed`. The response is audio bytes, chunked; `format: "wav"` is
 * asked for and the header is checked, because a body that is not a WAV is the one failure the
 * artifact verifier would otherwise file as an unverifiable blob.
 *
 * The probe is the wallet's API credit: it answers both halves of SPEC-008 R-3 — the key
 * authenticates, and the account can pay — and `check_free_credit` counts the free grant a new
 * account starts with. Pricing is per million UTF-8 bytes; the row's per-character figure is
 * exact for Latin text and under by up to three times for CJK (R-8).
 */
export class FishAudioClient implements ProviderClient, VoiceCatalogueClient, VoiceSlotClient {
  readonly id = "fishaudio" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://api.fish.audio",
  ) {}

  private headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${key}`, ...extra };
  }

  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/wallet/self/api-credit?check_free_credit=true`, { headers: this.headers(key) }),
    );
    const both = (available: boolean, reason?: string): CapabilityProbe[] => [
      { capability: "voice-tts", available, ...(reason !== undefined ? { reason } : {}) },
      { capability: "voice-clone", available, ...(reason !== undefined ? { reason } : {}) },
    ];
    if (!probe.ok) return both(false, probe.auth ? "Fish Audio rejected this key" : `Fish Audio could not be reached: ${probe.message}`);
    if (probe.value.status >= 400) return both(false, `Fish Audio answered HTTP ${probe.value.status} to the credit read`);
    const credit = (probe.value.body as { credit?: unknown } | null)?.credit;
    const dollars = typeof credit === "number" ? credit : typeof credit === "string" ? Number(credit) : Number.NaN;
    if (Number.isNaN(dollars)) return both(false, "Fish Audio's credit read carried no balance");
    // Reported in dollars as the wallet states it, never converted: the number the person sees
    // on fish.audio is the number here.
    if (dollars <= 0) return both(false, `the key authenticates but the balance is $${dollars.toFixed(2)} — top up on fish.audio`);
    return both(true);
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    if (request.capability !== "voice-tts") throw new ProviderRequestRejectedError("fishaudio: unsupported synthesis capability");
    const text = String(request.params["text"] ?? "");
    if (text.trim() === "") throw new ProviderRequestRejectedError("fishaudio: there is no text to read");
    // A cloned voice reads from the model the host ensured (R-13); a library preset by its own id.
    const voiceId = request.voiceReference !== undefined
      ? (request.voiceReference.remoteVoiceId ?? "")
      : typeof request.params["voiceId"] === "string" ? request.params["voiceId"] : "";
    if (voiceId === "" || !/^[A-Za-z0-9_-]+$/.test(voiceId)) {
      throw new ProviderRequestRejectedError(
        request.voiceReference !== undefined
          ? "fishaudio: a cloned voice must be saved as a Fish Audio voice model before it can read — the library does that on first use"
          : "fishaudio: a read needs a voice id",
      );
    }
    const delivery = DeliverySchema.safeParse(request.params["delivery"]);
    // The phrase goes in front of the line, where Fish's own guidance puts a sentence-level cue.
    const directed = delivery.success ? `[${fishDirection(delivery.data).tag}] ${text}` : text;
    // The phrase counts against the cap: what leaves is what is measured, as the estimate does.
    if (directed.length > FISH_TEXT_CAP) {
      throw new ProviderRequestRejectedError(
        `fishaudio: the line is ${directed.length - FISH_TEXT_CAP} characters over the ${FISH_TEXT_CAP} this reader takes${directed !== text ? " once the delivery phrase is counted" : ""} — read it in parts`,
      );
    }
    const settings = isNumberRecord(request.params["voiceSettings"]) ? request.params["voiceSettings"] : {};
    const speed = typeof settings["speed"] === "number" ? Math.min(2, Math.max(0.5, settings["speed"])) : undefined;
    const remoteId = `fishaudio-${++this.counter}-${Date.now()}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/tts`, {
      method: "POST",
      headers: this.headers(key, { "Content-Type": "application/json", model: request.model === FISH_MODEL ? FISH_PROVIDER_MODEL : request.model }),
      body: JSON.stringify({
        text: directed,
        reference_id: voiceId,
        format: "wav",
        latency: "normal",
        ...(speed !== undefined ? { prosody: { speed } } : {}),
      }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (res.status >= 400) throw await this.failure(res, text);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length < 44 || !WAV_HEADER.every((byte, i) => data[i] === byte)) throw new Error("fishaudio: the response is not a WAV file");
    return {
      remoteId,
      acceptedAt: new Date().toISOString(),
      artifacts: [{ name: "speech.wav", contentType: "audio/wav", data }],
    };
  }

  /**
   * Read `{status, message}` and hand back the class the status calls for. Fish's 403 is "not
   * permitted for this key/resource" — a key scoped away from the call, or a voice model owned
   * by someone else — so it is a rejection naming both, not a paused lane (the R-24 lesson).
   */
  private async failure(res: Response, text = ""): Promise<Error> {
    const body = (await res.json().catch(() => null)) as FishError | null;
    const said = typeof body?.message === "string" && body.message.trim() !== "" ? body.message.trim() : "";
    const message = said === "" ? `HTTP ${res.status}` : `${said} (HTTP ${res.status})`;
    if (res.status === 401) return new ProviderAuthError("fishaudio", `fishaudio: the credential was rejected — ${message}`);
    if (res.status === 402) return new ProviderRequestRejectedError(`fishaudio: the account cannot pay for this read — ${message}; top up on fish.audio`);
    if (res.status === 403) return new ProviderRequestRejectedError(`fishaudio: not permitted — the key's scope, or a voice model this account does not own — ${message}`);
    if (res.status === 404 || (res.status === 400 && /reference|voice|model/i.test(said))) {
      return new ProviderRequestRejectedError(`fishaudio: the voice model is gone from the account — re-clone the voice, or choose another — ${message}`);
    }
    // A witnessed 429 proves nothing was synthesised: transient AND a rejected submission.
    if (res.status === 429) return new ProviderBusyError(`fishaudio: the account's concurrency was reached${text ? ` — “${firstWords(text)}”` : ""} (HTTP 429)`, { witnessed: true });
    if (res.status >= 500) return new Error(`fishaudio: synthesis failed — ${message}`);
    return new ProviderRequestRejectedError(`fishaudio: synthesis failed — ${message}`);
  }

  /**
   * Save a clip as a private voice model (SPEC-046 §2.9): one multipart call, `train_mode: fast`,
   * transcribed by the service (no `texts`), enhanced by default. The answer carries the model's
   * id and a `state` that is `trained` at once for a fast model; `failed` is a refusal here, not
   * a model to read from.
   */
  async saveVoice(key: string, input: { name: string; clip: Uint8Array; contentType: "audio/wav" | "audio/mpeg"; language?: string }, signal?: AbortSignal): Promise<{ voiceId: string }> {
    const form = new FormData();
    form.append("type", "tts");
    form.append("title", input.name.slice(0, 80));
    form.append("train_mode", "fast");
    form.append("visibility", "private");
    form.append("voices", new Blob([new Uint8Array(input.clip)], { type: input.contentType }), input.contentType === "audio/wav" ? "voice.wav" : "voice.mp3");
    const res = await this.fetchImpl(`${this.baseUrl}/model`, { method: "POST", headers: this.headers(key), body: form, ...(signal ? { signal } : {}) });
    if (res.status >= 400) throw await this.failure(res);
    const body = (await res.json().catch(() => null)) as { _id?: unknown; state?: unknown } | null;
    const voiceId = body?._id;
    if (typeof voiceId !== "string" || voiceId === "") throw new Error("fishaudio: creating the voice model returned no id");
    if (body?.state === "failed") {
      // A failed model still holds the recording and a place on the account: removed before
      // the refusal, best-effort, so it is not adopted by a later lookup nor left counting.
      await this.deleteVoice(key, voiceId, signal).catch(() => undefined);
      throw new ProviderRequestRejectedError("fishaudio: the service could not make a voice model from this recording");
    }
    return { voiceId };
  }

  /** Remove a saved voice model (R-15). One already gone is not an error: the outcome is the same. */
  async deleteVoice(key: string, voiceId: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(voiceId)) throw new ProviderRequestRejectedError("fishaudio: not a voice model id");
    const res = await this.fetchImpl(`${this.baseUrl}/model/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: this.headers(key), ...(signal ? { signal } : {}) });
    if (res.status === 404) return;
    if (res.status >= 400) throw await this.failure(res);
  }

  /**
   * The account's own model saved under exactly this title (R-13): the library titles a model
   * with the clip's hash, so a save whose answer never landed is found here rather than made
   * again. `title` filters by text match, so the title is checked exactly. A listing that
   * fails is thrown, never read as "none": that is the one moment a second save would charge twice.
   */
  async findVoice(key: string, name: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/model?self=true&title=${encodeURIComponent(name)}&page_size=100`, { headers: this.headers(key), ...(signal ? { signal } : {}) });
    if (res.status >= 400) throw await this.failure(res);
    const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
    // A 2xx that is not a list has not answered either: `null` means the account listed and
    // holds none, and a save follows only that. A model whose training failed is not a slot
    // to adopt: it reads as none here and the failed-save cleanup removes it (codex on PR 1156).
    if (!Array.isArray(body?.items)) throw new Error("fishaudio: the model listing was not a list");
    const match = (body.items as Array<Record<string, unknown>>).find((v) => v["title"] === name && typeof v["_id"] === "string" && usable(v["state"]));
    return match ? (match["_id"] as string) : null;
  }

  /** Whether the account still holds the model: one deleted on fish.audio, or owned by another account, reads false. */
  async hasVoice(key: string, voiceId: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(voiceId)) return false;
    const res = await this.fetchImpl(`${this.baseUrl}/model/${encodeURIComponent(voiceId)}`, { headers: this.headers(key), ...(signal ? { signal } : {}) });
    if (res.status === 404 || res.status === 403) return false;
    if (res.status >= 400) throw await this.failure(res);
    // Held, and usable: a model whose training failed is not one to read from.
    const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
    return usable(body?.state);
  }

  async poll(_key: string, _remoteId: string): Promise<PollResult> {
    return { state: "failed", error: "fishaudio: synchronous results must be returned by submit" };
  }

  async fetchArtifacts(_key: string, _remoteId: string): Promise<FetchedArtifact[]> {
    throw new Error("fishaudio: synchronous artifacts are returned by submit");
  }

  async cancel(): Promise<void> {
    /* synchronous API */
  }

  /**
   * The public library as picker candidates (SPEC-046 R-32): `licensed` voices only — the ones
   * Fish says it holds rights to from the voice's owner — because a library of user uploads is
   * exactly the consent question SPEC-022 refuses to answer on someone else's behalf. Most-used
   * first, three pages, `languages` and `tags` as attributes; a page that fails ends the run with
   * what was read. The account's own models are not listed here: the library addresses those by
   * its own ids.
   */
  async listVoicesCatalog(key: string): Promise<
    Array<{ provider: string; model: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
  > {
    const items: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= FISH_CATALOGUE_PAGES; page += 1) {
      const { status, body } = await jsonRequest(
        this.fetchImpl, this.id,
        `${this.baseUrl}/model?licensed=true&sort_by=task_count&page_size=100&page_number=${page}`,
        { headers: this.headers(key) },
      ).catch(() => ({ status: 599, body: null }));
      if (status >= 400) break;
      const listed = body as { items?: Array<Record<string, unknown>>; has_more?: unknown } | null;
      items.push(...(listed?.items ?? []));
      if (listed?.has_more !== true) break;
    }
    return items
      .filter((v) => typeof v["_id"] === "string" && typeof v["title"] === "string" && (v["type"] === undefined || v["type"] === "tts"))
      .map((v) => ({
        provider: "fishaudio",
        model: FISH_MODEL,
        voiceId: v["_id"] as string,
        label: v["title"] as string,
        attributes: [...(Array.isArray(v["languages"]) ? v["languages"] : []), ...(Array.isArray(v["tags"]) ? v["tags"] : [])]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .map((s) => s.toLowerCase()),
        local: false,
        canClone: false,
      }));
  }
}

/** A model's `state` moves created → trained (or failed); only a failed one is unusable. */
const usable = (state: unknown) => state !== "failed";

const firstWords = (text: string) => {
  const words = text.trim().split(/\s+/);
  return words.slice(0, 6).join(" ") + (words.length > 6 ? " …" : "");
};

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((n) => typeof n === "number");
