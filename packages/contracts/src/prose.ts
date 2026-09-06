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
