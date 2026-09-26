import { z } from "zod";
import { CanonIdSchema, ConversationIdSchema, MessageIdSchema, SceneIdSchema, ShotIdSchema, SlugSchema } from "./ids.js";

/**
 * Where a piece of readable prose lives (issue 857).
 *
 * An address, never the words. Read-aloud names what it wants and the coordinator reads the
 * authoritative record — the same rule the sheet and bible reads have always followed, for the
 * same reason: the screen's copy of a paragraph is a snapshot, and narrating a snapshot means
 * the voice and the page can disagree about what the world says.
 *
 * Each arm carries exactly the ids that address its own record. A shot needs the production and
 * scene it belongs to, because those ids are scoped to it; a canon entry and a conversation reply
 * do not, because they are the world's.
 */
export const ProseReadSourceSchema = z.discriminatedUnion("of", [
  /** A canon entry's statement — the Markdown body under its frontmatter. */
  z.object({ of: z.literal("canon"), canonId: CanonIdSchema }).strict(),
  /**
   * A shot's script — the description that says what happens.
   *
   * There is no scene-level arm beside it, because a scene's script is these: the workspace draws
   * the shots and nothing renders `script.blocks` as prose. A synopsis is one line under a title,
   * which is read faster than a press.
   */
  z
    .object({ of: z.literal("shot"), productionId: SlugSchema, sceneId: SceneIdSchema, shotId: ShotIdSchema })
    .strict(),
  /**
   * A chapter's prose, by the id its frontmatter carries (design turn 126, issue 874).
   *
   * The body is not in the bundle — a novel on every snapshot broadcast would be the bundle
   * turned into the book — so this is the one arm the coordinator resolves off disk rather than
   * off the bundle. `paragraph` names one paragraph of the saved body, counted from 0 across
   * blank-line breaks, and is what lets a page read of a chapter be one block per paragraph
   * (turn 126: "a paragraph at a time"). Absent, the whole chapter is one block.
   */
  z
    .object({
      of: z.literal("chapter"),
      productionId: SlugSchema,
      chapterId: SlugSchema,
      paragraph: z.number().int().min(0).optional(),
    })
    .strict(),
  /**
   * One block of a chapter's voiced read (design turn 130): the chapter's paragraphs split at
   * the cast lines, counted from 0 by `voicedBlocks` over the saved body and the record beside
   * it. An address, as the chapter arm is; the coordinator resolves it off disk and reads it in
   * the narrator's voice or the speaker's. Without `block`, the whole voiced page: a cast of four
   * hundred lines splits into more blocks than a frame carries, so the screen names the chapter
   * once and the coordinator expands it by the same rule (codex on turn 130).
   */
  z
    .object({
      of: z.literal("chapter-voiced"),
      productionId: SlugSchema,
      chapterId: SlugSchema,
      block: z.number().int().min(0).optional(),
    })
    .strict(),
  /**
   * The production overview: the pieces of `story.json` and the freeform treatment beside it.
   * `acts` is a list rather than a paragraph, so it is read whole or not at all. `voice` and
   * `samples` are the style record's two readable pieces (turn 128), kept beside the overview
   * because the Overview screen draws them there; point of view and tense are labels, not a listen.
   */
  z
    .object({
      of: z.literal("story"),
      productionId: SlugSchema,
      field: z.enum(["logline", "spine", "question", "ending", "acts", "treatment", "voice", "samples"]),
      /**
       * One sample, counted from zero, rather than all of them (codex on turn 128): six samples
       * at their bound outrun a narrator's prompt cap read as one, so each is its own block.
       */
      sample: z.number().int().min(0).optional(),
    })
    .strict(),
  /** The season record's two authored answers (SPEC-023 R-10). */
  z
    .object({ of: z.literal("season"), productionId: SlugSchema, field: z.enum(["question", "ending"]) })
    .strict(),
  /** The Series' engine, which a season screen shows read-only (SPEC-023 R-9). */
  z.object({ of: z.literal("series"), seriesId: SlugSchema }).strict(),
  /**
   * One reply in a conversation. Arke's replies are frequently long and are exactly what
   * somebody may want read back rather than read; the user's own turns are not offered, because
   * nobody needs their own sentence spoken to them.
   */
  z.object({ of: z.literal("reply"), conversationId: ConversationIdSchema, messageId: MessageIdSchema }).strict(),
]);
export type ProseReadSource = z.infer<typeof ProseReadSourceSchema>;

/**
 * A chapter's paragraphs (turn 126): blank-line breaks, trimmed, empties dropped.
 *
 * One rule for both ends of a page read. The screen declares its blocks from the text it holds
 * and the coordinator resolves `paragraph` against the saved file; if the two split differently
 * the position would name one paragraph and the voice read another.
 */
export function chapterParagraphs(body: string): string[] {
  return body
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/**
 * Where a quote occurs in a paragraph, with whitespace folded on both sides (turn 130): the
 * file wraps where the model would not, so a line is looked for as words, and the spans found
 * are the paragraph's own bytes. Every occurrence, in order, so a cast can name the n-th.
 */
export function occurrencesOf(paragraph: string, quote: string): Array<{ start: number; end: number }> {
  const fold = (source: string) => {
    const starts: number[] = [];
    const ends: number[] = [];
    let folded = "";
    for (let i = 0; i < source.length; i++) {
      const c = source[i]!;
      if (/\s/.test(c)) {
        if (folded.endsWith(" ")) {
          ends[ends.length - 1] = i + 1;
          continue;
        }
        folded += " ";
      } else {
        folded += c;
      }
      starts.push(i);
      ends.push(i + 1);
    }
    return { folded, starts, ends };
  };
  const haystack = fold(paragraph);
  const needle = fold(quote).folded.trim();
  if (needle === "") return [];
  const hits: Array<{ start: number; end: number }> = [];
  for (let at = haystack.folded.indexOf(needle); at >= 0; at = haystack.folded.indexOf(needle, at + needle.length)) {
    hits.push({ start: haystack.starts[at]!, end: haystack.ends[at + needle.length - 1]! });
  }
  return hits;
}

/** One block of a voiced read: a run of narration, or a cast line with its speaker. */
export interface VoicedBlock {
  paragraph: number;
  text: string;
  /** The line's speaker as the chapter names them, and the sheet when the cast has one; absent for narration. */
  speaker?: string;
  sheet?: string;
  /** The author set this line's speaker by hand (SPEC-012 R-62): a pin, not the derivation. */
  pinned?: true;
}

/**
 * A correction to the cast (design turn 155, SPEC-012 R-62..R-65): a span of the chapter — its
 * paragraph, its words and which occurrence of them there — given a speaker by the author, or
 * `narration` for words the derivation made a line that are not one.
 */
export interface VoicePin {
  paragraph: number;
  occurrence: number;
  quote: string;
  speaker?: string;
  sheet?: string;
  narration?: true;
}

type CastLine = { speaker: string; sheet?: string; paragraph: number; occurrence: number; quote: string };

/**
 * The cast's lines with the author's pins applied (SPEC-012 R-64): a pin stands only while its
 * words are still at its occurrence in its paragraph — otherwise it is lost and counted, never
 * re-placed by guess — and a derived line whose words overlap a standing pin's gives way to it.
 * A pin to narration removes what it overlaps and adds nothing. The one rule every reader of the
 * cast goes through: the voiced read, the audiobook's blocks, the Voices panel and the stamp.
 */
export function pinnedLines(
  lines: readonly CastLine[],
  pins: readonly VoicePin[] | undefined,
  body: string,
): { lines: Array<CastLine & { pinned?: true }>; lost: number; standing: number } {
  if (pins === undefined || pins.length === 0) return { lines: [...lines], lost: 0, standing: 0 };
  const paragraphs = chapterParagraphs(body);
  const spans: Array<{ pin: VoicePin; start: number; end: number }> = [];
  let lost = 0;
  for (const pin of pins) {
    const hit = occurrencesOf(paragraphs[pin.paragraph] ?? "", pin.quote)[pin.occurrence];
    if (hit === undefined) lost += 1;
    else spans.push({ pin, ...hit });
  }
  const overlaps = (paragraph: number, start: number, end: number) =>
    spans.some((span) => span.pin.paragraph === paragraph && start < span.end && span.start < end);
  const kept: Array<CastLine & { pinned?: true }> = lines.filter((line) => {
    const hit = occurrencesOf(paragraphs[line.paragraph] ?? "", line.quote)[line.occurrence];
    return hit === undefined || !overlaps(line.paragraph, hit.start, hit.end);
  });
  for (const { pin } of spans) {
    if (pin.narration === true || pin.speaker === undefined) continue;
    kept.push({ speaker: pin.speaker, ...(pin.sheet !== undefined ? { sheet: pin.sheet } : {}), paragraph: pin.paragraph, occurrence: pin.occurrence, quote: pin.quote, pinned: true });
  }
  return { lines: kept, lost, standing: spans.length };
}

/**
 * A chapter's paragraphs split at its cast lines (turn 130, SPEC-012 R-46): narration, a line,
 * narration, in order, each block addressed by its index. The same rule at both ends of a page
 * read — the screen declares the blocks from the text it holds, the coordinator resolves an
 * index against the saved body — so the two can never name different blocks. A line is a block
 * only when its paragraph still holds its quote at the occurrence the record names, exactly
 * there: a stale cast whose paragraph lost one of two identical lines reads the survivor as
 * narration rather than in the wrong voice, and `ambiguous` counts what fell back.
 */
export function voicedBlocks(
  body: string,
  record: { lines: ReadonlyArray<CastLine>; pins?: readonly VoicePin[] } | null,
): { blocks: VoicedBlock[]; ambiguous: number } {
  const paragraphs = chapterParagraphs(body);
  const blocks: VoicedBlock[] = [];
  let ambiguous = 0;
  const fold = (text: string) => text.replace(/\s+/g, " ").trim();
  const lines = record === null ? [] : pinnedLines(record.lines, record.pins, body).lines;
  // How often the whole chapter holds each quoted line, against how often the cast names it
  // (codex on PR 914): a line copied into another paragraph while the original stands is two
  // spans for one attribution, and neither is the one the cast meant.
  const held = new Map<string, number>();
  const named = new Map<string, number>();
  for (const line of lines) {
    const key = fold(line.quote);
    named.set(key, (named.get(key) ?? 0) + 1);
    if (!held.has(key)) held.set(key, paragraphs.reduce((sum, paragraph) => sum + occurrencesOf(paragraph, line.quote).length, 0));
  }
  for (const [index, paragraph] of paragraphs.entries()) {
    const spans: Array<{ start: number; end: number; speaker: string; sheet?: string; pinned?: true }> = [];
    const here = lines.filter((line) => line.paragraph === index);
    for (const line of here) {
      // The paragraph must hold these words exactly as many times as the cast says it does
      // (codex on turn 130), and so must the chapter: with one of two identical lines deleted,
      // the survivor is either speaker's, and presence at an occurrence would put it in the
      // wrong voice. So neither is voiced, and both are counted.
      const key = fold(line.quote);
      const twins = here.filter((other) => fold(other.quote) === key).length;
      const hits = occurrencesOf(paragraph, line.quote);
      // A pin names its occurrence itself (SPEC-012 R-64): the author said which of the twins
      // is the line, so the count that keeps a derived twin from guessing does not apply.
      const hit = line.pinned === true || (hits.length === twins && held.get(key) === named.get(key)) ? hits[line.occurrence] : undefined;
      // Not there, or not at that occurrence: narration.
      if (hit === undefined) {
        ambiguous += 1;
        continue;
      }
      spans.push({ ...hit, speaker: line.speaker, ...(line.sheet !== undefined ? { sheet: line.sheet } : {}), ...(line.pinned === true ? { pinned: true as const } : {}) });
    }
    // Two spans sharing bytes are neither speaker's (codex on PR 914): the extractor gave two
    // people words that overlap, and keeping whichever came first would voice the shared words
    // in an arbitrary voice. Both fall back, and both are counted.
    const overlapping = spans.filter((span) => spans.some((other) => other !== span && span.start < other.end && other.start < span.end));
    ambiguous += overlapping.length;
    const kept = spans.filter((span) => !overlapping.includes(span));
    kept.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const span of kept) {
      const before = paragraph.slice(cursor, span.start).trim();
      if (before !== "") blocks.push({ paragraph: index, text: before });
      blocks.push({
        paragraph: index,
        text: paragraph.slice(span.start, span.end),
        speaker: span.speaker,
        ...(span.sheet !== undefined ? { sheet: span.sheet } : {}),
        ...(span.pinned === true ? { pinned: true as const } : {}),
      });
      cursor = span.end;
    }
    const after = paragraph.slice(cursor).trim();
    if (after !== "") blocks.push({ paragraph: index, text: after });
  }
  return { blocks, ambiguous };
}

/**
 * What a pin names for a block, or for words selected inside one (SPEC-012 R-63): its paragraph,
 * the words, and which occurrence of them in the paragraph — found by walking the paragraph's
 * blocks in order, since a block is an exact slice of its paragraph. `from`/`to` are offsets in
 * the block's text; the whole block when absent. Null when the words cannot be placed.
 */
export function pinTarget(
  body: string,
  blocks: readonly Pick<VoicedBlock, "paragraph" | "text">[],
  index: number,
  selection?: { from: number; to: number },
): { paragraph: number; occurrence: number; quote: string } | null {
  const block = blocks[index];
  if (block === undefined || block.paragraph < 0) return null;
  const paragraph = chapterParagraphs(body)[block.paragraph];
  if (paragraph === undefined) return null;
  let cursor = 0;
  let start = -1;
  for (let at = 0; at <= index; at += 1) {
    const other = blocks[at]!;
    if (other.paragraph !== block.paragraph) continue;
    const found = paragraph.indexOf(other.text, cursor);
    if (found < 0) return null;
    if (at === index) start = found;
    cursor = found + other.text.length;
  }
  const from = selection?.from ?? 0;
  const to = selection?.to ?? block.text.length;
  const quote = block.text.slice(from, to);
  if (quote.trim() === "") return null;
  const occurrence = occurrencesOf(paragraph, quote).findIndex((hit) => hit.start === start + from);
  return occurrence < 0 ? null : { paragraph: block.paragraph, occurrence, quote };
}

/** The count every surface shows for a chapter: whitespace-separated words of the body. */
export function countWords(body: string): number {
  const trimmed = body.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The number of words a target names, or null when it names none (turn 126: "the band draws
 * only when it parses to a number of words"). `targetLength` is a free string the overview
 * holds — "80,000 words", "about 90k", "300 pages", "three acts" — and only a figure that says
 * it is words, or the `k` shorthand for thousands of them, draws the band: a bare number or a
 * page count would put a wrong bar under the title with the confidence of a fact (codex, PR 879).
 */
/** The author's local calendar day, shared by the coordinator and dashboard. */
export function storyProgressDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function targetWords(targetLength: string | undefined, chapterCount?: number): number | null {
  if (!targetLength) return null;
  let perChapter: number | null = null;
  for (const match of targetLength.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k\b|words?\b)/gi)) {
    const figure = Number(match[1]!.replace(/,/g, ""));
    const words = match[2]!.toLowerCase() === "k" ? figure * 1000 : figure;
    if (!Number.isFinite(words) || words < 100) continue;
    const before = targetLength.slice(0, match.index);
    const after = targetLength.slice(match.index + match[0].length);
    if (/\b(?:per\s+chapter|each\s+(?:of\s+(?:the\s+)?\d+\s+)?chapters?|chapters?\s*[,;:]?\s*each)\s*(?:(?:is|at|of|:)\s*)?(?:(?:about|approximately|~)\s*)?$/i.test(before) ||
        /^\s*(?:words?\s*)?(?:per\s+chapter\b|\/\s*chapter\b|a\s+chapter\b|each\b|in\s+each\s+chapter\b)/i.test(after)) {
      perChapter = words;
    } else {
      return Math.round(words);
    }
  }
  // A chapter-sized target is not the book's (issue 1002). An explicit planned count wins;
  // otherwise the caller supplies the active chapter count. An explicit total above wins both.
  const planned = /\b(\d+)\s+chapters?\b/i.exec(targetLength);
  const count = planned ? Number(planned[1]) : chapterCount;
  const total = perChapter === null || count === undefined ? 0 : perChapter * count;
  return Number.isFinite(total) && total >= 100 ? Math.round(total) : null;
}

/**
 * Whether the overview moved under a chapter (turn 127): the chapter has words and was drafted
 * against an overview version below the current one. Stamped by the coordinator on an accepted
 * draft; typing never restamps it, so a chapter with no stamp is never called stale.
 */
export function overviewMoved(
  chapter: { words?: number | undefined; draftedAgainst?: number | undefined },
  story: { version: number } | null | undefined,
): boolean {
  return (
    (chapter.words ?? 0) > 0 &&
    chapter.draftedAgainst !== undefined &&
    story !== null &&
    story !== undefined &&
    chapter.draftedAgainst < story.version
  );
}

/**
 * Paragraphs with the offsets they occupy in the body (turn 128): what anchors a passage to the
 * paragraph an ask named, and what marks the paragraph a changed span falls in. Splits as
 * `chapterParagraphs` does — blank lines — but keeps the positions it would drop.
 */
export function paragraphSpans(body: string): Array<{ text: string; start: number; end: number }> {
  const spans: Array<{ text: string; start: number; end: number }> = [];
  const breaks = /\r?\n[ \t]*\r?\n/g;
  let start = 0;
  for (let match = breaks.exec(body); ; match = breaks.exec(body)) {
    const end = match === null ? body.length : match.index;
    const text = body.slice(start, end).trim();
    if (text !== "") spans.push({ text, start, end });
    if (match === null) break;
    start = match.index + match[0].length;
  }
  return spans;
}

/** The one span two texts differ in, or null when they are the same text (turn 128). */
export interface ChangedSpan {
  /** The words the span held before. */
  before: string;
  /** The words that take their place. */
  after: string;
  /** Where the span starts, as a character offset into either text. */
  start: number;
}

/**
 * The passage a revision changed, drawn from the review's before and proposed rather than
 * carried twice (turn 128): the common head and tail are trimmed, each pulled back to a word
 * boundary so the span never begins or ends inside a word. One span whatever the edit did — a
 * draft that recast three paragraphs reads as one long span from the first change to the last,
 * which is what `passageOf` uses to tell a passage from a draft.
 */
export function changedSpan(before: string, after: string): ChangedSpan | null {
  if (before === after) return null;
  let head = 0;
  const limit = Math.min(before.length, after.length);
  while (head < limit && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // Back off to whitespace so a change inside a word shows the whole word on both sides.
  while (head > 0 && !/\s/.test(before[head - 1]!)) head--;
  while (tail > 0 && !/\s/.test(before[before.length - tail]!)) tail--;
  return {
    before: before.slice(head, before.length - tail),
    after: after.slice(head, after.length - tail),
    start: head,
  };
}

/** A passage revision in the order it reads: runs it leaves alone, and the edits between them. */
export type PassageSegment =
  | { kind: "same"; text: string }
  | { kind: "edit"; index: number; before: string; after: string };

/** Past this many token pairs the diff is not worth its table, and the passage is one edit. */
const PASSAGE_DIFF_CELLS = 4_000_000;

/**
 * A passage revision taken apart into edits a reviewer can keep or refuse one at a time, as a
 * tracked change is: words and the whitespace between them are diffed as tokens, and edits
 * separated only by whitespace are one edit, so "big red" → "small blue" is one choice rather
 * than two that leave "small red" on the table. Whitespace is kept exactly, so keeping every
 * edit gives `after` and keeping none gives `before`, character for character.
 */
export function passageDiff(before: string, after: string): PassageSegment[] {
  const a = before.match(/\s+|\S+/g) ?? [];
  const b = after.match(/\s+|\S+/g) ?? [];
  type Op = { kind: "same" | "del" | "ins"; text: string };
  const ops: Op[] = [];
  if (a.length * b.length > PASSAGE_DIFF_CELLS) {
    if (before !== "") ops.push({ kind: "del", text: before });
    if (after !== "") ops.push({ kind: "ins", text: after });
  } else {
    // Longest common subsequence from the ends, so the walk forward reads it off in order.
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ kind: "same", text: a[i]! });
        i++;
        j++;
      } else if (j < b.length && (i === a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
        ops.push({ kind: "ins", text: b[j]! });
        j++;
      } else {
        ops.push({ kind: "del", text: a[i]! });
        i++;
      }
    }
  }
  // Group: a run of changes is one edit, and so are two runs with only whitespace between them.
  const out: PassageSegment[] = [];
  let edit: { before: string; after: string } | null = null;
  let gap = "";
  const flushEdit = () => {
    if (edit === null) return;
    out.push({ kind: "edit", index: out.filter((s) => s.kind === "edit").length, before: edit.before, after: edit.after });
    edit = null;
  };
  const same = (text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === "same") last.text += text;
    else if (text !== "") out.push({ kind: "same", text });
  };
  for (const op of ops) {
    if (op.kind === "same") {
      if (edit !== null && /^\s+$/.test(op.text) && gap === "") gap = op.text;
      else if (edit !== null) {
        const held = gap;
        gap = "";
        flushEdit();
        same(held + op.text);
      } else same(op.text);
      continue;
    }
    if (edit === null) edit = { before: "", after: "" };
    else if (gap !== "") {
      // The whitespace between two runs belongs to both sides of the one edit they become.
      edit.before += gap;
      edit.after += gap;
      gap = "";
    }
    if (op.kind === "del") edit.before += op.text;
    else edit.after += op.text;
  }
  const held = gap;
  flushEdit();
  same(held);
  return out;
}

/** The passage with the edits kept taken from `after` and the rest left as `before` had them. */
export function composePassage(segments: readonly PassageSegment[], kept: ReadonlySet<number>): string {
  return segments.map((s) => (s.kind === "same" ? s.text : kept.has(s.index) ? s.after : s.before)).join("");
}

/**
 * Whether a staged draft is a passage — one span changed, the rest of the chapter untouched —
 * rather than a draft of the chapter (turn 128). A passage is shorter than the body it sits in
 * on both sides; a body drafted from nothing, or replaced whole, is a draft and is drawn as one.
 */
export function passageOf(before: string | null, after: string | null): ChangedSpan | null {
  if (before === null || after === null || before.trim() === "" || after.trim() === "") return null;
  const span = changedSpan(before, after);
  if (span === null) return null;
  const untouched = before.length - span.before.length;
  return untouched > 0 && span.before.length < before.length && span.after.length < after.length ? span : null;
}
