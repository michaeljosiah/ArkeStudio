import { useEffect, useState } from "react";
import type { PictureSuggestion } from "@arke-studio/contracts";
import { makeAudiobookPicture, suggestAudiobookPicture, useAudiobookAsks } from "../lib/store.js";

/**
 * Suggest picture (design turn 191a, SPEC-047 R-99, R-100): in a block's Picture section, one
 * editable prompt Arke drafted from the block, the chapter and who is in it — each person a chip
 * over their reference, the look lines it used, the model, the ratio and the price. Nothing is
 * made until Generate, which is the price confirmed; Edit prompt takes the same prompt to the Bench.
 * The card itself is PictureCard (audiobook-picture-card.tsx, design turn 193c).
 */

export interface PictureSuggestionState {
  /** What the writing service has said of this block, or null before it is asked. */
  ask: ReturnType<typeof useAudiobookAsks>[string] | null;
  /** The prompt as the author has it: the draft until they change it. */
  prompt: string | null;
  setPrompt: (prompt: string) => void;
  /** Where the press to Generate stands: making, held with its reason, or on the block. */
  making: ReturnType<typeof useAudiobookAsks>[string] | null;
  suggest: () => void;
  generate: (suggestion: PictureSuggestion, prompt: string) => void;
  /** Put the card away: a suggestion not wanted, or one made and standing on its block. */
  dismiss: () => void;
}

export function usePictureSuggestion(worldId: string, productionId: string, chapterFile: string, blockKey: string): PictureSuggestionState {
  const asks = useAudiobookAsks();
  const [suggestId, setSuggestId] = useState<string | null>(null);
  const [makeId, setMakeId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => {
    setSuggestId(null);
    setMakeId(null);
    setPrompt(null);
  }, [blockKey, chapterFile]);
  const ask = suggestId === null ? null : (asks[suggestId] ?? null);
  const making = makeId === null ? null : (asks[makeId] ?? null);
  // A picture that has landed on its block is the block's now: the card has done its work.
  useEffect(() => {
    if (making?.state !== "made") return;
    setSuggestId(null);
    setMakeId(null);
    setPrompt(null);
  }, [making?.state]);
  return {
    ask,
    prompt,
    setPrompt,
    making,
    suggest: () => {
      setMakeId(null);
      setPrompt(null);
      setSuggestId(suggestAudiobookPicture(worldId, productionId, chapterFile, blockKey));
    },
    generate: (suggestion, words) => {
      // The shot goes with it, kept on the picture so the block's card still shows it once made (194g).
      setMakeId(makeAudiobookPicture(worldId, productionId, chapterFile, blockKey, { prompt: words, who: suggestion.who.map((who) => who.key), ...(suggestion.shot?.frame ? { frame: suggestion.shot.frame } : {}), ...(suggestion.shot !== undefined ? { shot: suggestion.shot } : {}), confirmedMicroUsd: suggestion.estimatedMicroUsd }));
    },
    dismiss: () => {
      setSuggestId(null);
      setMakeId(null);
      setPrompt(null);
    },
  };
}
