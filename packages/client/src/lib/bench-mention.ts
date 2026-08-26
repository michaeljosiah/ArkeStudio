import {
  BENCH_MENTION_OPENERS,
  benchMentionFor,
  benchMentionsIn,
  parseBenchToken,
  type ReferenceKind,
} from "@arke-studio/contracts";

/**
 * The @ completion in a bench brief (issue 476), as plain functions.
 *
 * The bench gives every attached reference a stable name — "Image 1", "Video 1" — and the brief
 * could cite one only by knowing it and typing it correctly. This is the arithmetic behind the
 * menu that offers them instead: where a query starts, what it matches, and what the words look
 * like once a name is chosen. None of it touches React, because the two brief editors — the
 * composer's and the write-large window's — share it, and because a caret is the kind of thing
 * that is far easier to get right when it can be tested without a browser.
 */

/** One row of the menu: the name that will be inserted, and enough to tell it from its siblings. */
export interface MentionOption {
  /** The stable token — "Image 1". The mention is this with an at-sign in front. */
  token: string;
  kind: ReferenceKind;
  /** The source's own name: a filename, "Take 3", "Aurora · identity". */
  name: string;
  /** The picker's second line — format, length, where it came from. */
  meta: string;
  /** World-relative path to a thumbnail, where the source has one. */
  imagePath?: string;
}

/** An open query: the "@" it starts at, and the characters typed since. */
export interface MentionQuery {
  start: number;
  query: string;
}

/**
 * What the typed query may be made of: a word, optionally then one space and a second word.
 *
 * The space matters — "Image 1" has one in it, so a query that stopped at the first space could
 * never spell the very name it is completing. Two words is where it stops: past that the author
 * has moved on to writing prose, and a menu still open over it is in the way.
 */
const QUERY = /^[\p{L}\p{N}._-]*(?: [\p{L}\p{N}._-]*)?$/u;

/** Long enough for "Image 10" and a filename; short enough that ordinary prose closes the menu. */
const MAX_QUERY = 32;

/**
 * The query the caret sits inside, or null when the caret is not in one.
 *
 * The rule about what may precede the "@" is the contracts one, imported rather than restated:
 * a menu that opened where `BENCH_MENTION` sees no citation would offer a completion the gate
 * then refuses to recognise.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  if (caret <= 0 || caret > text.length) return null;
  const start = text.lastIndexOf("@", caret - 1);
  if (start < 0) return null;
  if (start > 0 && !BENCH_MENTION_OPENERS.has(text[start - 1] ?? "")) return null;
  const query = text.slice(start + 1, caret);
  if (query.length > MAX_QUERY || !QUERY.test(query)) return null;
  return { start, query };
}

/** A letter or a digit — the body of a query word. */
const ALNUM = /[\p{L}\p{N}]/u;
/** Joins two halves of one word, and only then: "harbour-night.png" is a name, "@im." is not. */
const JOINER = /[._-]/;

/**
 * Characters that close rather than follow, so a name completed in front of one gets no space.
 *
 * Completing "@im" in "a face lit by @im, cold" wrote "@Image 1 , cold" — a space before the
 * comma, in the author's own sentence, put there by a completion they only asked to name a
 * picture (raised on review). The same held for every full stop, colon and closing bracket.
 */
const CLOSERS = new Set([",", ".", ";", ":", "!", "?", ")", "]", "}", '"', "'", "…", "—", "–", "/"]);

/**
 * Where the citation being written ENDS, which is not always the caret.
 *
 * Put the caret back inside a name already written — "@Im|age 1" — and the characters after it
 * belong to the same citation. Replacing only as far as the caret left the tail behind, so
 * choosing a name there wrote "@Image 1 age 1" and corrupted the brief (raised on review).
 *
 * Two rules, in order. A whole citation already sitting at this "@" is replaced whole, asked of
 * `benchMentionsIn` so that what counts as one is the gate's answer and not a second opinion.
 * Otherwise the current word is finished — enough to complete a half-typed filename, and no
 * more. Deliberately not "as far as the query grammar still parses": that grammar carries one
 * space so a name like "Image 1" can be spelled, and following it rightwards through "@im and
 * then" would swallow the word after the citation along with it.
 */
export function mentionQueryEnd(text: string, query: MentionQuery): number {
  const caret = query.start + 1 + query.query.length;
  const whole = benchMentionsIn(text).find((m) => m.start === query.start);
  if (whole !== undefined && whole.end > caret) return whole.end;
  let end = caret;
  while (end < text.length) {
    const here = text[end] ?? "";
    if (ALNUM.test(here)) {
      end += 1;
      continue;
    }
    // A dot joins a filename to its extension and ends a sentence, and only the next character
    // says which. Taking it either way left "@im." completing to "@Image 1 ." — the full stop
    // pushed off the end of the sentence it belonged to.
    if (JOINER.test(here) && ALNUM.test(text[end + 1] ?? "")) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}

/**
 * The rows a query leaves, best first.
 *
 * Matching reads the token, the media kind and the source's own name and meta, so "@im" and
 * "@image" both find the pictures, "@audio" finds the sounds, and a filename finds the one file
 * the author actually means. Ranking puts the token first: "@im" means Image before it means
 * some file with "im" in the middle of its name.
 */
export function filterMentions(options: readonly MentionOption[], query: string): MentionOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];
  const matched = options.filter((option) => haystack(option).includes(needle));
  return matched.sort((a, b) => rank(a, needle) - rank(b, needle));
}

function haystack(option: MentionOption): string {
  return `${option.token} ${option.kind} ${option.name} ${option.meta}`.toLowerCase();
}

function rank(option: MentionOption, needle: string): number {
  const token = option.token.toLowerCase();
  if (token.startsWith(needle)) return 0;
  if (option.kind.startsWith(needle)) return 1;
  if (token.includes(needle)) return 2;
  if (option.name.toLowerCase().startsWith(needle)) return 3;
  return 4;
}

/**
 * The words with the query replaced by one canonical mention, and where the caret then sits.
 *
 * Everything either side of the citation is untouched — a completion is an edit to the citation
 * being written and to nothing else. It replaces the whole of it, not merely as far as the
 * caret, so a name re-entered halfway through is corrected rather than doubled. A single space
 * follows so writing carries on, but only where a space belongs: never before punctuation that
 * closes, and never where the words already have one.
 */
export function insertMention(
  text: string,
  query: MentionQuery,
  token: string,
): { text: string; caret: number } {
  const end = mentionQueryEnd(text, query);
  const mention = benchMentionFor(token);
  const rest = text.slice(end);
  const next = rest[0];
  const gap = next !== undefined && (/\s/.test(next) || CLOSERS.has(next)) ? "" : " ";
  return {
    text: `${text.slice(0, query.start)}${mention}${gap}${rest}`,
    caret: query.start + mention.length + gap.length,
  };
}

/**
 * The citations an answer lost, in the order the ask made them.
 *
 * The enhancer is told to keep every one verbatim; this is what happens when it did not. A
 * rewrite that dropped one, or flattened it into plain words, has changed what the brief means
 * — the reference it named will not be cited, and the composer must say so rather than applying
 * the words as though nothing had gone.
 */
export function droppedMentions(sent: string, answer: string): string[] {
  const kept = new Set(benchMentionsIn(answer).map((m) => m.token));
  const lost: string[] = [];
  for (const { token } of benchMentionsIn(sent)) {
    if (!kept.has(token) && !lost.includes(token)) lost.push(token);
  }
  return lost;
}

/** What a menu row needs, from the same picker rows the reference tiles are drawn from. */
interface MentionSource {
  existingToken?: string | undefined;
  name: string;
  meta: string;
  imagePath?: string | undefined;
}

/**
 * The menu's rows for the tokens currently attached, in lane order.
 *
 * The kind is read from the token rather than from the source, because the token is what the
 * session allocated and what dispatch resolves; a source row that has since gone missing still
 * gets offered under the right media kind rather than disappearing from the menu that names it.
 */
export function mentionOptions(
  attached: readonly string[],
  sources: readonly MentionSource[],
): MentionOption[] {
  const rows: MentionOption[] = [];
  // One row per name. A picture may ride the reference lane and the keyframe lane at once —
  // attaching checks only the lane it is going to — and offering it twice is two identical rows
  // under one React key, which reconciles the wrong one the moment either lane changes.
  const once = new Set<string>();
  for (const token of attached) {
    if (once.has(token)) continue;
    once.add(token);
    const parsed = parseBenchToken(token);
    if (parsed === null) continue;
    const source = sources.find((candidate) => candidate.existingToken === token);
    rows.push({
      token,
      kind: parsed.kind,
      name: source?.name ?? token,
      meta: source?.meta ?? "",
      ...(source?.imagePath !== undefined ? { imagePath: source.imagePath } : {}),
    });
  }
  return rows;
}
