import { benchMentionFor, parseBenchToken, type ReferenceKind } from "@arke-studio/contracts";

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
 * What may sit immediately before the "@" for it to read as a citation.
 *
 * An address — write to me@image.example — is not an attempt to cite Image 1, and opening a
 * menu over one would be a menu the author has to dismiss to finish their sentence.
 */
const OPENERS = new Set([" ", "\n", "\t", "(", "[", "{", '"', "'", "—", "–", "/"]);

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

/** The query the caret sits inside, or null when the caret is not in one. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  if (caret <= 0 || caret > text.length) return null;
  const start = text.lastIndexOf("@", caret - 1);
  if (start < 0) return null;
  if (start > 0 && !OPENERS.has(text[start - 1] ?? "")) return null;
  const query = text.slice(start + 1, caret);
  if (query.length > MAX_QUERY || !QUERY.test(query)) return null;
  return { start, query };
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
 * Everything either side of the query is untouched — a completion is an edit to the characters
 * the author typed after the "@" and to nothing else. A single space follows, unless the words
 * already have one there, so writing simply carries on.
 */
export function insertMention(
  text: string,
  query: MentionQuery,
  token: string,
): { text: string; caret: number } {
  const end = query.start + 1 + query.query.length;
  const mention = benchMentionFor(token);
  const rest = text.slice(end);
  const gap = rest.startsWith(" ") || rest.startsWith("\n") ? "" : " ";
  return {
    text: `${text.slice(0, query.start)}${mention}${gap}${rest}`,
    caret: query.start + mention.length + gap.length,
  };
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
  for (const token of attached) {
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
