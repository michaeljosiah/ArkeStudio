import { providerFaultCategory } from "./diagnostics.js";
import { credentialFaulted, type ProviderStatus } from "./provider.js";
import { legacyVoiceModel, providerName, supportsVoiceUse, type VoiceCandidate } from "./voice.js";

/** The longest reason said for a narrator that cannot read: a vendor's raw error can run to pages. */
export const NARRATOR_UNAVAILABLE_MAX = 300;

/**
 * Why the book's own narrator cannot read now, in words an author can act on (`Google needs
 * payment`), or null while it can (issue 1661). The book keeps its narrator either way (#1752);
 * this is what holds Direct and Read and says why on the chapter and the door. A 402 once left a
 * read waiting on `request 1 of 9` with the reason only in app.jsonl, and a chapter directed for
 * the voice it would have fallen to.
 *
 * Judged as the coordinator judges the book's narrator: against the world's voices that can
 * narrate now, never the app narrator's copy of another world's (SPEC-049 R-12). A provider whose
 * credential has faulted counts even where its catalogue rows are not marked, as a prebuilt cloud
 * voice's are not. With no catalogue yet, only a fault can say; an empty one is a list that did
 * not load, not one that dropped the voice.
 */
export function bookNarratorUnavailable(
  narrator: { provider: string; model?: string | undefined; voiceId: string } | undefined,
  catalogue: readonly Pick<VoiceCandidate, "provider" | "model" | "voiceId" | "attributes" | "unavailableReason" | "narratorCopy">[] | null,
  providers: readonly Pick<ProviderStatus, "id" | "fault" | "faultKind">[] = [],
): string | null {
  if (narrator === undefined) return null;
  const status = providers.find((entry) => entry.id === narrator.provider);
  if (status !== undefined && status.fault !== null && credentialFaulted(status)) return readerUnavailableWords(narrator.provider, status.fault);
  if (catalogue === null || catalogue.length === 0) return null;
  const model = narrator.model ?? legacyVoiceModel(narrator.provider, narrator.voiceId);
  const row = catalogue.find((voice) => voice.provider === narrator.provider && voice.model === model && voice.voiceId === narrator.voiceId && voice.narratorCopy !== true && supportsVoiceUse(voice, "narration"));
  if (row === undefined) return `${providerName(narrator.provider)} doesn't list this voice now`;
  return row.unavailableReason === undefined ? null : readerUnavailableWords(narrator.provider, row.unavailableReason);
}

/**
 * A reader's refusal as an author reads it: a refused payment is `Google needs payment`, anything
 * else as the reader said it, cut to `NARRATOR_UNAVAILABLE_MAX`. A vendor's raw error past the
 * door's limit once failed the whole door, not just the warning (codex on PR 1869).
 */
export function readerUnavailableWords(provider: string, reason: string): string {
  if (providerFaultCategory(reason) === "billing") return `${providerName(provider)} needs payment`;
  return reason.length <= NARRATOR_UNAVAILABLE_MAX ? reason : `${reason.slice(0, NARRATOR_UNAVAILABLE_MAX - 1).trimEnd()}…`;
}
