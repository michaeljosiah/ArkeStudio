import { z } from "zod";
import type { VoiceCandidate } from "./voice.js";
import { extractVoiceAttributes } from "./voice.js";
import { quoteSpeech, type SpeechQuote } from "./speech-pricing.js";
import type { ManifestModel } from "./manifest.js";
import type { NarratorDesignedVoice } from "./settings.js";

export const DesignedVoiceModelSchema = z.enum(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);
export const VoiceDesignDraftSchema = z.object({
  model: DesignedVoiceModelSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4000),
  language: z.string().min(1).max(64).refine(value => {
    try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
  }, "Choose a language tag such as en-GB"),
}).strict();
export type VoiceDesignDraft = z.infer<typeof VoiceDesignDraftSchema>;

/** SPEC-049 R-14: world identity and acoustic revision are independent of Google's binding. */
export const DesignedVoiceSchema = z.object({
  kind: z.literal("designed"),
  id: z.string().regex(/^dv_[0-9A-HJKMNP-TV-Z]{26}$/),
  revision: z.number().int().positive(),
  name: z.string().min(1).max(1000),
  description: z.string().min(1).max(16000),
  language: z.string().min(1).max(64),
  provider: z.literal("google"),
  model: DesignedVoiceModelSchema,
  remoteId: z.string().regex(/^voice_[A-Za-z0-9_-]{1,200}$/),
  expiresAt: z.string().datetime({ offset: true }),
  created: z.string().datetime({ offset: true }),
  origin: z.enum(["generated", "imported"]),
  creationJobId: z.string().optional(),
  sample: z.string().regex(/^voices\/dv_[0-9A-HJKMNP-TV-Z]{26}\.wav$/),
}).strict();
export type WorldDesignedVoice = z.infer<typeof DesignedVoiceSchema>;

/** Namespaced target carries acoustic identity through assignments, takes and existing caches. */
export function designedVoiceTarget(voice: Pick<WorldDesignedVoice, "id" | "revision">): string {
  return `designed:${voice.id}:${voice.revision}`;
}
export function isDesignedVoiceTarget(value: string): boolean { return value.startsWith("designed:"); }
export function resolveDesignedVoice(voices: readonly WorldDesignedVoice[], target: string): WorldDesignedVoice | undefined {
  return voices.find(voice => designedVoiceTarget(voice) === target);
}
/** What the narrator keeps of a designed voice (SPEC-049 R-12): identity and binding, never the world's sample path. */
export function narratorDesignedRecord(voice: Pick<WorldDesignedVoice, keyof NarratorDesignedVoice>): NarratorDesignedVoice {
  return { id: voice.id, revision: voice.revision, name: voice.name, description: voice.description, language: voice.language, model: voice.model, remoteId: voice.remoteId, expiresAt: voice.expiresAt };
}
export function parseDesignedVoices(raw: unknown): WorldDesignedVoice[] {
  const entries = (raw as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => { const parsed = DesignedVoiceSchema.safeParse(entry); return parsed.success ? [parsed.data] : []; });
}
export function designedVoiceCandidates(voices: readonly Pick<WorldDesignedVoice, "id" | "revision" | "name" | "description" | "expiresAt">[], at = Date.now()): VoiceCandidate[] {
  return voices.flatMap(voice => DesignedVoiceModelSchema.options.map(model => ({
    provider: "google", model, voiceId: designedVoiceTarget(voice), label: voice.name,
    attributes: extractVoiceAttributes(voice.description), local: false, canClone: false, readsDesigned: voice.id,
    ...(Date.parse(voice.expiresAt) <= at ? { unavailableReason: "This Google voice has expired. Saved audio still plays; create or import a replacement for new reads." } : {}),
  })));
}

/** Published model rates are the explicit basis, not an endpoint-specific price guarantee. */
export function quoteVoiceDesign(model: ManifestModel, description: string, at?: string): SpeechQuote {
  // Voice design stays priced on a Free key (design turn 182): Google does not say it is free,
  // so the author's plan, which covers reads, is left off the row before it is quoted.
  // The description is not read aloud, so a read's estimate from its words would mean nothing:
  // the allowance stays the service limits, as R-19 decided.
  const quote = quoteSpeech({ ...model, speechPlan: undefined }, description, { at, atServiceLimit: true });
  return { ...quote, costBasis: "estimate", tokenLimits: undefined, assumptions: [
    "Estimate uses Google's published Standard model rates and full model token limits as a budgeting allowance.",
    "CreateVoice reports usage but documents no separate tariff or request spending cap. This allowance is not an enforced maximum.",
    "Free-tier eligibility and quotas are determined by Google; the estimate uses paid rates.",
  ] };
}
