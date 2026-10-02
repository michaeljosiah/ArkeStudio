import { z } from "zod";
import { orderedShots } from "./scene-flow.js";
import type { ProductionBundle } from "./client-state.js";
import type { ManifestModel } from "./manifest.js";
import { PROVIDERS, type ProviderInfo } from "./provider.js";
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
    description: z.string().optional(),
    facets: z.object({
      language: z.string().optional(), accent: z.string().optional(),
      gender: z.string().optional(), style: z.string().optional(),
    }).strict().optional(),
    /** Public provider sample; only the coordinator fetches it, from an approved host. */
    previewUrl: z.string().url().optional(),
    preview: z.object({
      kind: z.enum(["sample", "generate", "unavailable"]),
      microUsd: z.number().int().nonnegative().optional(),
      reason: z.string().optional(),
    }).strict().optional(),
    /** Whether the selected execution target is this machine. */
    local: z.boolean(),
    canClone: z.boolean(),
    /** The library voice this candidate reads, for a hosted reader or the recipe (SPEC-046 R-10). */
    readsClone: z.string().min(1).optional(),
    readsDesigned: z.string().min(1).optional(),
    /**
     * The app narrator's own copy of a designed voice the open world does not hold (SPEC-049
     * R-12): listed so the narrator can be seen and kept here, and good for narration only — a
     * sheet, a bench take or a book is never given a voice whose record is another world's.
     */
    narratorCopy: z.literal(true).optional(),
    /** Why this concrete target cannot execute now. Existing assignments remain visible with it. */
    unavailableReason: z.string().min(1).optional(),
  })
  .strict();
export type VoiceCandidate = z.infer<typeof VoiceCandidateSchema>;

export const NARRATOR_PREVIEW_TEXT = "The harbour remembers every story. Listen closely, and a new world begins.";
export const VOICE_PREVIEW_SCOPE = "app:voice-previews" as const;
export const VOICE_FACETS = ["language", "accent", "gender", "style", "provider"] as const;
export type VoiceFacet = typeof VOICE_FACETS[number];
export type VoiceFilters = Partial<Record<VoiceFacet, string>>;
export const UNSPECIFIED_VOICE_FACET = "__unspecified__";
const voiceLanguageNames = new Intl.DisplayNames(["en"], { type: "language" });
export function voiceFacet(voice: VoiceCandidate, facet: VoiceFacet): string {
  const value = (facet === "provider" ? voice.provider : voice.facets?.[facet])?.trim().toLocaleLowerCase();
  if (facet === "language" && value && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(value)) {
    // An explicit language tag says which language, not which accent a person speaks with.
    return voiceLanguageNames.of(value.split("-")[0]!)?.toLowerCase() ?? value;
  }
  return value || UNSPECIFIED_VOICE_FACET;
}
export function filterVoices<T extends VoiceCandidate>(voices: readonly T[], query: string, filters: VoiceFilters): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return voices.filter(voice => {
    const text = [voice.label, voice.description, voice.provider, voice.model, ...voice.attributes, ...Object.values(voice.facets ?? {})].join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term)) && VOICE_FACETS.every(facet => !filters[facet] || voiceFacet(voice, facet) === filters[facet]);
  }).sort((a, b) => a.label.localeCompare(b.label) || voiceTargetKey(a).localeCompare(voiceTargetKey(b)));
}

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
      cloudSpeechPreference(a.candidate) - cloudSpeechPreference(b.candidate) ||
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
    /**
     * The language the recording was spoken in (ISO 639-1), asked at clone time (issue 1163).
     * A slot-keeping reader saves the voice under it — Breeze's save requires one, and read
     * every voice as English before this field existed — and a read through a hosted reader
     * states it, which is what decides the R-23 tag. `en` for an entry written before it was
     * asked, and for anything hand-edited into a shape that is not a code: the voice is not the
     * thing to lose over its language.
     */
    language: z.string().regex(/^[a-z]{2}$/).catch("en"),
    /**
     * What each hosted reader holds of this voice (SPEC-046 R-13, R-16), keyed by provider id.
     * `confirmedAt` is the once-per-vendor answer to "send this recording?"; a reader that keeps
     * the clip on the account — Breeze's voice slot — records the id it keeps it under and the
     * hash of the clip it was made from, so a re-recorded clip is cloned again rather than read
     * from a stale slot. Mistral holds nothing: the clip rides with every call.
     *
     * As lenient as the rest of the entry: a hand-edited or newer-build `remote` reads as absent
     * — the person is asked again and a slot is made again — rather than dropping the voice.
     */
    remote: z
      .record(
        z.string().min(1),
        z
          .object({
            confirmedAt: z.string().min(1).optional(),
            voiceId: z.string().min(1).optional(),
            clipHash: z.string().min(1).optional(),
            savedAt: z.string().min(1).optional(),
            /** Replaced copies the vendor has not yet confirmed removed: tried again at the next read (R-15). */
            stale: z.array(z.string().min(1)).optional(),
            /** Titles of saves whose answer never came back: looked up and reconciled at the next read. */
            pending: z.array(z.string().min(1)).optional(),
            /**
             * The language the vendor saved the voice under when it overrode the one stated — its
             * own analysis of the recording (Breeze, probed 2026-09-15: an English-described clip
             * heard as Japanese). Reads still state the library's language as the speech language;
             * this records what the vendor's copy is, so the difference is on the entry rather than lost.
             */
            language: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
  })
  .passthrough();
export type ClonedVoice = z.infer<typeof ClonedVoiceSchema>;

// Retained only to read old assignments without rewriting the world or selecting a new reader.
const RETIRED_LOCAL_VOICE_MODEL = "comfyui-cloned-voice";
export const KOKORO_VOICE_MODEL = "kokoro-82m" as const;
export const ELEVENLABS_VOICE_MODEL = "eleven_multilingual_v2" as const;

/**
 * The hosted readers of the world's cloned voices (SPEC-046 D1): one voice, several readers. A
 * library voice addressed as `{provider, model, voiceId}` with one of these rows is the same
 * recording read in the cloud. Provider id → the one
 * `voice-tts` manifest row that reads a clip there.
 */
export const HOSTED_VOICE_READERS: Readonly<Record<string, string>> = {
  mistral: "voxtral-mini-tts",
  breezeblue: "breeze-tts-2",
  fishaudio: "fish-s2.1-pro",
};

export function isHostedVoiceReader(provider: string, model?: string): boolean {
  const row = HOSTED_VOICE_READERS[provider];
  return row !== undefined && (model === undefined || model === row);
}

/** The vendor's name as the confirmation and its notice say it (SPEC-046 R-16, R-17). */
export const HOSTED_READER_LABELS: Readonly<Record<string, string>> = {
  mistral: "Mistral",
  breezeblue: "BreezeBlue",
  fishaudio: "Fish Audio",
};

/**
 * The readers that keep the clip on the account — Breeze's voice slot, Fish's voice model —
 * addressed by an id the library records (SPEC-046 R-13). Mistral takes the bytes with every
 * call and keeps nothing. Known here rather than only where the slot is made because a screen
 * states a first read's consequence before the read (R-14, R-34), and the two must agree on
 * which readers have one.
 */
const READERS_KEEPING_SLOT: ReadonlySet<string> = new Set(["breezeblue", "fishaudio"]);

export function hostedReaderKeepsSlot(provider: string): boolean {
  return READERS_KEEPING_SLOT.has(provider);
}

/**
 * What a first read through a slot-keeping reader adds, said before it (SPEC-046 R-14, R-34):
 * Breeze charges a flat per-clone fee its docs do not quantify, so the amount is the vendor's
 * to state; Fish makes the model for nothing (probed 2026-09-13), so only the making is said.
 * Null once the library records the slot — the second read is a read — and for a reader that
 * keeps nothing. A recorded slot was made from one recording (R-13): given the current
 * recording's hash, a slot made from another is one the next read remakes, and the charge is
 * said again as a re-recording's (SPEC-046 R-40). A slot the vendor's console deleted is found
 * at the read (§2.4), not here.
 */
export function firstReadNotice(voice: Pick<ClonedVoice, "remote">, provider: string, clipHash?: string): string | null {
  if (!hostedReaderKeepsSlot(provider)) return null;
  const held = voice.remote?.[provider];
  const remade = held?.voiceId !== undefined && clipHash !== undefined && held.clipHash !== undefined && held.clipHash !== clipHash;
  if (held?.voiceId !== undefined && !remade) return null;
  const when = remade ? "re-recorded" : "first read";
  return provider === "breezeblue"
    ? `${when} · clone charge, priced by BreezeBlue`
    : `${when} · voice made on ${HOSTED_READER_LABELS[provider] ?? provider}`;
}

/**
 * The reader's short name, as the Voice page's `Reads lines` row and a cloned voice's reader
 * chips say it (SPEC-046 R-30): `Voxtral · $0.016 per 1k`. Keyed by model rather than vendor.
 * A model not named here reads as its row's
 * display name, and with no row as its provider.
 */
const READER_NAMES: Readonly<Record<string, string>> = {
  "gemini-3.8-flash-tts": "Gemini Flash",
  "gemini-3.8-flash-lite-tts": "Gemini Flash-Lite",
  "kokoro-82m": "Kokoro",
  "eleven_multilingual_v2": "ElevenLabs",
  "eleven-v3": "Eleven v3",
  "voxtral-mini-tts": "Voxtral",
  "breeze-tts-2": "Breeze",
  "fish-s2.1-pro": "Fish Audio",
};

/** Rank new cloud choices only; never rewrite an assignment or the local app narrator. */
export function cloudSpeechPreference(target: { provider: string; model?: string | null }, use: "creative" | "routine" = "creative"): number {
  if (target.provider !== "google") return 2;
  const preferred = use === "routine" ? "gemini-3.8-flash-lite-tts" : "gemini-3.8-flash-tts";
  if (target.model === preferred) return 0;
  return target.model === "gemini-3.8-flash-lite-tts" || target.model === "gemini-3.8-flash-tts" ? 1 : 2;
}

export function readerName(
  target: { provider: string; model?: string | null },
  row?: Pick<ManifestModel, "displayName"> | null,
): string {
  const named = target.model !== undefined && target.model !== null ? READER_NAMES[target.model] : undefined;
  return named ?? row?.displayName ?? target.provider;
}

/** A provider by its display name (`Mistral`, `Fish Audio`); one the table does not know keeps its id. */
export function providerName(provider: string): string {
  return (PROVIDERS as Readonly<Record<string, ProviderInfo | undefined>>)[provider]?.displayName ?? HOSTED_READER_LABELS[provider] ?? provider;
}

/**
 * Where a reader runs, as the audiobook names it (design turn 165): the provider's name and its
 * place — `Kokoro · this machine`, `Mistral · cloud`. The build printed `mistral · voxtral-mini-tts`
 * in the narrator's list and on every take (issue 1324 §3); an id is not something a person
 * chose. `local` is the catalogue's word for this voice where there is one, since ComfyUI can be
 * another machine — which is not the cloud, so a local provider served elsewhere says so, as
 * Settings does. A provider the table does not know keeps its id.
 */
export function readerPlace(provider: string, local?: boolean): string {
  const info = (PROVIDERS as Readonly<Record<string, ProviderInfo | undefined>>)[provider];
  const name = providerName(provider);
  const here = local ?? info?.local;
  if (here === undefined) return name;
  return `${name} · ${here ? "this machine" : info?.local === true ? "another machine" : "cloud"}`;
}

/**
 * A reader's price as a label (R-30): `free`, or the row's rate per thousand of the unit it
 * bills — `$0.016 per 1k`, `$0.015 per 1k bytes` — never a sentence. Three decimals where the
 * rate has them: $0.016 rounded to a cent is a different price. Null for a row priced some
 * other way, which no voice row is.
 */
export function readerPriceLabel(row: Pick<ManifestModel, "pricing" | "speechPlan"> | null | undefined): string | null {
  if (!row) return null;
  if (row.pricing.kind === "unmetered") return "free";
  // The author's plan, where the price was (design turn 182).
  if (row.speechPlan === "free-plan") return "free plan";
  if (row.speechPlan === "free-credit") return "free credit";
  if (row.pricing.kind === "perToken" && row.pricing.speech !== undefined) return "quoted per read";
  if (row.pricing.kind !== "perCharacter") return null;
  const perThousand = (row.pricing.microUsdPerCharacter / 1000).toFixed(3).replace(/(\.\d\d)0$/, "$1");
  const unit = row.pricing.unit === "utf8-byte" ? " bytes" : row.pricing.unit === "cjk-double" ? " · CJK ×2" : "";
  return `$${perThousand} per 1k${unit}`;
}

/**
 * Whether a voice can take a use. The retired local recipe takes none; every other voice takes
 * every use.
 *
 * A cloned voice narrates through a hosted reader (issue 1215; SPEC-046 §1.12). It was held out
 * of narration for two reasons: a long read went to the reader whole, and the narrator path
 * queued without the recording, so a clone it accepted would have reached the vendor as a preset
 * id it had never heard of (codex on PR 1153). PR 1210 made a read over the row's cap pieces,
 * and the narrator path now runs the voiced page's cloned-voice flow — the vendor's question
 * before the price, the recording with the job (`narratorVoice` in the coordinator).
 */
export function supportsVoiceUse(
  candidate: { provider: string; model?: string; readsClone?: string; narratorCopy?: true },
  use: "preview" | "line" | "bench" | "narration",
): boolean {
  if (candidate.narratorCopy === true && use !== "narration") return false;
  return candidate.provider !== "comfyui";
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
  if (provider === "comfyui" && model === RETIRED_LOCAL_VOICE_MODEL) {
    // Historical takes retain the recording's provenance. Eligibility is checked separately;
    // resolving this old source must neither offer a reader nor relabel it as licensed stock.
    const voice = voices.find((candidate) => candidate.id === voiceId);
    return voice ? { kind: "cloned", voice } : { kind: "missing-clone" };
  }
  // A hosted reader speaks its own presets AND the library's voices (SPEC-046 R-10). The library
  // decides which this id is: a match is the recording read in the cloud, anything else is one of
  // the vendor's presets, never "missing" — a preset was never in the library to go missing from.
  if (isHostedVoiceReader(provider, model)) {
    const voice = voices.find((candidate) => candidate.id === voiceId);
    return voice ? { kind: "cloned", voice } : { kind: "catalogue" };
  }
  return { kind: "catalogue" };
}

export function isClonedVoice(candidate: Pick<VoiceCandidate, "provider" | "model" | "readsClone">): boolean {
  return candidate.readsClone !== undefined;
}

/**
 * The library's voices as candidates for one hosted reader (SPEC-046 R-10): the same id, the
 * reader's provider and row. `readsClone` is what tells a picker these three candidates are one
 * voice with three readers, not three voices.
 */
export function cloudReaderCandidates(
  voices: readonly ClonedVoice[],
  reader: { provider: string; model: string },
  availability: { unavailableReason?: string } = {},
): VoiceCandidate[] {
  return voices.map((v) => ({
    provider: reader.provider,
    model: reader.model,
    voiceId: v.id,
    label: v.name,
    attributes: v.attributes,
    local: false,
    canClone: false,
    readsClone: v.id,
    ...(availability.unavailableReason !== undefined ? { unavailableReason: availability.unavailableReason } : {}),
  }));
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
  /** ISO 639-1; English when not said, which is what every reader assumed before it was asked. */
  language?: string;
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
  const language = (input.language ?? "en").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(language)) return { ok: false, reason: "a cloned voice's language is a two-letter code" };
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
      language,
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      consent: true,
      created: input.created,
    },
  };
}

/**
 * The languages the clone dialog offers (issue 1163): the codes Breeze routes by and Fish
 * detects across, in the order a select shows them. A voice in a language not listed is still
 * a voice — the schema takes any two-letter code — this is only what the dialog can name.
 */
export const CLONE_LANGUAGES: ReadonlyArray<readonly [code: string, name: string]> = [
  ["en", "English"], ["fr", "French"], ["de", "German"], ["es", "Spanish"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["tr", "Turkish"],
  ["ar", "Arabic"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
];

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
export const PerformanceDeliverySchema = DeliverySchema;
export const DELIVERIES = DeliverySchema.options;
export type Delivery = z.infer<typeof DeliverySchema>;

/**
 * A delivery as a reader's settings (R-15), read off the reader's cadence row — the one place a
 * reader says what it can do (design turn 181): the per-provider tables this replaced and
 * `limits.deliveries` disagreed with the rows (Eleven v3 offered six deliveries in the
 * audiobook and none on the Bench). A delivery the row does not read is refused with the
 * row's own list. The words a delivery carries — a tag, a sentence — are the compiler's
 * (`mapCadence`), never re-derived from this.
 */
export type DeliveryMapping =
  | { ok: true; params: Record<string, number> }
  | { ok: false; reason: string };

export function deliveryParams(model: Pick<ManifestModel, "cadence" | "displayName">, delivery: Delivery): DeliveryMapping {
  const cap = model.cadence;
  const mapping = cap?.deliveries.includes(delivery) ? cap.deliveryMappings[delivery] : undefined;
  if (mapping !== undefined) return { ok: true, params: { ...mapping.settings } };
  const reads = cap?.deliveries ?? [];
  return { ok: false, reason: reads.length === 0 ? `${model.displayName} takes no delivery` : `${model.displayName} reads ${reads.join(" · ")}` };
}

/**
 * The readers the performance path — Generate a line (SPEC-044 R-14) — can generate with. A
 * hosted reader's row declares a cadence like these do, and since issue 1149 the path carries
 * what a hosted read of a cloned voice needs — the vendor's confirmation at
 * `generate-performance`, `voiceReference: true` on the job so the dispatcher's clip read
 * prepares the slot, the clone's language for the R-23 tag — so the door that opens on a
 * cadence declaration and the gate that refuses read one list (codex on PR 1156).
 */
export const PERFORMANCE_GENERATION_PROVIDERS: readonly string[] = ["kokoro", "google", "elevenlabs", "mistral", "breezeblue", "fishaudio"];

export function supportsPerformanceGeneration(model: Pick<ManifestModel, "provider" | "capability" | "cadence"> | null | undefined): boolean {
  return model !== null && model !== undefined && model.capability === "voice-tts" && model.cadence !== undefined && PERFORMANCE_GENERATION_PROVIDERS.includes(model.provider);
}

/**
 * Deliveries a concrete model may offer before enqueue, from its cadence row alone (design turn
 * 181): absent means the reader's own reading only. `limits.deliveries` is no longer read.
 */
export function supportedDeliveries(model: Pick<ManifestModel, "cadence"> | null | undefined): readonly Delivery[] {
  return model?.cadence?.deliveries ?? [];
}

export function voiceFormatForModel(model: Pick<ManifestModel, "limits">): VoiceAudioFormat {
  return model.limits.audioFormat ?? "mp3";
}

/** Resolve assignments written before model identity became durable. */
export function legacyVoiceModel(provider: string, voiceId: string, clonedVoices: readonly ClonedVoice[] = []): string | null {
  if (provider === "kokoro") return KOKORO_VOICE_MODEL;
  if (provider === "elevenlabs") return ELEVENLABS_VOICE_MODEL;
  if (provider === "comfyui" && clonedVoices.some((voice) => voice.id === voiceId)) return RETIRED_LOCAL_VOICE_MODEL;
  if (HOSTED_VOICE_READERS[provider] !== undefined) return HOSTED_VOICE_READERS[provider]!;
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
 * Whether a stored narrator is this world's to read with (issue 1215, SPEC-046 R-37). A cloned
 * voice is the world's — `mintVoiceId` is unique within one world only — so a clone chosen as
 * the narrator in one world is not the voice of the same id in another: that is somebody else's
 * recording, and it must not leave the machine under a choice made elsewhere. `set-narrator`
 * records the world on a cloned choice; a choice with no world is a preset and reads wherever
 * its reader does. Isomorphic: the coordinator applies it before resolving, the screens before
 * naming the narrator.
 */
export function narratorAppliesTo(stored: { voiceId: string; worldId?: string } | null, worldId: string | undefined): boolean {
  return stored === null || stored.worldId === undefined || stored.worldId === worldId;
}

/**
 * What a screen calls the narrator: before a read lands, the stored choice's name where the
 * choice can narrate and applies to this world, the shipped voice's otherwise — the two
 * fallbacks a screen can judge; and once it has landed, the name of the voice that spoke,
 * because the coordinator falls back for reasons a screen cannot see — a recording gone, a key
 * withdrawn — and the player must never say the stored name over another voice. `spoke` is the
 * landed event's voice: the choice's name when it is the choice, the shipped voice's when it is
 * that, its id otherwise.
 */
export function narratorLabelFor(
  stored: { provider: string; model?: string; voiceId: string; label?: string; worldId?: string } | null,
  worldId: string | undefined,
  spoke?: { provider: string; voiceId: string },
): string {
  const chosen = stored !== null && supportsVoiceUse(stored, "narration") && narratorAppliesTo(stored, worldId) ? stored : null;
  // A choice that is not what reads is said, never swapped in silence: `Ife's voice unavailable
  // · reading with George` (issue 1215 follow-up) — a key withdrawn or a voice gone otherwise
  // looks like the narrator changing by itself.
  const instead = (reading: string) => (stored === null ? reading : `${stored.label ?? stored.voiceId} unavailable · reading with ${reading}`);
  if (spoke !== undefined) {
    if (chosen !== null && spoke.provider === chosen.provider && spoke.voiceId === chosen.voiceId) return chosen.label ?? chosen.voiceId;
    return instead(spoke.provider === DEFAULT_NARRATOR.provider && spoke.voiceId === DEFAULT_NARRATOR.voiceId ? DEFAULT_NARRATOR.label : spoke.voiceId);
  }
  return chosen === null ? instead(DEFAULT_NARRATOR.label) : (chosen.label ?? chosen.voiceId);
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
    const model = stored.model ?? legacyVoiceModel(stored.provider, stored.voiceId);
    const live = catalogue.find(
      (v) => v.provider === stored.provider && v.model === model && v.voiceId === stored.voiceId && supportsVoiceUse(v, "narration"),
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
