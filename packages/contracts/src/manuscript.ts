import { chapterParagraphs, countWords } from "./prose.js";

/**
 * A manuscript out and a manuscript in (design turn 131, SPEC-012 §2.4.3, R-49, R-50).
 *
 * Both directions meet in one small shape: a document is chapters, a chapter is blocks, a block
 * is a paragraph of runs or a scene break, and a run is words set plain, in italic or in bold.
 * That is the whole of what a novelist's Markdown says and the whole of what a Word file is
 * asked to carry — emphasis, strong, a break — so the writers and the reader agree by
 * construction rather than by a table of exceptions. Everything else in either format is text.
 */

/** Words set one way: plain, italic, bold, or both. */
export interface ManuscriptRun {
  text: string;
  italic?: true;
  bold?: true;
}

export type ManuscriptBlock = { kind: "paragraph"; runs: ManuscriptRun[] } | { kind: "break" };

export interface ManuscriptChapter {
  title: string;
  blocks: ManuscriptBlock[];
  words: number;
}

export interface ManuscriptDocument {
  /** The production's title, over the world's name. */
  title: string;
  subtitle: string;
  chapters: ManuscriptChapter[];
  /** Chapters with no prose, left out and counted (R-49). */
  leftOut: number;
  words: number;
}

/** What a `.docx` holds once read structured: each paragraph with its style and its runs. */
export interface StructuredParagraph {
  /** The paragraph style's id as the file spells it — `Heading1`, `Title`, `Heading_20_1` … */
  style?: string;
  runs: ManuscriptRun[];
  /** A page break in the paragraph: a scene break when the paragraph says nothing else. */
  pageBreak?: true;
}

export interface StructuredDocument {
  paragraphs: StructuredParagraph[];
  /** Footnote and endnote references the body carries: their text lives in parts the read leaves alone, so they are counted and said (R-50). */
  notes?: number;
}

/** The heading levels a document may start chapters at, as the sheet's segment names them. */
export type ChapterLevel = "title" | "subtitle" | "heading1" | "heading2";

/** A document past either is refused by the count (R-50). */
export const MANUSCRIPT_CAPS = { chapters: 200, characters: 1_000_000 } as const;

export type ManuscriptRead =
  | {
      ok: true;
      fileName: string;
      words: number;
      /** The style that started chapters, as the sheet names it (`Heading 1`), or null for a document with none. */
      headingLevel: string | null;
      /** Headings above the chapter level — the book's name, a part's — left out and counted. */
      leftOut: number;
      /** Every level the document uses, with its count and whether it is the one chapters were found at (codex on PR 916): the sheet's segment. */
      levels: Array<{ level: ChapterLevel; label: string; count: number; chosen: boolean }>;
      /** Footnote and endnote references, not carried and said so. */
      notes: number;
      chapters: Array<{ title: string; body: string; words: number }>;
    }
  | { ok: false; fileName: string; reason: string };

/** A line of three or more stars, spaced or not, is a scene break and nothing else is. */
const SCENE_BREAK = /^\s*(?:\*\s*){3,}$/;

/**
 * The manuscript a production would export (R-49): the chapters with prose in order, each
 * paragraph split into runs by the little Markdown a novelist types, and the rest counted.
 */
export function manuscriptDocument(input: {
  title: string;
  worldName: string;
  chapters: ReadonlyArray<{ title: string; body: string }>;
}): ManuscriptDocument {
  const chapters: ManuscriptChapter[] = [];
  let leftOut = 0;
  for (const chapter of input.chapters) {
    const words = countWords(chapter.body);
    if (words === 0) {
      leftOut += 1;
      continue;
    }
    chapters.push({ title: chapter.title, blocks: chapterBlocks(chapter.body), words });
  }
  return { title: input.title, subtitle: input.worldName, chapters, leftOut, words: chapters.reduce((sum, chapter) => sum + chapter.words, 0) };
}

/** A chapter's Markdown as blocks: paragraphs of runs, scene breaks where a line of stars is. */
export function chapterBlocks(body: string): ManuscriptBlock[] {
  return chapterParagraphs(body).map((paragraph) =>
    SCENE_BREAK.test(paragraph) ? { kind: "break" as const } : { kind: "paragraph" as const, runs: paragraphRuns(paragraph) },
  );
}

const WORDISH = /[\p{L}\p{N}]/u;

/**
 * One paragraph's runs. A line break inside a paragraph is the file's wrap, not the author's,
 * so it reads as a space. `**` and `__` are strong, `*` and `_` are emphasis; an underscore
 * inside a word (`snake_case`, `café_au`) is a letter, judged with Unicode letters and digits
 * so a French or Polish word is not split by an accent (codex on PR 903). A marker with no
 * closing partner is a character like any other; nothing nests.
 */
export function paragraphRuns(paragraph: string): ManuscriptRun[] {
  const text = paragraph.replace(/\s*\n\s*/g, " ");
  const runs: ManuscriptRun[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") runs.push({ text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    // A backslash before a star, an underscore or a backslash is the character itself (codex on
    // PR 916): an import writes them so, and a chapter that says "*required*" as words keeps them.
    if (text[i] === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    const span = emphasisAt(text, i);
    if (span === null) {
      plain += text[i];
      i += 1;
      continue;
    }
    flush();
    runs.push({ text: unescaped(span.text), ...(span.bold ? { bold: true as const } : { italic: true as const }) });
    i = span.end;
  }
  flush();
  return runs;
}

// Every mark Markdown could read in a Word file's own words (codex on PR 916): emphasis, code,
// a link's brackets, and at a line's start a heading, a quote or a list item.
const ESCAPABLE = /^[*_\\`[\]#>+\-.)]$/;
const unescaped = (text: string) => text.replace(/\\([*_\\`[\]#>+\-.)])/g, "$1");

function emphasisAt(text: string, at: number): { text: string; end: number; bold: boolean } | null {
  for (const marker of ["**", "__", "*", "_"]) {
    if (!text.startsWith(marker, at)) continue;
    const underscore = marker[0] === "_";
    const before = at === 0 ? "" : text[at - 1]!;
    // An underscore is a letter inside a word; a star is a marker wherever it stands.
    if (underscore && WORDISH.test(before)) continue;
    const open = at + marker.length;
    const first = text[open];
    if (first === undefined || /\s/.test(first) || first === marker[0]) continue;
    let close = text.indexOf(marker, open + 1);
    while (close !== -1) {
      const last = text[close - 1]!;
      const after = text[close + marker.length] ?? "";
      if (last !== "\\" && !/\s/.test(last) && !(underscore && WORDISH.test(after)) && !(marker.length === 1 && after === marker)) break;
      close = text.indexOf(marker, close + 1);
    }
    if (close === -1) continue;
    return { text: text.slice(open, close), end: close + marker.length, bold: marker.length === 2 };
  }
  return null;
}

/**
 * The marks the words hold, written so they stay words: a star, an underscore, a backslash, a
 * backtick or a bracket anywhere; a heading's `#`, a quote's `>`, a list's `-`, `+` or `1.` at
 * a line's start.
 */
const escaped = (text: string) =>
  text.replace(/([*_\\`[\]])/g, "\\$1").replace(/^(\s*)(#|>|[-+](?=\s)|\d+[.)](?=\s))/gm, "$1\\$2");

/** Runs back as the Markdown the chapter file keeps: `*` and `**`, the edges' spaces outside the marks. */
export function runsToMarkdown(runs: readonly ManuscriptRun[]): string {
  let out = "";
  for (const run of merged(runs)) {
    const lead = run.text.match(/^\s*/)?.[0] ?? "";
    const trail = run.text.match(/\s*$/)?.[0] ?? "";
    const core = escaped(run.text.trim());
    if (core === "" || (!run.italic && !run.bold)) {
      out += escaped(run.text);
      continue;
    }
    const mark = run.bold && run.italic ? "***" : run.bold ? "**" : "*";
    out += `${lead}${mark}${core}${mark}${trail}`;
  }
  return out;
}

/** Adjacent runs set the same way are one run: a Word file splits a sentence wherever the cursor paused. */
function merged(runs: readonly ManuscriptRun[]): ManuscriptRun[] {
  const out: ManuscriptRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last !== undefined && last.italic === run.italic && last.bold === run.bold) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

const CHAPTER_LEVELS: ReadonlyArray<{ id: ChapterLevel; label: string }> = [
  { id: "title", label: "Title" },
  // A subtitle stands under the book's name and above its chapters; it is never one.
  { id: "subtitle", label: "Subtitle" },
  { id: "heading1", label: "Heading 1" },
  { id: "heading2", label: "Heading 2" },
];

/** A style id as Word, Google Docs and LibreOffice each spell it, folded to one name. */
function styleKey(style: string | undefined): string {
  return (style ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const runsText = (runs: readonly ManuscriptRun[]) => runs.map((run) => run.text).join("");

/**
 * Chapters out of a structured document (R-50): the first heading level the document uses is
 * the chapter level and each such heading starts a chapter; a document with none is one
 * chapter titled by the file's name; what stands before the first heading is a chapter of its
 * own when it says anything. Runs come back as Markdown, a page break or a paragraph of stars
 * as a scene break, and everything else as text.
 */
export function manuscriptChapters(document: StructuredDocument, fileName: string, chosen?: ChapterLevel): ManuscriptRead {
  const stem = fileName.replace(/\.[^.]+$/, "").trim() || "Untitled";
  const uses = (id: string) => document.paragraphs.filter((paragraph) => styleKey(paragraph.style) === id).length;
  // The chapter level is the deepest level two or more paragraphs carry (codex on PR 916): one
  // Title over Heading 1 chapters names the book, and Heading 1 parts over Heading 2 chapters
  // name parts; neither is a chapter. When no level is used twice, the deepest heading there is
  // titles the one chapter. A manuscript whose scene heads repeat under its chapters breaks the
  // rule, so the sheet names every level used and the person may choose another.
  const deepest = (used: (id: string) => boolean) => [...CHAPTER_LEVELS].reverse().find((candidate) => used(candidate.id)) ?? null;
  const guessed = deepest((id) => uses(id) >= 2) ?? deepest((id) => uses(id) === 1);
  const level = chosen !== undefined && uses(chosen) > 0 ? CHAPTER_LEVELS.find((candidate) => candidate.id === chosen)! : guessed;
  const above: string[] = level === null ? [] : CHAPTER_LEVELS.slice(0, CHAPTER_LEVELS.indexOf(level)).map((candidate) => candidate.id);
  const chapters: Array<{ title: string; body: string; words: number }> = [];
  let title: string | null = null;
  // A heading above the chapter level — the book's name, a part's — opens no chapter of its own
  // unless prose follows it before the next chapter heading (codex on PR 916): an epigraph or a
  // part's opening is then a chapter titled by that heading, and a bare heading is left out.
  let fromAbove = false;
  let blocks: string[] = [];
  let leftOut = 0;
  const close = () => {
    const body = blocks.join("\n\n").replace(/^(\*\*\*\n\n)+/, "").replace(/(\n\n\*\*\*)+$/, "");
    const words = countWords(body);
    if (fromAbove && words === 0) leftOut += 1;
    // The preamble before the first heading is a chapter only when it says something.
    else if (title !== null || words > 0) chapters.push({ title: title ?? stem, body, words });
    blocks = [];
    fromAbove = false;
  };
  for (const paragraph of document.paragraphs) {
    if (above.includes(styleKey(paragraph.style))) {
      close();
      title = runsText(paragraph.runs).trim() || "Untitled";
      fromAbove = true;
      continue;
    }
    if (level !== null && styleKey(paragraph.style) === level.id) {
      close();
      title = runsText(paragraph.runs).trim() || "Untitled";
      continue;
    }
    // Judged on the words as the file holds them, before a star becomes an escaped star.
    const raw = runsText(paragraph.runs).trim();
    const isBreak = raw === "" ? paragraph.pageBreak === true : SCENE_BREAK.test(raw);
    const text = runsToMarkdown(paragraph.runs).trim();
    if (isBreak) {
      if (blocks.length > 0 && blocks[blocks.length - 1] !== "***") blocks.push("***");
      continue;
    }
    if (text === "") continue;
    blocks.push(text);
    if (paragraph.pageBreak) blocks.push("***");
  }
  close();
  const characters = chapters.reduce((sum, chapter) => sum + chapter.body.length, 0);
  const words = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
  if (words === 0) return { ok: false, fileName, reason: `${fileName} has no text in it to read.` };
  if (chapters.length > MANUSCRIPT_CAPS.chapters) {
    return { ok: false, fileName, reason: `${fileName} holds ${chapters.length} chapters, past the ${MANUSCRIPT_CAPS.chapters} an import takes.` };
  }
  if (characters > MANUSCRIPT_CAPS.characters) {
    return { ok: false, fileName, reason: `${fileName} is ${characters.toLocaleString()} characters, past the ${MANUSCRIPT_CAPS.characters.toLocaleString()} an import takes.` };
  }
  const levels = CHAPTER_LEVELS.filter((candidate) => uses(candidate.id) > 0).map((candidate) => ({
    level: candidate.id,
    label: candidate.label,
    count: uses(candidate.id),
    chosen: candidate.id === level?.id,
  }));
  return { ok: true, fileName, words, headingLevel: level?.label ?? null, leftOut, levels, notes: document.notes ?? 0, chapters };
}
