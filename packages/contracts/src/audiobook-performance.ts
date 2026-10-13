import type { AudiobookBlock, AudiobookBook } from "./audiobook.js";
import { audiobookNoteKey } from "./audiobook.js";
import { isPointCue, markerSegments, normalizeSpeechText, performanceNote, readingNotesLead, sentAs, type CadenceCue, type CadencePlan, type HeldControl } from "./cadence.js";
import type { ManifestModel } from "./manifest.js";
import { speechInputFits, splitSpeechInput } from "./speech-input.js";

/** Structured performance retained until the actual request boundary is known. */
export interface PerformancePassage {
  lead: string;
  narration: string;
  runs: Array<{ identity: string; text: string; restore?: boolean; directed?: boolean }>;
}
export interface PerformanceState { lead: string; identity: string; directed: boolean }

/** One request starts afresh; consecutive paragraphs carry only changed identity. */
export function renderPerformancePassage(passage: PerformancePassage, previous?: PerformanceState): { text: string; state: PerformanceState } {
  const fresh = previous === undefined || previous.lead !== passage.lead;
  let identity = fresh ? passage.narration : previous.identity;
  let directed = !fresh && previous.directed;
  const words: string[] = fresh && passage.lead ? [passage.lead] : [];
  for (const run of passage.runs) {
    if (directed) words.push("[normal speaking voice]");
    if (run.identity !== identity || run.restore || directed) words.push(run.identity);
    words.push(run.text);
    identity = run.identity;
    directed = run.directed === true;
  }
  return { text: words.filter(Boolean).join(" "), state: { lead: passage.lead, identity, directed } };
}

/** Single-performer v4 direction. Speaker boundaries are resolved in clean source coordinates,
 * before tags are inserted, so repeated dialogue and inline delivery do not move attribution.
 * The same function drives Sent as and the queued request (issue 1753).
 */
export function compileAudiobookPerformance(block: AudiobookBlock, book: Pick<AudiobookBook, "reading" | "notes"> | null,
  plan: CadencePlan | null, model: ManifestModel, reading?: { book?: string; chapter?: string }):
  { text: string; parts: string[]; passages: PerformancePassage[]; held: HeldControl[]; readingHeld: ReturnType<typeof readingNotesLead>["held"]; noteHeld: boolean } | null {
  if (model.provider !== "elevenlabs" || model.id !== "eleven_v4" || book?.reading !== "performed") return null;
  const whole = normalizeSpeechText(block.text);
  const rows = block.rows ?? [block];
  const context = readingNotesLead(reading ?? {}, model);
  const held: HeldControl[] = [];
  const passages: PerformancePassage[] = [];
  // The book's narration brief is also the explicit return cue (including its accent).
  const narration = readingNotesLead({ book: reading?.book }, model).tags.join(" ") || "[natural narration, original voice and accent]";
  const lead = ["[same narrator throughout]", ...context.tags].join(" ");
  let passage: PerformancePassage = { lead, narration, runs: [] };
  const append = (run: PerformancePassage["runs"][number]) => {
    const next = { ...passage, runs: [...passage.runs, run] };
    if (speechInputFits(renderPerformancePassage(next).text, model.limits)) { passage = next; return; }
    if (passage.runs.length) passages.push(passage);
    passage = { lead, narration, runs: [run] };
  };
  let offset = 0;
  let noteHeld = false;
  for (const row of rows) {
    const words = normalizeSpeechText(row.text);
    const from = whole.indexOf(words, offset);
    if (!words || from < 0 || whole.slice(offset, from).trim() !== "") throw new Error("Character turns no longer match this paragraph; cast it again.");
    const to = from + words.length;
    const key = audiobookNoteKey(row);
    const note = key === null ? undefined : book.notes?.[key];
    const play = note === undefined ? null : performanceNote(note, model);
    noteHeld ||= play?.mode === "unsupported";
    if (play?.mode === "unsupported") held.push({ control: "note", reason: play.reason });
    const identity = key === null || play?.mode !== "tag"
      ? narration : play.tag;
    const render = (from: number, to: number): void => {
      const words = whole.slice(from, to);
      const cues: CadenceCue[] = [];
      const cueIndices: number[] = [];
      for (const cue of plan?.cues ?? []) {
        const before = cues.length;
        if (isPointCue(cue)) {
          // A pause at a speaker boundary belongs to the preceding words; breath to the next.
          const owns = cue.kind === "breath" ? cue.at >= from && (cue.at < to || to === whole.length && cue.at === to)
            : (cue.at > from || from === 0 && cue.at === 0) && cue.at <= to;
          if (owns) cues.push({ ...cue, at: cue.at - from });
        } else {
          const a = Math.max(from, cue.span.from), b = Math.min(to, cue.span.to);
          if (b > a) cues.push({ ...cue, span: { from: a - from, to: b - from, text: whole.slice(a, b) } });
        }
        if (cues.length > before) cueIndices.push(plan!.cues.indexOf(cue));
      }
      const hash = plan?.sourceTextHash ?? `sha256:${"0".repeat(64)}`;
      const local: CadencePlan = { schemaVersion: 1, sourceTextHash: hash, speed: plan?.speed ?? 1, cues,
        ...(plan?.delivery !== undefined ? { delivery: plan.delivery } : {}), ...(plan?.note !== undefined ? { note: plan.note } : {}) };
      const segments = markerSegments(words, local, model);
      for (const segment of segments) {
        const mapped = sentAs(segment.text, segment.plan, model);
        // A parts-only marker has no inline reset. Restate normal delivery and character
        // identity before each segment so a whisper cannot spill into the following words.
        const directed = mapped.sent.delivery !== undefined && mapped.sent.delivery !== "measured" || mapped.sent.note !== undefined || mapped.sent.cues.some(cue => cue.kind === "delivery");
        const run = { identity, directed, text: `${segments.length > 1 ? "[normal speaking voice] " : ""}${mapped.text}`, ...(segments.length > 1 ? { restore: true } : {}) };
        if (!speechInputFits(renderPerformancePassage({ lead, narration, runs: [run] }).text, model.limits)) {
          if (segment.text.length < 2) throw new Error("The speech direction leaves no room for words in this request.");
          for (const piece of splitSpeechInput(segment.text, { maxPromptChars: Math.floor(segment.text.length / 2) })) render(from + segment.from + piece.from, from + segment.from + piece.to);
          continue;
        }
        held.push(...mapped.held.map(control => {
          if (control.cueIndex === undefined) return control;
          const cue = segment.plan.cues[control.cueIndex]!;
          const index = cues.findIndex(original => original.kind === cue.kind && (isPointCue(original) && isPointCue(cue)
            ? original.at === segment.from + cue.at : !isPointCue(original) && !isPointCue(cue) && original.span.from === segment.from + cue.span.from));
          return { ...control, cueIndex: cueIndices[index]! };
        }));
        append(run);
      }
    };
    render(from, to);
    offset = to;
  }
  if (whole.slice(offset).trim() !== "") throw new Error("Character turns no longer match this paragraph; cast it again.");
  if (passage.runs.length) passages.push(passage);
  const parts = passages.map(part => renderPerformancePassage(part).text);
  return { text: parts.join(" "), parts, passages, held, readingHeld: context.held, noteHeld };
}
