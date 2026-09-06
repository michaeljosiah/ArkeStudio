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
      field: z.enum(["logline", "spine", "acts", "treatment", "voice", "samples"]),
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
  record: { lines: ReadonlyArray<{ speaker: string; sheet?: string; paragraph: number; occurrence: number; quote: string }> } | null,
): { blocks: VoicedBlock[]; ambiguous: number } {
  const paragraphs = chapterParagraphs(body);
  const blocks: VoicedBlock[] = [];
  let ambiguous = 0;
  const fold = (text: string) => text.replace(/\s+/g, " ").trim();
  for (const [index, paragraph] of paragraphs.entries()) {
    const spans: Array<{ start: number; end: number; speaker: string; sheet?: string }> = [];
    const here = (record?.lines ?? []).filter((line) => line.paragraph === index);
    for (const line of here) {
      // The paragraph must hold these words exactly as many times as the cast says it does
      // (codex on turn 130): with one of two identical lines deleted, the survivor is either
      // speaker's, and presence at an occurrence would put it in the wrong voice. So neither is
      // voiced, and both are counted.
      const twins = here.filter((other) => fold(other.quote) === fold(line.quote)).length;
      const hits = occurrencesOf(paragraph, line.quote);
      const hit = hits.length === twins ? hits[line.occurrence] : undefined;
      // Not there, not at that occurrence, or the same bytes already spoken for: narration.
      if (hit === undefined || spans.some((span) => hit.start < span.end && span.start < hit.end)) {
        ambiguous += 1;
        continue;
      }
      spans.push({ ...hit, speaker: line.speaker, ...(line.sheet !== undefined ? { sheet: line.sheet } : {}) });
    }
    spans.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const span of spans) {
      const before = paragraph.slice(cursor, span.start).trim();
      if (before !== "") blocks.push({ paragraph: index, text: before });
      blocks.push({ paragraph: index, text: paragraph.slice(span.start, span.end), speaker: span.speaker, ...(span.sheet !== undefined ? { sheet: span.sheet } : {}) });
      cursor = span.end;
    }
    const after = paragraph.slice(cursor).trim();
    if (after !== "") blocks.push({ paragraph: index, text: after });
  }
  return { blocks, ambiguous };
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
export function targetWords(targetLength: string | undefined): number | null {
  if (!targetLength) return null;
  const match = /(\d[\d,]*(?:\.\d+)?)\s*(k\b|words?\b)/i.exec(targetLength);
  if (!match) return null;
  const figure = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(figure) || figure <= 0) return null;
  const words = match[2]!.toLowerCase() === "k" ? figure * 1000 : figure;
  return words >= 100 ? Math.round(words) : null;
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
