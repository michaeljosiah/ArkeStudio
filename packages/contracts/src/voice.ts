import { z } from "zod";
import { orderedShots } from "./scene-flow.js";
import type { ProductionBundle } from "./client-state.js";
import type { ManifestModel } from "./manifest.js";
import type { Sheet } from "./world.js";

/**
 * Voice (SPEC-011): the unified catalogue, honest attribute-overlap matching (D5, D6), preview
 * line selection (D7), and delivery mapping (D9). Isomorphic — the picker renders the same
 * judgements the coordinator computes.
 */

export const VoiceCandidateSchema = z
  .object({
    provider: z.string().min(1),
    /** Concrete TTS model. Provider plus voice id is ambiguous once a provider has two models. */
    model: z.string().min(1),
    voiceId: z.string().min(1),
    label: z.string().min(1),
    /** Provider metadata as descriptive attributes: age, timbre, accent, pace … */
    attributes: z.array(z.string()),
    /** Whether the selected execution target is this machine. */
    local: z.boolean(),
    canClone: z.boolean(),
    /** Why this concrete target cannot execute now. Existing assignments remain visible with it. */
    unavailableReason: z.string().min(1).optional(),
  })
  .strict();
export type VoiceCandidate = z.infer<typeof VoiceCandidateSchema>;

/** Collision-free transient identity for maps and selection state. */
export function voiceTargetKey(target: Pick<VoiceCandidate, "provider" | "model" | "voiceId">): string {
  return JSON.stringify([target.provider, target.model, target.voiceId]);
}

/** The complete speech-container vocabulary carried by cache and result events. */
export const VoiceAudioFormatSchema = z.enum(["wav", "mp3", "flac"]);
export type VoiceAudioFormat = z.infer<typeof VoiceAudioFormatSchema>;

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
      a.candidate.label.localeCompare(b.candidate.label) ||
      a.candidate.provider.localeCompare(b.candidate.provider) ||
      a.candidate.model.localeCompare(b.candidate.model) ||
      a.candidate.voiceId.localeCompare(b.candidate.voiceId),
  );
}

// ---------------------------------------------------------------------------
// The cloned-voice library (SPEC-022 §2.3): a clip becomes something addressable
// ---------------------------------------------------------------------------

/** World-level, beside art-direction.json. A cloned voice belongs to the world (SPEC-022 D2). */
export const CLONED_VOICES_PATH = "voices/voices.json";

/**
 * One voice cloned from a recording.
 *
 * Read leniently on purpose. This file is the read path for every cloned voice a world owns, and
 * a schema that refuses an entry deletes a voice the user made — the same failure `SheetSchema`
 * exists to avoid. Only the three fields dispatch cannot proceed without are required; everything
 * else has a default, and `parseVoiceLibrary` drops a bad entry rather than the whole library.
 */
export const ClonedVoiceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** World-relative portable path to the clip, resolved to `spk_audio_prompt` at dispatch. */
    clip: z
      .string()
      .min(1)
      .max(400)
      .refine((value) => !value.startsWith("/") && !/^[a-zA-Z]:/.test(value), "a voice clip path is relative")
      .refine((value) => !value.includes("\\") && !value.includes("\0") && !value.includes(":"), "a voice clip path is portable")
      .refine(
        (value) => value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        "a voice clip path cannot traverse",
      ),
    /** Required when a voice is MADE (D3); defaulted here so an older file still reads. */
    description: z.string().default(""),
    attributes: z.array(z.string()).default([]),
    /** The artifact the recording was filed as — provenance, not ownership (§2.3). */
    artifactId: z.string().optional(),
    /** Recorded once, at capture. False on an entry written before it was asked for. */
    consent: z.boolean().default(false),
    created: z.string().default(""),
  })
  .passthrough();
export type ClonedVoice = z.infer<typeof ClonedVoiceSchema>;

export const CLONED_VOICE_PROVIDER = "comfyui" as const;
export const CLONED_VOICE_MODEL = "comfyui-cloned-voice" as const;
export const KOKORO_VOICE_MODEL = "kokoro-82m" as const;
export const ELEVENLABS_VOICE_MODEL = "eleven_multilingual_v2" as const;

/** Cloned voice narration is intentionally unsupported until long-form queue chunking exists. */
export function supportsVoiceUse(
  candidate: { provider: string; model?: string },
  use: "preview" | "line" | "bench" | "narration",
): boolean {
  return use !== "narration" ||
    candidate.provider !== CLONED_VOICE_PROVIDER ||
    (candidate.model !== undefined && candidate.model !== CLONED_VOICE_MODEL);
}

export type VoiceSourceResolution =
  | { kind: "catalogue" }
  | { kind: "cloned"; voice: ClonedVoice }
  | { kind: "missing-clone" };

/** One authority for deciding whether a target is backed by a world-owned reference clip. */
export function voiceSourceFor(
  voices: readonly ClonedVoice[],
  provider: string,
  model: string,
  voiceId: string,
): VoiceSourceResolution {
  if (provider !== CLONED_VOICE_PROVIDER || model !== CLONED_VOICE_MODEL) return { kind: "catalogue" };
  const voice = voices.find((candidate) => candidate.id === voiceId);
  return voice ? { kind: "cloned", voice } : { kind: "missing-clone" };
}

export function isClonedVoice(candidate: Pick<VoiceCandidate, "provider" | "model">): boolean {
  return candidate.provider === CLONED_VOICE_PROVIDER && candidate.model === CLONED_VOICE_MODEL;
}

/**
 * Parse a library, keeping what parses. A malformed entry costs one voice; refusing the file
 * would cost every voice in the world, and the user would be told nothing was ever cloned.
 */
export function parseVoiceLibrary(raw: unknown): ClonedVoice[] {
  const list = (raw as { voices?: unknown })?.voices;
  if (!Array.isArray(list)) return [];
  const out: ClonedVoice[] = [];
  for (const entry of list) {
    const parsed = ClonedVoiceSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Stable, readable, and collision-free within a world. */
export function mintVoiceId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "voice";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export type NewClonedVoice =
  | { ok: true; voice: ClonedVoice }
  | { ok: false; reason: string };

/**
 * Make a voice from a clip (D3, and §1.3's consent tick).
 *
 * The description is required here and nowhere else: `rankVoices` ranks a candidate with no
 * attributes last, so a voice cloned FOR a character would otherwise sink below every preset when
 * ranked against that same character. Refusing at creation is the only place that cannot be
 * skipped — a voice with no words to match by is a voice the picker buries.
 */
export function newClonedVoice(input: {
  name: string;
  description: string;
  clip: string;
  consent: boolean;
  artifactId?: string;
  created: string;
  taken: readonly string[];
}): NewClonedVoice {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: "a cloned voice needs a name" };
  const description = input.description.trim();
  if (!description) {
    return { ok: false, reason: "a cloned voice needs a description — it is what the picker matches on" };
  }
  const parsedClip = ClonedVoiceSchema.shape.clip.safeParse(input.clip.trim());
  if (!parsedClip.success) return { ok: false, reason: "a cloned voice needs a safe world-relative recording" };
  if (!input.consent) {
    return { ok: false, reason: "confirm the person speaking agreed to have their voice cloned" };
  }
  return {
    ok: true,
    voice: {
      id: mintVoiceId(name, input.taken),
      name,
      clip: parsedClip.data,
      description,
      attributes: extractVoiceAttributes(description),
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      consent: true,
      created: input.created,
    },
  };
}

/**
 * The library as picker candidates. Local, and never itself cloneable: cloning a clone would
 * copy a copy, and the original recording is already in the library beside it.
 */
export function clonedVoiceCandidates(
  voices: readonly ClonedVoice[],
  availability: { local?: boolean; unavailableReason?: string } = {},
): VoiceCandidate[] {
  return voices.map((v) => ({
    // The engine is ComfyUI, running a voice recipe (SPEC-022 §2.1). A cloned voice is addressed
    // like every other candidate — provider plus id — and the recipe is the model behind it, so
    // swapping the engine later is a recipe edit rather than a change to what a voice IS.
    provider: CLONED_VOICE_PROVIDER,
    model: CLONED_VOICE_MODEL,
    voiceId: v.id,
    label: v.name,
    attributes: v.attributes,
    local: availability.local ?? true,
    canClone: false,
    ...(availability.unavailableReason !== undefined
      ? { unavailableReason: availability.unavailableReason }
      : {}),
  }));
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
      for (const shot of orderedShots(scene)) {
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

export const DeliverySchema = z.enum(["measured", "whispered", "breaking", "cold", "warm", "urgent"]);
export const DELIVERIES = DeliverySchema.options;
export type Delivery = z.infer<typeof DeliverySchema>;

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

/** Deliveries a concrete model may offer before enqueue; absent means provider defaults only. */
export function supportedDeliveries(model: Pick<ManifestModel, "limits"> | null | undefined): readonly Delivery[] {
  return model?.limits.deliveries ?? [];
}

export function voiceFormatForModel(model: Pick<ManifestModel, "limits">): VoiceAudioFormat {
  return model.limits.audioFormat ?? "mp3";
}

/** Resolve assignments written before model identity became durable. */
export function legacyVoiceModel(provider: string, voiceId: string, clonedVoices: readonly ClonedVoice[] = []): string | null {
  if (provider === "kokoro") return KOKORO_VOICE_MODEL;
  if (provider === "elevenlabs") return ELEVENLABS_VOICE_MODEL;
  if (provider === CLONED_VOICE_PROVIDER && clonedVoices.some((voice) => voice.id === voiceId)) return CLONED_VOICE_MODEL;
  return null;
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
export const DEFAULT_NARRATOR = {
  provider: "kokoro",
  model: KOKORO_VOICE_MODEL,
  voiceId: "bm_george",
  label: "George",
} as const;

export interface NarratorChoice {
  provider: string;
  model: string;
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
  stored: { provider: string; model?: string; voiceId: string; label?: string } | null,
  catalogue: readonly VoiceCandidate[],
): NarratorChoice {
  if (stored !== null) {
    const model = stored.model ?? (
      stored.provider === CLONED_VOICE_PROVIDER &&
      catalogue.some((voice) => isClonedVoice(voice) && voice.voiceId === stored.voiceId)
        ? CLONED_VOICE_MODEL
        : legacyVoiceModel(stored.provider, stored.voiceId)
    );
    const live = catalogue.find(
      (v) => v.provider === stored.provider && v.model === model && v.voiceId === stored.voiceId,
    );
    if (live) {
      return {
        provider: live.provider,
        model: live.model,
        voiceId: live.voiceId,
        label: live.label,
        fallback: false,
      };
    }
  }
  return { ...DEFAULT_NARRATOR, label: DEFAULT_NARRATOR.label as string | undefined, fallback: true };
}
