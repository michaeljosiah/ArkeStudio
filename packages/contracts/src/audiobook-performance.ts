import type { AudiobookBlock, AudiobookBook } from "./audiobook.js";
import { audiobookNoteKey } from "./audiobook.js";
import { isPointCue, markerSegments, normalizeSpeechText, performanceNote, readingNotesLead, sentAs, type CadenceCue, type CadencePlan, type HeldControl } from "./cadence.js";
import { compileStyledPerformance } from "./audiobook-styled-performance.js";
import type { SpeechTurn } from "./grouped-reads.js";
import type { ManifestModel } from "./manifest.js";
import { speechInputFits, splitSpeechInput } from "./speech-input.js";

/** Legacy narrator-identity scaffolding is not audible direction. Keep the saved brief
 * untouched; remove only recognised scaffolding, never truncate or guess at other clauses. */
export function audiblePerformanceBrief(brief: string): string {
  const accents: string[] = [];
  const clauses = brief.split(/[,;]/).map(clause => clause.trim()).filter(clause => {
    const imitation = clause.match(/^(?:same |the )?(?:male |female )?narrator imitating (?:a|an) ([a-z -]+) (?:woman|man)$/i);
    if (imitation) { accents.push(`${imitation[1]} delivery`); return false; }
    return !/^(?:(?:the |same )?(?:male |female )?narrator(?: throughout)?|(?:retain|preserve)(?: the)? (?:male |female |narrator )?timbre)$/i.test(clause);
  });
  return [...new Set([...clauses, ...accents])].join(", ");
}

/** The character cue shown by the editor and used by the request compiler. V4's legacy
 * scaffolding cleanup must not make an editor promise words the request will discard. */
export function characterPerformanceDirection(note: string | undefined, model: ManifestModel) {
  if (note === undefined) return null;
  const audible = (model.provider === "elevenlabs" && model.id === "eleven_v4" || model.provider === "google") ? audiblePerformanceBrief(note) : note;
  return audible.trim() === "" ? null : { audible, ...performanceNote(audible, model) };
}

/** Only a short reporting clause between the same character's lines is transparent.
 * Action, ambiguous narration and explicit delivery still restore the narrator. */
function shortAttribution(text: string): boolean {
  return text.split(/\s+/).length <= 8 && /^[^.!?;:]+\b(?:said|says|asked|asks|replied|replies|answered|answers|added|adds)\b[^.!?;:]*[.!?]?$/.test(text);
}

/** Structured performance retained until the actual request boundary is known. */
export interface PerformancePassage {
  lead: string;
  narration: string;
  runs: Array<{ identity: string; text: string; directed?: boolean; attribution?: boolean }>;
}
export interface PerformanceState { narration: string; lead: string; identity: string; directed: boolean }

/** One request starts afresh; consecutive paragraphs carry only changed identity. */
export function renderPerformancePassage(passage: PerformancePassage, previous?: PerformanceState): { text: string; state: PerformanceState } {
  const fresh = previous === undefined || previous.lead !== passage.lead || previous.narration !== passage.narration;
  let identity = fresh ? passage.narration : previous.identity;
  let directed = !fresh && previous.directed;
  const words: string[] = fresh && passage.lead ? [passage.lead] : [];
  for (const run of passage.runs) {
    if (run.attribution && !directed && !run.directed && identity !== passage.narration) {
      words.push(run.text);
      continue;
    }
    // A changed identity already restores its baseline, including the narrator's accent.
    // Only the same character needs an explicit end to temporary delivery.
    if (directed && run.identity === identity && identity !== passage.narration) words.push("[normal speaking voice]");
    if (run.identity !== identity || directed) words.push(run.identity);
    words.push(run.text);
    identity = run.identity;
    directed = run.directed === true;
  }
  return { text: words.filter(Boolean).join(" "), state: { narration: passage.narration, lead: passage.lead, identity, directed } };
}

/** Quote punctuation is part of the spoken turn, never a separate style-only fragment. */
function quotedPerformancePlan(text: string, plan: CadencePlan | null): CadencePlan | null {
  if (plan === null) return null;
  const whole = normalizeSpeechText(text);
  return { ...plan, cues: plan.cues.map(cue => {
    if (cue.kind !== "delivery") return cue;
    let { from, to } = cue.span;
    if (from > 0 && /["“]/.test(whole[from - 1]!)) from--;
    to += /^[.,!?;:…]*["”]?/.exec(whole.slice(to))![0].length;
    return { ...cue, span: { from, to, text: whole.slice(from, to) } };
  }) };
}

/** Single-performer v4 direction. Speaker boundaries are resolved in clean source coordinates,
 * before tags are inserted, so repeated dialogue and inline delivery do not move attribution.
 * The same function drives Sent as and the queued request (issue 1753).
 */
export function compileAudiobookPerformance(block: AudiobookBlock, book: Pick<AudiobookBook, "reading" | "notes"> | null,
  plan: CadencePlan | null, model: ManifestModel, reading?: { book?: string; chapter?: string }):
  { text: string; parts: string[]; passages: PerformancePassage[]; styledParts?: SpeechTurn[][]; held: HeldControl[]; readingHeld: ReturnType<typeof readingNotesLead>["held"]; noteHeld: boolean } | null {
  plan = quotedPerformancePlan(block.text, plan);
  if (model.provider === "google" && model.cadence?.phrase === "best-effort-instruction" && book?.reading === "performed") return compileStyledPerformance(block, book, plan, model, reading);
  if (model.provider !== "elevenlabs" || model.id !== "eleven_v4" || book?.reading !== "performed") return null;
  const whole = normalizeSpeechText(block.text);
  const rows = block.rows ?? [block];
  const context = readingNotesLead(reading ?? {}, model);
  const held: HeldControl[] = [];
  const passages: PerformancePassage[] = [];
  // The book's narration brief is also the explicit return cue (including its accent).
  const narration = readingNotesLead({ book: reading?.book }, model).tags.join(" ") || "[natural narration, original voice and accent]";
  // A brief that simply names natural narration describes the selected voice's baseline.
  // Use it for returns from dialogue, not as an unnecessary opening instruction. Mood or
  // other authored book direction still leads each independent request.
  const baselineOnly = /^natural [a-z -]+ narration$/i.test(reading?.book?.trim() ?? "");
  const lead = (baselineOnly ? readingNotesLead({ chapter: reading?.chapter }, model).tags : context.tags).join(" ");
  let passage: PerformancePassage = { lead, narration, runs: [] };
  const append = (run: PerformancePassage["runs"][number]) => {
    const next = { ...passage, runs: [...passage.runs, run] };
    if (speechInputFits(renderPerformancePassage(next).text, model.limits)) { passage = next; return; }
    if (passage.runs.length) passages.push(passage);
    passage = { lead, narration, runs: [run] };
  };
  let offset = 0;
  let noteHeld = false;
  for (const [rowIndex, row] of rows.entries()) {
    const words = normalizeSpeechText(row.text);
    const from = whole.indexOf(words, offset);
    if (!words || from < 0 || whole.slice(offset, from).trim() !== "") throw new Error("Character turns no longer match this paragraph; cast it again.");
    const to = from + words.length;
    const key = audiobookNoteKey(row);
    const note = key === null ? undefined : book.notes?.[key];
    const play = characterPerformanceDirection(note, model);
    const previousKey = rowIndex > 0 ? audiobookNoteKey(rows[rowIndex - 1]!) : null;
    const nextKey = rowIndex + 1 < rows.length ? audiobookNoteKey(rows[rowIndex + 1]!) : null;
    const attribution = key === null && previousKey !== null && previousKey === nextKey && shortAttribution(words);
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
        // Keep segment boundaries structured: the renderer owns resets once the actual
        // request is grouped, so a local marker cannot add a second narrator reset.
        const directed = mapped.sent.delivery !== undefined && mapped.sent.delivery !== "measured" || mapped.sent.note !== undefined || mapped.sent.cues.some(cue => cue.kind === "delivery");
        // A marked attribution is narration throughout, including any unmarked prefix.
        const run = { identity, directed, attribution: attribution && segments.length === 1, text: mapped.text };
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
