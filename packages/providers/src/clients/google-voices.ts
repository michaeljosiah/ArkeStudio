import type { DesignedVoice, VoiceDesignInput, VoiceDesignResult } from "../types.js";
import { ProviderRequestRejectedError } from "../types.js";
import { GEMINI_TTS_MODELS, geminiSpeechUsage, geminiWav } from "./google.js";

// SPEC-049 R-14/R-19. Reviewed 2026-09-28 against /api/voices and /docs/voice-design.
// Uses published model rates as an explicitly labelled estimate (SPEC-049 R-19).
// CreateVoice has no documented per-request spending cap.
export const GEMINI_VOICE_DESIGN_AVAILABILITY = {
  available: true,
  pricingBasis: "published-model-rate-estimate",
} as const;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** A stored id is addressable; a voicekey is a secret and must never become world metadata. */
export function isGoogleVoiceId(value: unknown): value is string {
  return typeof value === "string" && /^voice_[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function requireGoogleVoiceId(value: string): void {
  if (!isGoogleVoiceId(value)) throw new ProviderRequestRejectedError("Google: choose a stored voice id");
}

/** Local input limits, not claims about undocumented vendor limits. No network work here. */
export function googleVoiceDesignBody(input: VoiceDesignInput): object {
  if (!GEMINI_TTS_MODELS.some(model => model === input.model)) throw new ProviderRequestRejectedError("Google: unsupported voice design model");
  if (!text(input.name, 120) || !text(input.description, 4000)) throw new ProviderRequestRejectedError("Google: voice design needs a name and a description within the supported limits");
  if (!text(input.language, 64)) throw new ProviderRequestRejectedError("Google: voice design needs a language tag");
  try { Intl.getCanonicalLocales(input.language); }
  catch { throw new ProviderRequestRejectedError("Google: voice design needs a valid language tag"); }
  if (input.gender !== undefined && !["female", "male", "neutral"].includes(input.gender)) throw new ProviderRequestRejectedError("Google: unsupported voice gender");
  return { store: true, voice: { model: input.model, type: "prompted", display_name: input.name.trim(),
    language_code: input.language, ...(input.gender ? { gender: input.gender } : {}), prompted: { input: input.description.trim() } } };
}

function metadata(value: unknown): DesignedVoice | undefined {
  const voice = record(value);
  if (!isGoogleVoiceId(voice.id) || voice.type !== "prompted" || voice.key !== undefined
    || !GEMINI_TTS_MODELS.some(model => model === voice.model)
    || !text(voice.display_name, 1000) || !text(record(voice.prompted).input, 16_000)
    || !text(voice.language_code, 64) || !text(voice.expire_time, 64)
    || !/^\d{4}-\d{2}-\d{2}T/.test(voice.expire_time) || !Number.isFinite(Date.parse(voice.expire_time))) return undefined;
  return { remoteId: voice.id, model: voice.model as string, name: voice.display_name,
    description: record(voice.prompted).input as string, language: voice.language_code, expiresAt: voice.expire_time };
}

/** Return evidence instead of throwing away an already-created identity when its sample fails. */
export function googleVoiceDesignResult(value: unknown, expected: { remoteId?: string; model?: string } = {}): VoiceDesignResult {
  const body = record(value);
  const remoteId = isGoogleVoiceId(body.id) ? body.id : undefined;
  const speechUsage = body.usage !== undefined ? geminiSpeechUsage(body.usage) : undefined;
  const receipt = { ...(remoteId ? { remoteId } : {}), ...(speechUsage ? { speechUsage } : {}) };
  const voice = metadata(body);
  if (!voice || (expected.remoteId !== undefined && remoteId !== expected.remoteId)
    || (expected.model !== undefined && voice.model !== expected.model)) {
    return { ...receipt, problem: "Google returned incomplete or mismatched voice metadata; do not repeat the creation" };
  }
  const sample = record(body.sample_audio);
  // Bound before decoding and reject permissive base64 decoding of truncated/foreign payloads.
  if (sample.mime_type !== "audio/wav" || typeof sample.data !== "string" || sample.data.length > 16 * 1024 * 1024
    || sample.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sample.data)) {
    return { ...receipt, voice, problem: "The voice exists but Google returned no usable audition; retrieve this id again" };
  }
  const bytes = Buffer.from(sample.data, "base64");
  if (bytes.toString("base64") !== sample.data || !geminiWav(bytes)) {
    return { ...receipt, voice, problem: "The voice exists but its audition is not a complete supported WAV; retrieve this id again" };
  }
  return { ...receipt, voice, sample: { name: "voice-preview.wav", contentType: "audio/wav", data: bytes } };
}

export function googleDesignedVoicePage(value: unknown, previousToken?: string): { voices: DesignedVoice[]; nextPageToken?: string } {
  const body = record(value);
  // Empty protobuf collections may be omitted. Never return a partially parsed catalogue as complete.
  if (body.voices !== undefined && (!Array.isArray(body.voices) || body.voices.length > 50)) throw new Error("Google returned an invalid designed voice page");
  const voices = ((body.voices ?? []) as unknown[]).map(metadata);
  if (voices.some(voice => !voice) || new Set(voices.map(voice => voice!.remoteId)).size !== voices.length) throw new Error("Google returned invalid designed voice metadata");
  const next = body.next_page_token;
  if (next !== undefined && next !== "" && (!text(next, 4096) || next === previousToken)) throw new Error("Google returned an invalid designed voice page token");
  return { voices: voices as DesignedVoice[], ...(next ? { nextPageToken: next as string } : {}) };
}
