import type { ReactNode } from "react";
import { Textarea } from "./ui.js";
import { Check, Plus } from "./icons.js";
import { COMIC_STYLE_WORDS_MAX } from "@arke-studio/contracts";
import { chooseComicStyle, comicStylePicture, comicStylePreset, COMIC_STYLE_PRESETS, type ComicStyleDraft } from "../lib/comic-styles.js";

/**
 * A graphic novel's style as cards (design turn 248): World look, nine presets and Your own, each
 * shown as the same page drawn in it, then the words the card seeded. Used when the book is made
 * and in Pages' Style sheet, identically, so a style chosen at either is the same choice.
 */
export function ComicStylePicker({
  draft,
  onChange,
  worldPicture,
}: {
  draft: ComicStyleDraft;
  onChange: (draft: ComicStyleDraft) => void;
  /** The world's key art, for World look; null shows the card's empty frame. */
  worldPicture: string | null;
}) {
  const card = (choice: string, name: string, blurb: string, picture: ReactNode) => (
    <button
      type="button"
      key={choice}
      aria-pressed={draft.choice === choice}
      className={draft.choice === choice ? "fy-comic-style is-selected" : "fy-comic-style"}
      onClick={() => onChange(chooseComicStyle(choice))}
    >
      <span className="fy-comic-style__frame">
        {picture}
        <span className="fy-comic-style__tick" aria-hidden="true"><Check size={11} /></span>
      </span>
      <span className="fy-comic-style__name">{name}</span>
      <span className="fy-comic-style__blurb">{blurb}</span>
    </button>
  );
  const preset = comicStylePreset(draft.choice);
  const edited = preset !== undefined && draft.words.trim() !== preset.words;
  return (
    <div className="fy-comic-styles">
      <div className="fy-comic-styles__grid">
        {card("world", "World look", "The world’s art direction", worldPicture ? <img src={worldPicture} alt="" /> : null)}
        {COMIC_STYLE_PRESETS.map((entry) => card(entry.id, entry.name, entry.blurb, <img src={comicStylePicture(entry.id)} alt="" />))}
        {card("own", "Your own", "Describe it", <Plus size={18} />)}
      </div>
      {draft.choice !== "world" && (
        <div className="fy-comic-styles__words">
          <div className="fy-comic-styles__wordshead">
            <span>Words for this style</span>
            <span className="fy-comic-styles__seed">
              {preset === undefined ? "YOUR OWN WORDS" : `SEEDED BY ${preset.name.toUpperCase()}${edited ? " · EDITED" : ""}`}
            </span>
          </div>
          <Textarea
            aria-label="Words for this style"
            value={draft.words}
            maxLength={COMIC_STYLE_WORDS_MAX}
            onChange={(event) => onChange({ choice: draft.choice, words: event.target.value })}
            style={{ minHeight: 64 }}
          />
        </div>
      )}
    </div>
  );
}
