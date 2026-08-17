import { z } from "zod";
import type { ProductionBundle } from "./client-state.js";
import type { Sheet } from "./world.js";

/**
 * Voice (SPEC-011): the unified catalogue, honest attribute-overlap matching (D5, D6), preview
 * line selection (D7), and delivery mapping (D9). Isomorphic — the picker renders the same
 * judgements the coordinator computes.
 */

export const VoiceCandidateSchema = z
  .object({
    provider: z.string().min(1),
    voiceId: z.string().min(1),
    label: z.string().min(1),
    /** Provider metadata as descriptive attributes: age, timbre, accent, pace … */
    attributes: z.array(z.string()),
    /** Local voices are a fixed catalogue and cannot be cloned (R-6, D4). */
    local: z.boolean(),
    canClone: z.boolean(),
  })
  .strict();
export type VoiceCandidate = z.infer<typeof VoiceCandidateSchema>;

export const VoiceRuntimeSourceSchema = z.enum(["environment", "configured", "bundled", "absent"]);
export type VoiceRuntimeSource = z.infer<typeof VoiceRuntimeSourceSchema>;

export const VoiceRuntimeFailureSchema = z.enum([
  "runtime-missing",
  "launch-failed",
  "architecture-mismatch",
  "incompatible-health",
  "kokoro-model-missing",
  "whisper-model-missing",
  "model-verification-failed",
  "phonemizer-unavailable",
]);
export type VoiceRuntimeFailure = z.infer<typeof VoiceRuntimeFailureSchema>;

const VoiceEngineStatusSchema = z
  .object({
    state: z.enum(["unknown", "missing", "downloading", "verification-failed", "unavailable", "ready"]),
    detail: z.string().optional(),
  })
  .strict();

export const VoiceRuntimeStatusSchema = z
  .object({
    source: VoiceRuntimeSourceSchema,
    configured: z.boolean(),
    bundledAvailable: z.boolean(),
    /** A basename only. Absolute executable paths never cross into renderer state. */
    executableName: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
    protocolVersion: z.literal(1).nullable(),
    architecture: z.enum(["x64", "arm64"]).nullable(),
    expectedArchitecture: z.enum(["x64", "arm64"]).nullable(),
    processState: z.enum(["unconfigured", "starting", "healthy", "unhealthy", "stopped", "failed"]),
    endpointCompatible: z.boolean(),
    failureCategory: VoiceRuntimeFailureSchema.nullable(),
    detail: z.string().min(1),
    configurationWarning: z.string().min(1).nullable(),
    engines: z.array(z.enum(["kokoro", "whisper"])),
    engineStatus: z
      .object({
        kokoro: VoiceEngineStatusSchema,
        whisper: VoiceEngineStatusSchema,
        phonemizer: VoiceEngineStatusSchema,
      })
      .strict(),
  })
  .strict();
export type VoiceRuntimeStatus = z.infer<typeof VoiceRuntimeStatusSchema>;

export const RankedVoiceSchema = z
  .object({
    candidate: VoiceCandidateSchema,
    /** The attributes responsible for the match — what a user can actually judge (R-7, D6). */
    matched: z.array(z.string()),
    /**
     * Attribute overlap: matched ÷ extracted, 0..1. Defined as overlap and labelled as such —
     * never a calibrated similarity (R-8, D5).
     */
    overlap: z.number().min(0).max(1),
  })
  .strict();
export type RankedVoice = z.infer<typeof RankedVoiceSchema>;

// ---------------------------------------------------------------------------
// Attribute extraction — lexical, deterministic, honest about what it is
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "before", "but", "by", "for", "from", "has", "he", "her",
  "his", "in", "into", "is", "it", "its", "of", "on", "or", "she", "so", "than", "that", "the",
  "their", "them", "then", "they", "to", "very", "when", "with", "would", "could", "she's",
  "he's", "never", "always", "speaks", "speak", "talks", "voice", "sounds", "sound", "word",
  "words", "people", "one", "she'll", "wastes", "keep", "keeps",
]);

/**
 * Extract matchable attributes from a written voice description (T-8, §2.4): lexical in v1,
 * consistent with the product's lexical-only stance. Deterministic: same text, same set.
 */
export function extractVoiceAttributes(written: string): string[] {
  const tokens = written
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/**
 * Rank candidates by attribute overlap (R-7, R-8): matched attributes shown, score defined as
 * overlap. A candidate with no metadata ranks last rather than erroring (§3.2).
 */
export function rankVoices(extracted: string[], candidates: VoiceCandidate[]): RankedVoice[] {
  const wanted = new Set(extracted.map((a) => a.toLowerCase()));
  const ranked = candidates.map((candidate) => {
    const matched = candidate.attributes
      .map((a) => a.toLowerCase())
      .filter((a) => wanted.has(a) || [...wanted].some((w) => a.includes(w) || w.includes(a)));
    const unique = [...new Set(matched)];
    return {
      candidate,
      matched: unique,
      overlap: wanted.size === 0 ? 0 : unique.length / wanted.size,
    };
  });
  // Stable: overlap desc, then local last among equals (cloud richer metadata), then label.
  return ranked.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      Number(a.candidate.local) - Number(b.candidate.local) ||
      a.candidate.label.localeCompare(b.candidate.label),
  );
}

// ---------------------------------------------------------------------------
// Preview lines (R-9, D7): the character's own words, then drafted, then stock
// ---------------------------------------------------------------------------

export interface PreviewLine {
  text: string;
  source: "own-line" | "drafted" | "stock";
}

const STOCK_LINE = "The tide turns when it turns, and not a moment before.";

export function previewLineFor(sheet: Sheet, productions: ProductionBundle[]): PreviewLine {
  // 1 — existing dialogue for this sheet, in any production.
  for (const production of productions) {
    for (const scene of production.scenes) {
      for (const shot of scene.shots) {
        const line = shot.audio?.kind === "vo" && shot.audio.speaker === sheet.id ? shot.audio.line : undefined;
        if (line !== undefined && line.trim().length > 0) {
          return { text: line, source: "own-line" };
        }
      }
    }
  }
  // 2 — drafted from the sheet's essence and written voice.
  const essence = sheet.sections.find((s) => s.heading === "Essence")?.body.split(/[.!?]/)[0]?.trim();
  if (essence && essence.length > 0) {
    return { text: `${essence}. That is all I will say on it.`, source: "drafted" };
  }
  // 3 — only when nothing else exists.
  return { text: STOCK_LINE, source: "stock" };
}

// ---------------------------------------------------------------------------
// Delivery (R-15, D9): shapes a take only; provider-specific; refusals stated
// ---------------------------------------------------------------------------

export const DELIVERIES = ["measured", "whispered", "breaking", "cold", "warm", "urgent"] as const;
export type Delivery = (typeof DELIVERIES)[number];

const ELEVENLABS_DELIVERY: Record<Delivery, Record<string, number>> = {
  measured: { stability: 0.7, similarity_boost: 0.8, style: 0.2 },
  whispered: { stability: 0.85, similarity_boost: 0.75, style: 0.55 },
  breaking: { stability: 0.25, similarity_boost: 0.7, style: 0.8 },
  cold: { stability: 0.9, similarity_boost: 0.85, style: 0.1 },
  warm: { stability: 0.55, similarity_boost: 0.8, style: 0.45 },
  urgent: { stability: 0.3, similarity_boost: 0.75, style: 0.65 },
};

/** Kokoro has far less range (§2.8): speed is the only shaping it can express. */
const KOKORO_DELIVERY: Partial<Record<Delivery, Record<string, number>>> = {
  measured: { speed: 0.92 },
  urgent: { speed: 1.15 },
};

export type DeliveryMapping =
  | { ok: true; params: Record<string, number> }
  | { ok: false; reason: string };

/**
 * Map a delivery to provider parameters, or state plainly that this voice's provider cannot
 * express it (R-15) — never a take that silently ignores the direction.
 */
export function deliveryParams(provider: string, delivery: Delivery): DeliveryMapping {
  if (provider === "elevenlabs") return { ok: true, params: ELEVENLABS_DELIVERY[delivery] };
  if (provider === "kokoro") {
    const params = KOKORO_DELIVERY[delivery];
    if (params) return { ok: true, params };
    return {
      ok: false,
      reason: `Kokoro cannot express "${delivery}" — local presets shape pace only; the read will be neutral`,
    };
  }
  return { ok: false, reason: `${provider} has no declared delivery mapping — the read will use provider defaults` };
}

// ---------------------------------------------------------------------------
// The narrator — who reads the app's own prose (asked for 2026-08-17)
// ---------------------------------------------------------------------------

/**
 * The local voice the app narrates in when nobody has chosen one.
 *
 * Local by default on purpose: "read this aloud" is a passive press, and no other preference in
 * this app spends money on one. A cloud narrator is available, and is chosen deliberately with
 * its per-character price stated.
 */
export const DEFAULT_NARRATOR = { provider: "kokoro", voiceId: "bm_george", label: "George" } as const;

export interface NarratorChoice {
  provider: string;
  voiceId: string;
  label: string | undefined;
  /** True when nobody chose this — the shipped local voice, and free. */
  fallback: boolean;
}

/**
 * Who narrates, decided in one place.
 *
 * A stored narrator whose voice is no longer in the catalogue falls back rather than failing:
 * a key withdrawn or a runtime uninstalled should quieten the reading to the local voice, not
 * turn every "read aloud" into an error about a voice the user cannot see any more.
 */
export function narratorFor(
  stored: { provider: string; voiceId: string; label?: string } | null,
  catalogue: readonly VoiceCandidate[],
): NarratorChoice {
  if (stored !== null) {
    const live = catalogue.find((v) => v.provider === stored.provider && v.voiceId === stored.voiceId);
    if (live) return { provider: live.provider, voiceId: live.voiceId, label: live.label, fallback: false };
  }
  return { ...DEFAULT_NARRATOR, label: DEFAULT_NARRATOR.label as string | undefined, fallback: true };
}
