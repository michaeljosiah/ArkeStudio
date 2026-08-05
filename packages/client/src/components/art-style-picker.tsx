import { Textarea } from "./ui.js";
import { ART_STYLE_PRESETS, presetById, type ArtStylePreset } from "../lib/art-styles.js";

/**
 * The preset library as a control (design turn 38): nine defaults and a custom door, then the
 * words the preset seeded, editable.
 *
 * Two surfaces use it — the art-direction step of genesis and the proposal screen for a world
 * that already has a look — and the library is deliberately identical on both, so a look chosen
 * at genesis and one chosen a year later are the same nine choices and the same wording.
 *
 * The preset is not stored. Choosing one writes its description into the text; from that moment
 * the text is the record, and an edited preset is indistinguishable from a hand-written look.
 * That is the point: there is no preset state to drift out of step with words already rewritten.
 */

export function ArtStyleGrid({
  selectedId,
  onSelect,
}: {
  /** The preset last chosen, for the highlight only — the text is what is kept. */
  selectedId: string | null;
  onSelect: (preset: ArtStylePreset | null) => void;
}) {
  return (
    <div className="fy-styles">
      {ART_STYLE_PRESETS.map((preset) => (
        <button
          type="button"
          key={preset.id}
          aria-pressed={preset.id === selectedId}
          className={preset.id === selectedId ? "fy-styles__card is-selected" : "fy-styles__card"}
          onClick={() => onSelect(preset)}
        >
          <span className="fy-styles__name">{preset.name}</span>
          <span className="fy-styles__blurb">{preset.blurb}</span>
        </button>
      ))}
      {/* The custom door is a card like the rest, not a link under them: writing your own look is
          a choice of equal standing, and one of the nine is only a faster way to start typing. */}
      <button
        type="button"
        aria-pressed={selectedId === null}
        className={selectedId === null ? "fy-styles__card fy-styles__card--custom is-selected" : "fy-styles__card fy-styles__card--custom"}
        onClick={() => onSelect(null)}
      >
        <span className="fy-styles__name">Describe your own</span>
        <span className="fy-styles__blurb">Write the look in your own words.</span>
      </button>
    </div>
  );
}

export function ArtStyleWords({
  selectedId,
  value,
  onChange,
  label = "Words for this look",
}: {
  selectedId: string | null;
  value: string;
  onChange: (text: string) => void;
  label?: string;
}) {
  const preset = selectedId === null ? undefined : presetById(selectedId);
  const seeded = preset !== undefined && value.trim() === preset.description;
  return (
    <div className="fy-styles__words">
      <div className="fy-styles__wordshead">
        <span>{label}</span>
        <span className="fy-styles__seed">
          {preset === undefined
            ? "YOUR OWN WORDS"
            : seeded
              ? `SEEDED BY ${preset.name.toUpperCase()}`
              : `SEEDED BY ${preset.name.toUpperCase()} · EDITED`}
        </span>
      </div>
      <Textarea
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe the treatment — materials, light, palette, finish. Not the subject."
        style={{ minHeight: 96 }}
      />
      <div className="fy-styles__note">
        these are the words that ride along with every generation · a preset seeds the text, your
        edits win
      </div>
    </div>
  );
}
