import { DEFAULT_NARRATOR, legacyVoiceModel, narratorAppliesTo, narratorFor, supportsVoiceUse, voiceDisplayLabel, type AudiobookReader } from "@arke-studio/contracts";
import type { ReadingVoice } from "./store.js";

/**
 * Who narrates the chapter, by the coordinator's rule (`audiobookNarrator`) so the chapter and the
 * door name the same voice: the book's own reader when it can speak now, else the app's narrator
 * where it applies to this world, else the shipped voice. A book's reader resolves against the
 * world's voices only, never the app narrator's copy of another world's (SPEC-049 R-12).
 *
 * Until the catalogue answers, the choice is taken as stored. Judging it against no catalogue
 * named George over Ife's designed voice on every chapter surface — the Voices rail, the Timing
 * lanes, the block panel and the price — while the door, answered by the coordinator, said Ife.
 */
export function chapterNarrator(input: {
  bookNarrator?: AudiobookReader;
  stored: { provider: string; model?: string; voiceId: string; label?: string; worldId?: string } | null;
  worldId: string;
  catalogue: readonly ReadingVoice[] | null;
  names?: Parameters<typeof voiceDisplayLabel>[1];
}): AudiobookReader {
  const { bookNarrator, stored, worldId, catalogue, names } = input;
  const applies = stored !== null && narratorAppliesTo(stored, worldId) && supportsVoiceUse(stored, "narration") ? stored : null;
  const reader = (voice: { provider: string; model: string; voiceId: string; label?: string | undefined }): AudiobookReader =>
    ({ provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voiceDisplayLabel(voice, names) });
  if (catalogue === null) {
    if (bookNarrator !== undefined) return reader(bookNarrator);
    const model = applies === null ? null : (applies.model ?? legacyVoiceModel(applies.provider, applies.voiceId));
    return applies !== null && model !== null ? reader({ ...applies, model }) : reader(DEFAULT_NARRATOR);
  }
  const speakable = catalogue.filter((voice) => supportsVoiceUse(voice, "narration") && voice.unavailableReason === undefined);
  const own = bookNarrator === undefined ? null : narratorFor(bookNarrator, speakable.filter((voice) => voice.narratorCopy !== true));
  return reader(own !== null && !own.fallback ? own : narratorFor(applies, speakable));
}

