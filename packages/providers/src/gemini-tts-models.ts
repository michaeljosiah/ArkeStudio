import type { ManifestModel } from "@arke-studio/contracts";
import { geminiSpeechPricing } from "./gemini-tts-pricing.js";

export const GEMINI_SPEECH_INPUT_BYTES = 7000;

/** Qualification rows, not entries in the shipped catalogue (SPEC-049 R-21, R-25, R-34). */
export function geminiSpeechModel(variant: "flash" | "lite"): ManifestModel {
  return {
    id: variant === "flash" ? "gemini-3.8-flash-tts" : "gemini-3.8-flash-lite-tts",
    provider: "google", capability: "voice-tts",
    displayName: variant === "flash" ? "Gemini 3.8 Flash TTS" : "Gemini 3.8 Flash-Lite TTS",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { audioFormat: "wav", maxSpeechUtf8Bytes: GEMINI_SPEECH_INPUT_BYTES },
    pricing: geminiSpeechPricing(variant),
    // Direction is best-effort language in speech_metadata.style, never a spoken prefix.
    // Native speed, point tags and exact pauses remain held until their own qualification.
    cadence: {
      deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"],
      speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
      phrase: "best-effort-instruction",
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
