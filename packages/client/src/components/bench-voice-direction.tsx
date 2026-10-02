import type { RefObject } from "react";
import {
  CADENCE_NOTE_MAX,
  benchVoiceDirection,
  bracketNote,
  directionSaysAnything,
  normalizeSpeechText,
  orderCues,
  recogniseDirection,
  sentAs,
  shiftCues,
  type BenchVoiceParams,
  type CadenceCue,
  type ManifestModel,
  type VoiceDirectionInput,
} from "@arke-studio/contracts";
import { DirectedText, MarkerMenu, SentAs, heldWords, rawToNormalised, viewPlan, type MarkerAt } from "./voice-direction.js";

/**
 * The Bench's Voice brief as the direction editor (design turn 181a–d): the words the line says,
 * its markers drawn as plates on those words, the note, and exactly what this reader will be
 * sent. The words hold no tag: a tag typed or pasted in any reader's spelling becomes its marker
 * as it is entered, and a bracket that is not one is named, to be made the note or kept as words.
 */

const EMPTY: VoiceDirectionInput = { speed: 1, cues: [] };

/** The line's direction as the composer edits it: the params', an old session's delivery, or none yet. */
export function benchDirectionOf(params: BenchVoiceParams): VoiceDirectionInput {
  return benchVoiceDirection(params) ?? EMPTY;
}

/** Params with this direction written, the old delivery field retired, and nothing written for nothing said. */
export function withBenchDirection(params: BenchVoiceParams, direction: VoiceDirectionInput): BenchVoiceParams {
  const { delivery: _legacy, direction: _was, ...rest } = params;
  return directionSaysAnything(direction) ? { ...rest, direction } : rest;
}

/**
 * The brief as edited, with its markers kept on their words (design turn 181c): a recognised tag
 * comes out of the words and in as its marker; every marker already placed follows the edit.
 */
export function editBenchBrief(before: string, after: string, direction: VoiceDirectionInput): { brief: string; direction: VoiceDirectionInput } {
  const read = recogniseDirection(after);
  const brief = read.cues.length > 0 ? read.raw : after;
  const shifted = shiftCues(normalizeSpeechText(before), direction.cues, normalizeSpeechText(brief)).cues;
  const cues = read.cues.length > 0 ? mergeCues(shifted, read.cues) : shifted;
  return { brief, direction: { ...direction, cues } };
}

/** The plan's own order rules decide what stands; what was already placed wins a clash. */
function mergeCues(kept: readonly CadenceCue[], added: readonly CadenceCue[]): CadenceCue[] {
  return orderCues([...kept, ...added]).slice(0, 40);
}

/** What one press sends this reader, or null where the plan does not fit the words. */
export function benchSent(brief: string, direction: VoiceDirectionInput, model: ManifestModel, language?: string): ReturnType<typeof sentAs> | null {
  if (normalizeSpeechText(brief) === "") return null;
  try {
    return sentAs(brief, viewPlan(direction), model, language, { oneRequest: true });
  } catch {
    return null;
  }
}

/** A Bench take's direction in a few words, as its row names it: `cold · note · 3 markers`. */
export function benchDirectionSummary(params: Pick<BenchVoiceParams, "delivery" | "direction">): string[] {
  const direction = benchVoiceDirection(params);
  if (direction === null) return [];
  return [
    ...(direction.delivery !== undefined ? [direction.delivery] : []),
    ...(direction.speed !== 1 ? [`${direction.speed.toFixed(1)}×`] : []),
    ...(direction.note !== undefined ? ["note"] : []),
    ...(direction.cues.length > 0 ? [`${direction.cues.length} ${direction.cues.length === 1 ? "marker" : "markers"}`] : []),
  ];
}

/** Where the marker menu opens from a selection in the brief's textarea, as the words are folded. */
export function benchMarkerAt(brief: string, start: number, end: number): MarkerAt {
  return { key: "brief", span: { from: rawToNormalised(brief, start), to: rawToNormalised(brief, end) } };
}

export function BenchVoiceDirection({
  brief,
  direction,
  model,
  language,
  marker,
  noteRef,
  kept,
  onMarker,
  onDirection,
  onBrief,
  onKeep,
}: {
  brief: string;
  direction: VoiceDirectionInput;
  model: ManifestModel | null;
  language?: string;
  marker: MarkerAt | null;
  noteRef: RefObject<HTMLInputElement | null>;
  /** Brackets the author chose to keep as words, which are not named again. */
  kept: ReadonlySet<string>;
  onMarker: (at: MarkerAt | null) => void;
  onDirection: (direction: VoiceDirectionInput) => void;
  /** The brief and direction written together, when making a bracket the note takes it out of the words. */
  onBrief: (brief: string, direction: VoiceDirectionInput) => void;
  onKeep: (bracket: string) => void;
}) {
  const text = normalizeSpeechText(brief);
  const sent = model === null ? null : benchSent(brief, direction, model, language);
  const heldCues = new Set((sent?.held ?? []).flatMap((control) => (control.cueIndex !== undefined ? [control.cueIndex] : [])));
  const unknown = recogniseDirection(brief).unknown.filter((bracket) => !kept.has(bracket.text));
  const note = direction.note ?? "";
  const makeNote = (bracket: { text: string }) => {
    const at = brief.indexOf(bracket.text);
    if (at < 0) return;
    const words = `${brief.slice(0, at)}${brief.slice(at + bracket.text.length)}`.replace(/ {2,}/g, " ");
    const cues = shiftCues(text, direction.cues, normalizeSpeechText(words)).cues;
    const said = bracketNote(bracket.text);
    const joined = (direction.note === undefined ? said : `${direction.note}; ${said}`).slice(0, CADENCE_NOTE_MAX);
    onBrief(words, { ...direction, cues, ...(joined !== "" ? { note: joined } : {}) });
  };
  return (
    <div className="fy-vd" data-testid="bench-voice-direction">
      {direction.cues.length > 0 && (
        <p className="fy-vd__words" data-testid="bench-directed-words">
          <DirectedText raw={brief} cues={direction.cues} held={heldCues} onPlate={(index) => onMarker({ key: "brief", span: { from: 0, to: 0 }, edit: index })} />
        </p>
      )}
      {marker !== null && (
        <div className="fy-vd__menu">
          <MarkerMenu
            text={text}
            base={direction}
            {...(language !== undefined ? { language } : {})}
            at={marker}
            model={model}
            oneRequest
            onClose={() => onMarker(null)}
            onApply={(cues) => {
              onMarker(null);
              onDirection({ ...direction, cues: cues ?? [] });
            }}
            onNote={() => {
              onMarker(null);
              noteRef.current?.focus();
            }}
          />
        </div>
      )}
      {unknown.map((bracket) => (
        <div key={`${bracket.from}:${bracket.text}`} className="fy-vd__unknown" data-testid="bench-unknown-bracket">
          <span className="fy-vd__unknown-words fy-mono">{bracket.text}</span>
          <span className="fy-vd__unknown-why fy-mono">not a marker · would be read aloud</span>
          <button type="button" className="fy-vd__unknown-act" onClick={() => makeNote(bracket)}>
            Make it the note
          </button>
          <button type="button" className="fy-vd__unknown-act" onClick={() => onKeep(bracket.text)}>
            Keep as words
          </button>
        </div>
      ))}
      <label className="fy-vd__note">
        <span className="fy-vd__note-k">Note</span>
        <input
          ref={noteRef}
          className="fy-vd__note-input"
          aria-label="Note"
          value={note}
          maxLength={CADENCE_NOTE_MAX}
          onChange={(event) => {
            const value = event.target.value;
            const { note: _was, ...rest } = direction;
            onDirection(value.trim() === "" ? rest : { ...rest, note: value.slice(0, CADENCE_NOTE_MAX) });
          }}
        />
        <span className="fy-vd__note-count fy-mono">{`${note.length} / ${CADENCE_NOTE_MAX}`}</span>
      </label>
      {sent !== null && model !== null && (directionSaysAnything(direction) || text !== "") && (
        <SentAs
          {...(sent.style !== undefined ? { style: sent.style } : {})}
          text={sent.text}
          held={heldWords(viewPlan(direction), sent.held)}
          reader={model.displayName}
        />
      )}
    </div>
  );
}
