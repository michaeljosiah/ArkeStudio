import { HOSTED_VOICE_READERS, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
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

/** The manifest row's stable id, and the version Mistral serves behind it (SPEC-046 R-6). */
export const VOXTRAL_MODEL = HOSTED_VOICE_READERS["mistral"]!;
export const VOXTRAL_PROVIDER_MODEL = "voxtral-mini-tts-2603";

/**
 * Mistral's hosted presets are four speakers in fixed emotions — Paul (US), Oliver and Jane
 * (UK), Marie (French) — and Mistral publishes no call that lists them: they are known ids, read
 * from the endpoint's `supported_tts_voices` on 2026-09-13 (SPEC-046 R-32). The emotion is an
 * attribute to rank on, not a delivery control; every one of these is one read.
 */
const VOXTRAL_PRESET_IDS = [
  "en_paul_sad", "en_paul_neutral", "en_paul_happy", "en_paul_frustrated", "en_paul_excited", "en_paul_confident", "en_paul_cheerful", "en_paul_angry",
  "gb_oliver_neutral", "gb_oliver_sad", "gb_oliver_excited", "gb_oliver_curious", "gb_oliver_confident", "gb_oliver_cheerful", "gb_oliver_angry",
  "gb_jane_sarcasm", "gb_jane_confused", "gb_jane_shameful", "gb_jane_sad", "gb_jane_neutral", "gb_jane_jealousy", "gb_jane_frustrated", "gb_jane_curious", "gb_jane_confident",
  "fr_marie_sad", "fr_marie_neutral", "fr_marie_happy", "fr_marie_excited", "fr_marie_curious", "fr_marie_angry",
] as const;

const PRESET_ACCENT: Record<string, string> = { en: "american", gb: "british", fr: "french" };
const PRESET_GENDER: Record<string, string> = { paul: "male", oliver: "male", jane: "female", marie: "female" };

export const VOXTRAL_PRESETS = VOXTRAL_PRESET_IDS.map((id) => {
  const [region = "", speaker = "", emotion = ""] = id.split("_");
  const name = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  return {
    voiceId: id as string,
    label: `${name} · ${emotion}`,
    attributes: [PRESET_GENDER[speaker] ?? "", PRESET_ACCENT[region] ?? "", emotion, region === "fr" ? "french" : "english"].filter(Boolean),
  };
});

const WAV_HEADER = [0x52, 0x49, 0x46, 0x46]; // "RIFF"

/**
 * Mistral — Voxtral TTS as a hosted reader of the world's voices (SPEC-046 §2.3).
 *
 * Stateless by construction: the cloned voice's clip travels with every read as `ref_audio`,
 * and nothing is saved on the service. The two things that differ from every other voice client
 * are both on the wire. The non-streaming response is JSON carrying base64, where OpenAI's and
 * vLLM-Omni's endpoint at the same path return bytes — a client written against either reads
 * garbage here. And a 403 is not a bad key: it is Mistral's content moderation, or a plan without
 * text-to-speech, undistinguished. The ElevenLabs client's `401 || 403 → auth` is the wrong
 * precedent, because a moderated line reported as a rejected credential sends the person to
 * Settings to fix a key that is fine (R-24).
 *
 * The probe is `GET /v1/models`: authentication only. Mistral publishes no balance endpoint and
 * its rate limits are per workspace in the admin console, so whether the plan reaches TTS is not
 * known until the first line reads (R-2). Usage is reported only on the streaming path, which a
 * take does not use, so cost is manifest-derived (R-28).
 */
export class MistralClient implements ProviderClient, VoiceCatalogueClient {
  readonly id = "mistral" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://api.mistral.ai",
  ) {}

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/models`, { headers: this.headers(key) }),
    );
    if (!probe.ok) {
      const reason = probe.auth ? "Mistral rejected this key" : `Mistral could not be reached: ${probe.message}`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
      ];
    }
    if (probe.value.status >= 400) {
      const reason = `Mistral answered HTTP ${probe.value.status} to the models list`;
      return [
        { capability: "voice-tts", available: false, reason },
        { capability: "voice-clone", available: false, reason },
      ];
    }
    // Cloning is a request parameter on the same endpoint, not a plan feature, so it stands or
    // falls with speech itself.
    return [
      { capability: "voice-tts", available: true },
      { capability: "voice-clone", available: true },
    ];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    if (request.capability !== "voice-tts") throw new ProviderRequestRejectedError("mistral: unsupported synthesis capability");
    const text = String(request.params["text"] ?? "");
    if (text.trim() === "") throw new ProviderRequestRejectedError("mistral: there is no text to read");
    const voiceId = typeof request.params["voiceId"] === "string" ? request.params["voiceId"] : "";
    const reference = request.voiceReference;
    // A cloned voice rides as its clip; a preset rides as its id. One or the other — a preset id
    // that names a library voice would be sent to Mistral as a voice it has never heard of.
    if (reference === undefined && voiceId === "") throw new ProviderRequestRejectedError("mistral: a read needs a preset voice or a cloned voice's recording");
    const remoteId = `mistral-${++this.counter}-${Date.now()}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        model: request.model === VOXTRAL_MODEL ? VOXTRAL_PROVIDER_MODEL : request.model,
        input: text,
        response_format: "wav",
        ...(reference !== undefined
          ? { ref_audio: Buffer.from(reference.data).toString("base64") }
          : { voice_id: voiceId }),
      }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (res.status === 401) throw new ProviderAuthError("mistral", "mistral: the credential was rejected (HTTP 401)");
    if (res.status === 403) {
      // Moderation or plan — Mistral's 403 does not say which (SPEC-046 R-24). Naming the line
      // is what lets a person act: recompose it, or check the workspace's plan.
      throw new ProviderRequestRejectedError(
        `mistral: refused this line — its moderation, or a plan without text-to-speech — “${firstWords(text)}”`,
      );
    }
    if (res.status === 429) throw new ProviderBusyError(`mistral: the workspace's rate limit was reached (HTTP 429)`);
    if (res.status >= 500) throw new Error(`mistral: synthesis failed (HTTP ${res.status})`);
    if (res.status >= 400) throw new ProviderRequestRejectedError(`mistral: synthesis failed (HTTP ${res.status})${await detail(res)}`);
    // JSON with base64 inside, not audio bytes (§2.2). The WAV header is checked here because a
    // body that decoded to something else is the one failure the artifact verifier would otherwise
    // file as an unverifiable blob rather than name.
    const body = (await res.json().catch(() => null)) as { audio_data?: unknown } | null;
    const encoded = body?.audio_data;
    if (typeof encoded !== "string" || encoded.length === 0) throw new Error("mistral: the response carried no audio_data");
    const data = new Uint8Array(Buffer.from(encoded, "base64"));
    if (data.length < 44 || !WAV_HEADER.every((byte, i) => data[i] === byte)) throw new Error("mistral: the decoded audio is not a WAV file");
    return {
      remoteId,
      acceptedAt: new Date().toISOString(),
      artifacts: [{ name: "speech.wav", contentType: "audio/wav", data }],
    };
  }

  async poll(_key: string, _remoteId: string): Promise<PollResult> {
    return { state: "failed", error: "mistral: synchronous results must be returned by submit" };
  }

  async fetchArtifacts(_key: string, _remoteId: string): Promise<FetchedArtifact[]> {
    throw new Error("mistral: synchronous artifacts are returned by submit");
  }

  async cancel(): Promise<void> {
    /* synchronous API */
  }

  /** The thirty hosted presets, as picker candidates (SPEC-046 R-32). No network: Mistral lists none. */
  async listVoicesCatalog(): Promise<
    Array<{ provider: string; model: string; voiceId: string; label: string; attributes: string[]; local: boolean; canClone: boolean }>
  > {
    return VOXTRAL_PRESETS.map((preset) => ({
      provider: "mistral",
      model: VOXTRAL_MODEL,
      voiceId: preset.voiceId,
      label: preset.label,
      attributes: preset.attributes,
      local: false,
      // A preset is a voice somebody else recorded; nothing is cloned from it here (R-31).
      canClone: false,
    }));
  }
}

const firstWords = (text: string) => {
  const words = text.trim().split(/\s+/);
  return words.slice(0, 6).join(" ") + (words.length > 6 ? " …" : "");
};

/** The validation detail a 4xx body carries, when it carries one — a bare status is the failure issue 906 named (R-25). */
async function detail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown; detail?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message : typeof body?.detail === "string" ? body.detail : Array.isArray(body?.detail) ? JSON.stringify(body.detail) : "";
  return message.trim() === "" ? "" : `: ${message.trim()}`;
}
