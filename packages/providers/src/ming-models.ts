import { MING_MODELS, MING_REQUEST_CHARS, type ManifestModel } from "@arke-studio/contracts";

/** Direction is best effort. It does not promise accent retention or complete words. */
export const MING_MANIFEST_MODELS: ManifestModel[] = Object.entries(MING_MODELS).map(([id, info]) => ({
  id, provider: "ming", capability: "voice-tts", displayName: info.label,
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: MING_REQUEST_CHARS, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
  requires: { platform: ["win32"], accelerator: ["cuda"], vramMb: info.variant === "dense" ? 4096 : 10240, memMb: info.variant === "dense" ? 8000 : 24000, diskMb: info.variant === "dense" ? 3400 : 18800 },
  cadence: { deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"], speed: null,
    pause: "best-effort-punctuation", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none", phrase: "best-effort-instruction",
    deliveryMappings: {
      measured: { settings: {}, instruction: "Read evenly, calmly, at a steady pace." },
      whispered: { settings: {}, instruction: "Whisper very quietly, close to the listener, with restrained urgency." },
      breaking: { settings: {}, instruction: "Speak with a breaking voice, struggling to hold back tears." },
      cold: { settings: {}, instruction: "Speak coldly, flat and distant, without warmth." },
      warm: { settings: {}, instruction: "Speak warmly and gently, with affection." },
      urgent: { settings: {}, instruction: "Speak with sharp urgency, fast and pressing." },
    } },
}));
