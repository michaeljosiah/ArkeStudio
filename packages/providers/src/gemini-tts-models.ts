import type { ManifestModel } from "@arke-studio/contracts";
import { geminiSpeechPricing } from "./gemini-tts-pricing.js";
import { GEMINI_SOUNDS } from "./voice-direction.js";

export const GEMINI_SPEECH_INPUT_BYTES = 7000;

/**
 * A grouped read's whole input, words and every turn's style together (design turn 185): the
 * coordinator packs a request to about 6,000 estimated tokens at 4 bytes a token, and this guard
 * sits a little above that and under the service's 8,192 tokens unless the words bill under 3.2
 * bytes a token — prose measured 4.4, short lines nearer 3.
 */
export const GEMINI_GROUPED_INPUT_BYTES = 26_000;
/** Turns in one grouped read: far past five minutes of blocks, a bound on a malformed job rather than a plan. */
export const GEMINI_GROUPED_TURNS_MAX = 400;

/** Preset speech rows; custom voices and unqualified controls remain unavailable (SPEC-049). */
export function geminiSpeechModel(variant: "flash" | "lite"): ManifestModel {
  return {
    id: variant === "flash" ? "gemini-3.8-flash-tts" : "gemini-3.8-flash-lite-tts",
    provider: "google", capability: "voice-tts",
    displayName: variant === "flash" ? "Gemini 3.8 Flash TTS" : "Gemini 3.8 Flash-Lite TTS",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { audioFormat: "wav", maxSpeechUtf8Bytes: GEMINI_SPEECH_INPUT_BYTES },
    pricing: geminiSpeechPricing(variant),
    // Gemini 3.8 reads as Google's speech-generation page says (updated 2026-10-01, design turn
    // 181): the text is a verbatim transcript — a bracketed word is spoken — so delivery and the
    // note are language in speech_metadata.style; vocalizations, pauses and breath are its own
    // angle-bracket tags from its list (`<sigh>`, `<long pause>`, `<breath>`); emphasis is
    // capitals. Nothing in square brackets reaches it. Native speed stays held: the page
    // documents pace only as style language, which the note can say.
    cadence: {
      deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"],
      speed: null, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization", breath: "best-effort-audio-tag", outputTimestamps: "none",
      phrase: "best-effort-instruction", tagSyntax: "angle", sounds: GEMINI_SOUNDS,
      // Several styled turns in one request on a designed voice were heard on Flash (the turn
      // 185 probe, 2026-10-03: all three packings came back whole, B chosen by ear). Flash-Lite
      // has not been heard, so it reads per paragraph until it is (SPEC-049 R-48).
      ...(variant === "flash" ? { groupable: true as const } : {}),
      deliveryMappings: {
        measured: { settings: {}, instruction: "Read calmly and evenly, at a steady pace." },
        whispered: { settings: {}, instruction: "Read in a whisper." },
        breaking: { settings: {}, instruction: "Read with a breaking voice, through tears." },
        cold: { settings: {}, instruction: "Read coldly and flatly, without warmth." },
        warm: { settings: {}, instruction: "Read warmly and gently." },
        urgent: { settings: {}, instruction: "Read urgently, with a pressing pace." },
      },
    },
  };
}
