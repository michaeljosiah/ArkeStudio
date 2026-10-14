import type { AudiobookBlock, AudiobookBook } from "./audiobook.js";
import { audiobookNoteKey } from "./audiobook.js";
import { characterPerformanceDirection, type PerformancePassage } from "./audiobook-performance.js";
import { isPointCue, markerSegments, normalizeSpeechText, readingNotesLead, sentAs, type CadenceCue, type CadencePlan, type HeldControl } from "./cadence.js";
import type { SpeechTurn } from "./grouped-reads.js";
import type { ManifestModel } from "./manifest.js";
import { speechInputFits, splitSpeechInput } from "./speech-input.js";

/** Gemini's style belongs to a turn, not a paragraph. Keep the same reader and make
 * dialogue, narration and temporary delivery separate styled turns within a request.
 * The result is also used for solo/per-paragraph reads, so grouping cannot change meaning.
 * SPEC-049 performed style amendment, 2026-10-14. */
export function compileStyledPerformance(block: AudiobookBlock, book: Pick<AudiobookBook, "reading" | "notes">,
  plan: CadencePlan | null, model: ManifestModel, reading?: { book?: string; chapter?: string }) {
  const whole = normalizeSpeechText(block.text);
  const context = readingNotesLead(reading ?? {}, model);
  const narration = readingNotesLead({ book: reading?.book }, model).instructions ?? "Natural narration.";
  const baselineOnly = /^natural [a-z -]+ narration$/i.test(reading?.book?.trim() ?? "");
  const chapter = readingNotesLead({ chapter: reading?.chapter }, model).instructions;
  const held: HeldControl[] = [];
  const styledParts: SpeechTurn[][] = [];
  let open: SpeechTurn[] = [];
  let offset = 0;
  let noteHeld = false;
  const wordsOf = (turns: SpeechTurn[]) => turns.map(turn => turn.text).join("\n\n");
  const fits = (turns: SpeechTurn[]) => turns.length <= 400 && speechInputFits(wordsOf(turns), model.limits, turns.map(turn => turn.instructions ?? "").join(" "));
  const append = (turn: SpeechTurn) => {
    if (open.length && !fits([...open, turn])) { styledParts.push(open); open = []; }
    open.push(turn);
  };
  for (const row of block.rows ?? [block]) {
    const words = normalizeSpeechText(row.text);
    const from = whole.indexOf(words, offset);
    if (!words || from < 0 || whole.slice(offset, from).trim() !== "") throw new Error("Character turns no longer match this paragraph; cast it again.");
    const to = from + words.length;
    const key = audiobookNoteKey(row);
    const play = characterPerformanceDirection(key === null ? undefined : book.notes?.[key], model);
    if (play?.mode === "unsupported") { held.push({ control: "note", reason: play.reason }); noteHeld = true; }
    const character = key !== null && play?.mode === "instruction" ? play.audible : undefined;
    const identity = character === undefined ? narration : [baselineOnly ? undefined : reading?.book, character].filter(Boolean).join(". ");
    const render = (a: number, b: number): void => {
      const cues: CadenceCue[] = [];
      const indices: number[] = [];
      for (const [index, cue] of (plan?.cues ?? []).entries()) {
        if (isPointCue(cue)) {
          const owns = cue.kind === "breath" ? cue.at >= a && (cue.at < b || b === whole.length && cue.at === b)
            : (cue.at > a || a === 0 && cue.at === 0) && cue.at <= b;
          if (owns) { cues.push({ ...cue, at: cue.at - a }); indices.push(index); }
        } else {
          const start = Math.max(a, cue.span.from), end = Math.min(b, cue.span.to);
          if (end > start) { cues.push({ ...cue, span: { from: start - a, to: end - a, text: whole.slice(start, end) } }); indices.push(index); }
        }
      }
      const local: CadencePlan = { schemaVersion: 1, sourceTextHash: plan?.sourceTextHash ?? `sha256:${"0".repeat(64)}`, speed: plan?.speed ?? 1, cues,
        ...(plan?.delivery !== undefined ? { delivery: plan.delivery } : {}), ...(plan?.note !== undefined ? { note: plan.note } : {}) };
      for (const segment of markerSegments(whole.slice(a, b), local, model)) {
        const mapped = sentAs(segment.text, segment.plan, model);
        const instructions = [identity, chapter, mapped.style].filter((part): part is string => Boolean(part)).map((part, index, all) => index < all.length - 1 && !/[.!?]$/.test(part) ? `${part}.` : part).join(" ");
        const turn = { text: mapped.text, ...(instructions ? { instructions } : {}) };
        if (!fits([turn])) {
          if (segment.text.length < 2) throw new Error("The speech direction leaves no room for words in this request.");
          for (const piece of splitSpeechInput(segment.text, { maxPromptChars: Math.floor(segment.text.length / 2) })) render(a + segment.from + piece.from, a + segment.from + piece.to);
          continue;
        }
        held.push(...mapped.held.map(control => {
          if (control.cueIndex === undefined) return control;
          const cue = segment.plan.cues[control.cueIndex]!;
          const index = cues.findIndex(original => original.kind === cue.kind && (isPointCue(original) && isPointCue(cue)
            ? original.at === segment.from + cue.at : !isPointCue(original) && !isPointCue(cue) && original.span.from === segment.from + cue.span.from));
          return { ...control, cueIndex: indices[index]! };
        }));
        append(turn);
      }
    };
    render(from, to);
    offset = to;
  }
  if (whole.slice(offset).trim() !== "") throw new Error("Character turns no longer match this paragraph; cast it again.");
  if (open.length) styledParts.push(open);
  const parts = styledParts.map(wordsOf);
  return { text: parts.join("\n\n"), parts, styledParts, passages: [] as PerformancePassage[], held, readingHeld: context.held, noteHeld };
}
