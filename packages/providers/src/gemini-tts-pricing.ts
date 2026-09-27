import type { Pricing } from "@arke-studio/contracts";

/**
 * Reviewed 2026-09-27: https://ai.google.dev/gemini-api/docs/pricing
 * Serving limits: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts
 * No free-tier, caching or batch discount is assumed for an interactive read. These rates do
 * not enable a model: provider qualification and the catalogue are separate (SPEC-049 R-34).
 */
export function geminiSpeechPricing(variant: "flash" | "lite"): Extract<Pricing, { kind: "perToken" }> {
  const output = variant === "flash" ? 9_000_000 : 6_000_000;
  return {
    kind: "perToken", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: output,
    speech: {
      tier: "standard", audioTokensPerSecond: 25, maxInputTokens: 8192, maxOutputTokens: 16384,
      rates: [
        { version: `gemini-3.8-${variant}-standard-2026-09-27`, effectiveFrom: "2026-09-27T00:00:00.000Z",
          microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: output },
        { version: `gemini-3.8-${variant}-standard-2027-01-01`, effectiveFrom: "2027-01-01T00:00:00.000Z",
          microUsdPerMillionInput: 1_000_000, microUsdPerMillionOutput: output * 2 },
      ],
    },
  };
}
