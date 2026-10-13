import type { AudiobookBlock, AudiobookBook } from "./audiobook.js";
import { audiobookNoteKey } from "./audiobook.js";
import { isPointCue, normalizeSpeechText, performanceNote, readingNotesLead, sentAs, type CadenceCue, type CadencePlan, type HeldControl } from "./cadence.js";
import type { ManifestModel } from "./manifest.js";

/** Single-performer v4 direction. Speaker boundaries are resolved in clean source coordinates,
 * before tags are inserted, so repeated dialogue and inline delivery do not move attribution.
 * The same function drives Sent as and the queued request (issue 1753).
 */
export function compileAudiobookPerformance(block: AudiobookBlock, book: Pick<AudiobookBook, "reading" | "notes"> | null,
  plan: CadencePlan | null, model: ManifestModel, reading?: { book?: string; chapter?: string }):
  { text: string; held: HeldControl[]; readingHeld: ReturnType<typeof readingNotesLead>["held"]; noteHeld: boolean } | null {
  if (model.provider !== "elevenlabs" || model.id !== "eleven_v4" || book?.reading !== "performed") return null;
  const whole = normalizeSpeechText(block.text);
  const rows = block.rows ?? [block];
  const context = readingNotesLead(reading ?? {}, model);
  const held: HeldControl[] = [];
  const parts: string[] = [];
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
    const mapped = sentAs(words, local, model);
    held.push(...mapped.held.map(control => control.cueIndex === undefined ? control : { ...control, cueIndex: cueIndices[control.cueIndex]! }));
    const identity = key === null || play?.mode !== "tag"
      ? "[same narrator, natural narration, original voice and accent]"
      : `[same narrator, preserve narrator timbre] ${play.tag}`;
    parts.push(`${identity} ${mapped.text}`);
    offset = to;
  }
  if (whole.slice(offset).trim() !== "") throw new Error("Character turns no longer match this paragraph; cast it again.");
  return { text: [...context.tags, ...parts].join(" "), held, readingHeld: context.held, noteHeld };
}
