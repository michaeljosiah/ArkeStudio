import { z } from "zod";
import { PICTURE_CROSSFADE_SEC } from "./audiobook-pictures.js";
import { AudiobookScopeSchema, type AudiobookScope, type ListeningChapter } from "./audiobook-listening.js";
import { SubtitleOutputModeSchema, type SubtitleOutputMode } from "./subtitles.js";
import type { AcousticWord } from "./audiobook-word-timing.js";
import type { AudiobookMotion } from "./audiobook-motion.js";

/**
 * The audiobook as a video (design turn 197, SPEC-047): what the player shows — the picture of
 * the moment, the words if wanted, the chapter's one mix — rendered to MP4 on this machine.
 *
 * Everything here is a plan, worked out from the listening plan the player plays (186) and read by
 * both homes: the coordinator renders it through ffmpeg, and the Export sheet's preview draws a
 * frame of it, so the preview and the file never disagree. Nothing here reads a file or a clock;
 * times are seconds from the start of a chapter.
 */

export const VIDEO_SHAPES = ["1920x1080", "1280x720", "1080x1920"] as const;
export type VideoShape = (typeof VIDEO_SHAPES)[number];
export type CaptionPosition = "bottom" | "middle";
export type CaptionSize = "s" | "m" | "l";

export interface AudiobookVideoOptions {
  scope?: AudiobookScope;
  /** One file a chapter (the default), or one for the book in parts of at most twelve hours. */
  files: "chapter" | "book";
  shape: VideoShape;
  /** Each picture moves 6% closer over its hold, toward its focus (on by default, the owner's answer). */
  slowPush: boolean;
  /** The Cut's own control: Sidecar, Burned in, Both or None. */
  subtitles: SubtitleOutputMode;
  captionPosition: CaptionPosition;
  captionSize: CaptionSize;
  /** Absent on older saved/export options: ordinary phrase captions. */
  captionStyle?: "phrases" | "word";
  titleCards: boolean;
}

// Annotated (TS7056): an inferred schema rides into the frames and events unions, whose
// declarations the engine's bundle has refused as too long to serialize.
export const AudiobookVideoOptionsSchema: z.ZodType<AudiobookVideoOptions, z.ZodTypeDef, unknown> = z
  .object({
    scope: AudiobookScopeSchema.optional(),
    files: z.enum(["chapter", "book"]),
    shape: z.enum(VIDEO_SHAPES),
    slowPush: z.boolean(),
    subtitles: SubtitleOutputModeSchema,
    captionPosition: z.enum(["bottom", "middle"]),
    captionSize: z.enum(["s", "m", "l"]),
    captionStyle: z.enum(["phrases", "word"]).optional(),
    titleCards: z.boolean(),
  })
  .strict();

/** Sidecar at 16:9, Both at vertical, where most viewers watch muted (rule 5). */
export function defaultVideoSubtitles(shape: VideoShape): SubtitleOutputMode {
  return shape === "1080x1920" ? "burn-in+sidecar" : "sidecar";
}

export const DEFAULT_VIDEO_OPTIONS: AudiobookVideoOptions = {
  files: "chapter",
  shape: "1920x1080",
  slowPush: true,
  subtitles: "sidecar",
  captionPosition: "bottom",
  captionSize: "m",
  titleCards: true,
};

export function shapeSize(shape: VideoShape): { width: number; height: number } {
  const [width, height] = shape.split("x").map(Number) as [number, number];
  return { width, height };
}

export const VIDEO_FPS = 30;
/** How much closer a picture comes over its hold. */
export const VIDEO_PUSH = 0.06;
export const VIDEO_CROSSFADE_SEC = PICTURE_CROSSFADE_SEC;
/** A book file is at most this long; a longer book splits into parts at chapter boundaries. */
export const BOOK_PART_CAP_SEC = 12 * 3600;
/** A book file opens on the cover for this long, with Read by in the caption's place. */
export const BOOK_OPENING_SEC = 5;
/** A title card holds while the title is read, and at least this long. */
export const TITLE_CARD_MIN_SEC = 3;
/** A visual piece shorter than this is folded into the one before: a flash is not a picture. */
const MIN_SEGMENT_SEC = 0.5;

/** S, M and L as a share of the frame's height (rule 5). */
export const CAPTION_SIZE_SHARE: Record<CaptionSize, number> = { s: 0.036, m: 0.044, l: 0.054 };
/**
 * The vertical frame's caption against the landscape's at the same height: 197b draws the 9:16
 * preview's words at the size it draws 16:9's at fifteen to eighteen, so a sentence still fits a
 * column a third as wide. The preview and the file use the same figure.
 */
const VERTICAL_CAPTION_SCALE = 15 / 18;

/** The burned-in caption's size in pixels on a frame of this shape. */
export function captionFontPx(shape: VideoShape, size: CaptionSize, frameHeight = shapeSize(shape).height): number {
  const share = CAPTION_SIZE_SHARE[size] * (shape === "1080x1920" ? VERTICAL_CAPTION_SCALE : 1);
  return Math.max(8, Math.round(frameHeight * share * 100) / 100);
}

/** The caption's bottom edge stands this far above the frame's foot (197b: `bottom: 9%`). */
export const CAPTION_BOTTOM_SHARE = 0.09;
/** The caption spans the frame less 8% each side (197b). */
export const CAPTION_WIDTH_SHARE = 0.84;
/** The scrim rises this far from the foot, from clear to 72% black (197b). */
export const SCRIM_HEIGHT_SHARE = 0.42;
export const SCRIM_OPACITY = 0.72;
/** A title card's words against the frame's height (197c: `--text-xl` on a 225-high frame). */
export const CARD_TITLE_SHARE = 20 / 225;
/** The book's opening caption (197c: `--text-sm` on a 225-high frame). */
export const OPENING_CAPTION_SHARE = 13 / 225;

/** About how wide a character of the caption face is at weight 600, in ems: enough to break lines. */
const CAPTION_EM = 0.55;

/** How many characters a burned-in line holds on this frame. */
export function captionLineChars(shape: VideoShape, size: CaptionSize): number {
  const { width } = shapeSize(shape);
  return Math.max(12, Math.floor((width * CAPTION_WIDTH_SHARE) / (captionFontPx(shape, size) * CAPTION_EM)));
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// Pictures on the chapter's clock.

export interface VideoSegment {
  /**
   * `card`: the chapter's title over its first picture blurred, else the cover; `cover`: the
   * book's cover blurred and dimmed, before the chapter's first picture; `picture`: a picture
   * held as the player holds it; `black`: nothing to show.
   */
  kind: "card" | "cover" | "picture" | "black";
  file: string | null;
  from: number;
  to: number;
  /** The block a picture is set on. */
  key?: string;
  focus?: { x: number; y: number };
  title?: string;
  motion?: AudiobookMotion;
  motionAt?: number;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Where the chapter's title block ends, when the chapter opens on it; 0 when it does not. */
export function titleBlockEnd(chapter: Pick<ListeningChapter, "blocks">): number {
  const first = chapter.blocks[0];
  return first !== undefined && first.key === "title" && first.at === 0 ? round(first.seconds) : 0;
}

/** How long a chapter's card holds: while its title is read, at least three seconds, never past the chapter. */
export function titleCardSeconds(chapter: Pick<ListeningChapter, "blocks" | "seconds">): number {
  return round(Math.min(chapter.seconds, Math.max(TITLE_CARD_MIN_SEC, titleBlockEnd(chapter))));
}

/**
 * What the video shows across a chapter (rules 4 and 6): each picture from its block until the
 * next, the cover blurred before the first (never the chapter before's last), and with title
 * cards on, a card over the opening while the title is read.
 */
export function videoSegments(chapter: Pick<ListeningChapter, "title" | "blocks" | "pictures" | "seconds">, cover: string | null, titleCards: boolean): VideoSegment[] {
  const end = round(chapter.seconds);
  if (!(end > 0)) return [];
  const pictures = [...chapter.pictures].filter((picture) => picture.at < end).sort((a, b) => a.at - b.at);
  const firstAt = pictures[0]?.at ?? end;
  let segments: VideoSegment[] = [];
  if (firstAt > 0) segments.push(cover !== null ? { kind: "cover", file: cover, from: 0, to: round(firstAt) } : { kind: "black", file: null, from: 0, to: round(firstAt) });
  pictures.forEach((picture, index) => {
    const to = round(pictures[index + 1]?.at ?? end);
    segments.push({ kind: "picture", file: picture.file, key: picture.key, from: round(picture.at), to, ...(picture.focus !== undefined ? { focus: picture.focus } : {}), ...(picture.motion !== undefined ? { motion: picture.motion, motionAt: picture.at } : {}) });
  });
  segments = segments.filter((segment) => segment.to > segment.from);
  if (titleCards) {
    const cardEnd = titleCardSeconds(chapter);
    const card: VideoSegment = { kind: "card", file: pictures[0]?.file ?? cover, from: 0, to: cardEnd, title: chapter.title };
    segments = [card, ...segments.filter((segment) => segment.to > cardEnd).map((segment) => ({ ...segment, from: Math.max(segment.from, cardEnd) }))];
  }
  // A piece too short to see is folded into the one before it, so no crossfade is shorter than a blink.
  const kept: VideoSegment[] = [];
  for (const segment of segments) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && segment.to - segment.from < MIN_SEGMENT_SEC) previous.to = segment.to;
    else kept.push({ ...segment });
  }
  if (kept.length > 1 && kept[0]!.to - kept[0]!.from < MIN_SEGMENT_SEC) {
    const [first, second] = kept as [VideoSegment, VideoSegment];
    second.from = first.from;
    kept.shift();
  }
  return kept;
}

/** The crossfade into each segment after the first: a second, or less when either side is short. */
export function segmentFades(segments: readonly VideoSegment[]): number[] {
  return segments.map((segment, index) => {
    if (index === 0) return 0;
    const before = segments[index - 1]!;
    return round(Math.min(VIDEO_CROSSFADE_SEC, (segment.to - segment.from) / 2, (before.to - before.from) / 2));
  });
}

/** The segment showing at a time on the chapter's clock: the preview's frame. */
export function segmentAt(segments: readonly VideoSegment[], at: number): VideoSegment | null {
  return segments.find((segment) => at >= segment.from && at < segment.to) ?? segments[segments.length - 1] ?? null;
}

/** Where a picture's crop stands on it, in the picture's own pixels, and where its focus falls inside the crop. */
export interface PictureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The focus inside the crop, as shares of the crop: the point Slow push moves toward. */
  focusX: number;
  focusY: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The picture filling the frame (turn 197's correction of 2026-10-04): scaled to cover the frame
 * and cropped around its focus, kept inside the picture, at 16:9 and at 9:16 alike. The rendered
 * pictures are 3:2 and a 16:9 frame letterboxed them behind black bars, which the owner refused;
 * a crop loses a strip top and bottom at 16:9 and the sides at 9:16, and the focus says which.
 * Whole pixels, so ffmpeg's crop and the preview's take the same rectangle.
 */
export function coverCrop(pictureWidth: number, pictureHeight: number, frameWidth: number, frameHeight: number, focus: { x: number; y: number } = { x: 0.5, y: 0.5 }): PictureCrop {
  const width = Math.max(1, Math.min(pictureWidth, Math.round((pictureHeight * frameWidth) / frameHeight)));
  const height = Math.max(1, Math.min(pictureHeight, Math.round((pictureWidth * frameHeight) / frameWidth)));
  const x = clamp(Math.round(pictureWidth * focus.x - width / 2), 0, pictureWidth - width);
  const y = clamp(Math.round(pictureHeight * focus.y - height / 2), 0, pictureHeight - height);
  const share = (value: number) => Math.round(clamp(value, 0, 1) * 10000) / 10000;
  return { x, y, width, height, focusX: share((pictureWidth * focus.x - x) / width), focusY: share((pictureHeight * focus.y - y) / height) };
}

/**
 * How far Slow push has come at a share of a picture's hold, as the window inside the crop it
 * shows: 6% closer by the end, about the focus's place in the crop, so the focus stays where it
 * stands and the window never leaves the crop — no edge of the picture is ever revealed. ffmpeg's
 * zoompan takes the same window; the preview draws it.
 */
export function pushWindow(crop: Pick<PictureCrop, "focusX" | "focusY">, progress: number): { left: number; top: number; size: number } {
  const zoom = 1 + VIDEO_PUSH * clamp(progress, 0, 1);
  const size = 1 / zoom;
  return { left: (1 - size) * crop.focusX, top: (1 - size) * crop.focusY, size };
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// The words.

export interface VideoCue {
  text: string;
  startSec: number;
  endSec: number;
  /** Only acoustic timings are carried. Interpolated phrase cues never gain this field. */
  words?: AcousticWord[];
}

/** Words broken into lines of at most `maxChars`; a word longer than a line stands on its own. */
export function wrapWords(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** A cue's line, at most: the subtitler's 42 at 16:9 (turn 197's correction of 2026-10-04). */
export const CUE_LINE_CHARS = 42;
/** A cue is on screen at least this long where its words allow, so it can be read… */
export const CUE_MIN_SEC = 1.2;
/** …and at most this long: a short sentence over a long pause clears rather than hangs. */
export const CUE_MAX_SEC = 6;

/**
 * Where a cue or a line may break, from best to worst. Captions read in phrases: a break at a
 * sentence's end, at a quote or a dialogue tag, at a clause mark, before a conjunction or a
 * preposition — never inside a word, and never straight after an article, a preposition or a
 * possessive, which leaves a line hanging on "the" or "of an".
 */
const BREAK_COST = { sentence: 0, quote: 0.5, clause: 1, conjunction: 2.5, preposition: 3.5, plain: 8, dangling: 20, never: 60 } as const;
type BreakKind = keyof typeof BREAK_COST;

const CONJUNCTIONS = new Set(["and", "but", "or", "nor", "so", "yet", "because", "while", "when", "whenever", "where", "which", "who", "whom", "whose", "that", "though", "although", "until", "unless", "if", "as", "since", "than", "then"]);
const PREPOSITIONS = new Set(["in", "on", "at", "by", "with", "from", "into", "onto", "over", "under", "through", "between", "behind", "beside", "near", "after", "before", "toward", "towards", "without", "within", "across", "along", "around", "past", "against", "among", "about", "above", "below", "beneath", "beyond", "during", "inside", "outside", "like", "for", "to", "upon", "per", "via"]);
/** Words a line never ends on: what follows them is what they are for. */
const HOLDS_THE_NEXT = new Set(["a", "an", "the", "my", "your", "his", "its", "our", "their", "of", "to", "for", "with", "from", "into", "onto", "upon", "mr.", "mrs.", "ms.", "dr.", "mr", "mrs", "ms", "dr"]);
/**
 * Words a line seldom ends on — but each also ends a phrase (`he came in`, `told her`), so they
 * cost a great deal rather than being refused, and a conjunction after one can still win.
 */
const LEANS_ON_THE_NEXT = new Set(["in", "on", "at", "by", "through", "between", "under", "among", "toward", "towards", "without", "within", "across", "against", "during", "beneath", "beside", "behind", "about", "over", "after", "before", "like", "and", "or", "but", "nor", "every", "each", "her", "this", "that", "these", "those", "such", "another", "some", "any", "one", "two", "three", "few", "several", "many", "very", "too", "most"]);
const ENDS_SENTENCE = /[.!?…]["”’')\]]*$/;
const ENDS_CLAUSE = /([,;:]|[—–]|--)["”’')\]]*$/;
/** A closing quote: `"` or `”` after a word or its mark; `'` and `’` only after a mark, since `boys'` is a word. */
const CLOSES_QUOTE = /([\p{L}\p{N},.!?…—–]["”]|[,.!?…—–]['’])$/u;
const OPENS_QUOTE = /^(["“‘—–]|'\p{L})/u;
const bare = (word: string) => word.toLowerCase().replace(/^["“‘'([—–]+|["”’'),;:\]]+$/g, "");

/** How good a break between two words is. `textEnd`: the left word ends one of Text's sentences. */
function breakKind(left: string, right: string, textEnd: boolean): BreakKind {
  // A dash or a quote mark standing alone belongs to the word before it.
  if (!/[\p{L}\p{N}]/u.test(right)) return "never";
  const clause = ENDS_CLAUSE.test(left) || ENDS_SENTENCE.test(left);
  if (HOLDS_THE_NEXT.has(bare(left)) && !clause) return "never";
  // Text's own sentence ends are breaks whatever their punctuation: a title has none.
  if (textEnd || ENDS_SENTENCE.test(left)) return "sentence";
  if (CLOSES_QUOTE.test(left) || OPENS_QUOTE.test(right)) return "quote";
  if (ENDS_CLAUSE.test(left)) return "clause";
  if (CONJUNCTIONS.has(bare(right))) return "conjunction";
  if (LEANS_ON_THE_NEXT.has(bare(left))) return "dangling";
  if (PREPOSITIONS.has(bare(right))) return "preposition";
  return "plain";
}

interface TimedWord {
  text: string;
  from: number;
  to: number;
  /** How good a break after this word is; the last word of a block needs none. */
  after: BreakKind;
  /** A quotation is open after this word: a cue cut here starts its next one mid-quote. */
  quoted: boolean;
  acoustic?: AcousticWord;
}

/** Verified acoustic words when present; phrase-only captions retain the existing sentence estimate. */
function timedWords(block: ListeningChapter["blocks"][number]): TimedWord[] {
  const end = block.at + block.seconds;
  const words: TimedWord[] = [];
  const textEnds = new Set<number>();
  if (block.words !== undefined) {
    for (const word of block.words) words.push({ text: word.text, from: word.startSec, to: word.endSec, after: "sentence", quoted: false, acoustic: word });
    words.forEach((word, i) => { if (ENDS_SENTENCE.test(word.text)) textEnds.add(i); });
  }
  if (block.words === undefined) {
  block.sentences.forEach((sentence, index) => {
    const from = Math.max(block.at, sentence.at);
    const to = Math.min(end, block.sentences[index + 1]?.at ?? end);
    const text = sentence.text.replace(/\s+/g, " ").trim();
    if (!(to > from) || text === "") return;
    const parts = text.split(" ");
    let clock = 0;
    parts.forEach((part, at) => {
      const weight = part.length + (at < parts.length - 1 ? 1 : 0);
      words.push({ text: part, from: from + ((to - from) * clock) / text.length, to: from + ((to - from) * (clock + weight)) / text.length, after: "sentence", quoted: false });
      clock += weight;
    });
    textEnds.add(words.length - 1);
  });
  }
  for (let at = 0; at < words.length - 1; at++) words[at]!.after = breakKind(words[at]!.text, words[at + 1]!.text, textEnds.has(at));
  // Straight quotes open and close by turns; a block is its own paragraph, so it starts closed.
  let open = false;
  for (const word of words) {
    for (const mark of word.text) {
      if (mark === "“") open = true;
      else if (mark === "”") open = false;
      else if (mark === '"') open = !open;
    }
    word.quoted = open;
  }
  return words;
}

const lineLength = (words: readonly TimedWord[], from: number, to: number) => words.slice(from, to).reduce((sum, word, at) => sum + word.text.length + (at > 0 ? 1 : 0), 0);

/** The best place to break words `from..to` into two lines, or none needed; null when they cannot fit two. */
function bestLines(words: readonly TimedWord[], from: number, to: number, lineChars: number): { at: number | null; cost: number } | null {
  const whole = lineLength(words, from, to);
  if (whole <= lineChars || to - from === 1) return { at: null, cost: 0 };
  let best: { at: number; cost: number } | null = null;
  for (let at = from + 1; at < to; at++) {
    const top = lineLength(words, from, at);
    const foot = lineLength(words, at, to);
    if ((top > lineChars && at - from > 1) || (foot > lineChars && to - at > 1)) continue;
    const cost = BREAK_COST[words[at - 1]!.after] / 2 + (6 * Math.abs(top - foot)) / lineChars;
    if (best === null || cost < best.cost) best = { at, cost };
  }
  return best;
}

/**
 * A block's words cut into cues (turn 197's correction of 2026-10-04): each at most two lines of
 * `lineChars`, cut where a phrase ends, timed by the words' share of their sentence's time, so
 * the player's Text and the video still agree. The cut is the cheapest over the whole block —
 * each cue costs a little, a poor break more, a cue on screen under 1.2 s or (mid-sentence) over
 * 6 s a great deal — so a short sentence joins its neighbour rather than flash, and a long one is
 * cut at its clauses. A cue ends mid-sentence only where the next one starts on the same instant.
 */
function blockCues(words: readonly TimedWord[], lineChars: number): VideoCue[] {
  const n = words.length;
  if (n === 0) return [];
  const best: Array<{ cost: number; from: number; lines: number | null } | null> = Array.from({ length: n + 1 }, () => null);
  best[0] = { cost: 0, from: 0, lines: null };
  for (let to = 1; to <= n; to++) {
    for (let from = to - 1; from >= 0; from--) {
      const length = lineLength(words, from, to);
      if (length > lineChars * 2 && to - from > 1) break;
      const before = best[from];
      if (before === null || before === undefined) continue;
      const lines = bestLines(words, from, to, lineChars);
      if (lines === null) continue;
      const seconds = words[to - 1]!.to - words[from]!.from;
      const endsSentence = to === n || words[to - 1]!.after === "sentence";
      // A cue's own break weighs more than a line's: a line break is read in one glance.
      let cost = before.cost + 3 + lines.cost + (to === n ? 0 : 1.5 * BREAK_COST[words[to - 1]!.after] + (words[to - 1]!.quoted ? 1.5 : 0));
      // Two sentences share a cue only to save a flash — more readily inside one speaker's quote,
      // and each on its own line: a sentence that ends mid-line reads as run on.
      for (let at = from; at < to - 1; at++) if (words[at]!.after === "sentence") cost += (words[at]!.quoted ? 1.5 : 3) + (lines.at === at + 1 ? 0 : 5);
      if (seconds < CUE_MIN_SEC) cost += 15 + 20 * (CUE_MIN_SEC - seconds);
      if (seconds > CUE_MAX_SEC) cost += endsSentence ? 1.5 * (seconds - CUE_MAX_SEC) : 10 + 5 * (seconds - CUE_MAX_SEC);
      if (length < 12 && to - from < n) cost += 2;
      if (best[to] === null || cost < best[to]!.cost) best[to] = { cost, from, lines: lines.at };
    }
  }
  const cuts: Array<{ from: number; to: number; lines: number | null }> = [];
  for (let to = n; to > 0; ) {
    const step = best[to]!;
    cuts.unshift({ from: step.from, to, lines: step.lines });
    to = step.from;
  }
  const join = (from: number, to: number) => words.slice(from, to).map((word) => word.text).join(" ");
  return cuts.map((cut, index) => {
    const start = words[cut.from]!.from;
    let end = words[cut.to - 1]!.to;
    // A short sentence over a long pause clears after six seconds rather than hang; only a cue
    // that ends a sentence, so no cue ends mid-sentence before the next begins.
    const endsSentence = cut.to === n || words[cut.to - 1]!.after === "sentence";
    if (endsSentence && end - start > CUE_MAX_SEC && words[cut.from]!.acoustic === undefined) end = start + CUE_MAX_SEC;
    // A flash too short to read borrows the silence after it, where there is any.
    const next = cuts[index + 1];
    const room = next === undefined ? end : words[next.from]!.from;
    if (end - start < CUE_MIN_SEC && room > end) end = Math.min(room, start + CUE_MIN_SEC);
    const text = cut.lines === null ? join(cut.from, cut.to) : `${join(cut.from, cut.lines)}\n${join(cut.lines, cut.to)}`;
    const acoustic = words.slice(cut.from, cut.to).flatMap((word) => word.acoustic !== undefined ? [word.acoustic] : []);
    return { text, startSec: round(start), endSec: round(end), ...(acoustic.length === cut.to - cut.from ? { words: acoustic } : {}) };
  });
}

/**
 * The chapter's words as cues, timed exactly as the player's Text times them (rule 5): each
 * sentence from its place in its block until the next sentence, the block's last until the block
 * ends — the takes keep no word times, so a grouped take's sentences share it by length — and cut
 * into cues of at most two lines of `lineChars` at the phrases (`blockCues`). The sidecar and the
 * burned-in words cut alike; only the line's length differs with the frame.
 */
export function chapterCues(chapter: Pick<ListeningChapter, "blocks">, lineChars = CUE_LINE_CHARS): VideoCue[] {
  const cues = chapter.blocks.flatMap((block) => blockCues(timedWords(block), lineChars));
  // A block that is one short line ("Nothing.") still flashes: it borrows what it lacks from the
  // cue beside it, where that one can spare it and still be read, moving their shared edge.
  // Only a shared edge moves, so no gap opens inside a sentence.
  cues.forEach((cue, index) => {
    if (cue.words !== undefined) return;
    const lack = CUE_MIN_SEC - (cue.endSec - cue.startSec);
    if (!(lack > 0.001)) return;
    const next = cues[index + 1];
    const before = cues[index - 1];
    if (next !== undefined && next.words === undefined && next.startSec === cue.endSec && next.endSec - next.startSec - lack >= CUE_MIN_SEC) {
      cue.endSec = next.startSec = round(cue.endSec + lack);
    } else if (before !== undefined && before.words === undefined && before.endSec === cue.startSec && before.endSec - before.startSec - lack >= CUE_MIN_SEC) {
      cue.startSec = before.endSec = round(cue.startSec - lack);
    }
  });
  return cues;
}

/** A burned-in line, at most: 42, or less where the frame at this size holds less (the vertical frame), so a cue stays two lines. */
export function burnedLineChars(shape: VideoShape, size: CaptionSize): number {
  return Math.min(CUE_LINE_CHARS, captionLineChars(shape, size));
}

/**
 * The burned-in words (rule 5): the words being read, at most two lines a cue at the frame's
 * width and the chosen size; none over a title card, which is the title being read.
 */
export function burnedCues(chapter: Pick<ListeningChapter, "blocks">, shape: VideoShape, size: CaptionSize, after = 0): VideoCue[] {
  return chapterCues(chapter, burnedLineChars(shape, size))
    .filter((cue) => cue.endSec > after)
    .map((cue) => ({ ...cue, startSec: Math.max(cue.startSec, after) }))
    .filter((cue) => cue.endSec - cue.startSec > 0.05);
}

/** The cue showing at a time: the preview's caption. */
export function cueAt(cues: readonly VideoCue[], at: number): VideoCue | null {
  return cues.find((cue) => at >= cue.startSec && at < cue.endSec) ?? null;
}

/** The one measured word sounding now; a pause has no highlight, and earlier words return to white. */
export function captionWordParts(cue: VideoCue, at: number): Array<{ text: string; active: boolean }> {
  const active = cue.words?.find((word) => at >= word.startSec && at < word.endSec);
  if (active === undefined) return [{ text: cue.text, active: false }];
  let cursor = 0;
  for (const word of cue.words ?? []) {
    const start = cue.text.indexOf(word.text, cursor);
    if (start < 0) return [{ text: cue.text, active: false }];
    if (word === active) return [{ text: cue.text.slice(0, start), active: false }, { text: word.text, active: true }, { text: cue.text.slice(start + word.text.length), active: false }];
    cursor = start + word.text.length;
  }
  return [{ text: cue.text, active: false }];
}

/** Discrete ASS events share the preview's plan. No karaoke sweep, accumulated highlight, or synthetic word clock. */
export function highlightedCaptionAss(cues: readonly VideoCue[], options: AudiobookVideoOptions): string {
  const { width, height } = shapeSize(options.shape);
  const size = captionFontPx(options.shape, options.captionSize);
  const alignment = options.captionPosition === "middle" ? 5 : 2;
  const time = (seconds: number) => {
    const cs = Math.round(seconds * 100);
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
  };
  const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
  const events: string[] = [];
  for (const cue of cues) {
    if (cue.words === undefined) throw new Error("measured word timing is required for highlighted captions");
    const edges = [...new Set([cue.startSec, cue.endSec, ...cue.words.flatMap((word) => [word.startSec, word.endSec]).filter((at) => at > cue.startSec && at < cue.endSec)])].sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) {
      const from = edges[i - 1]!, to = edges[i]!;
      if (time(from) === time(to)) continue;
      const text = captionWordParts(cue, (from + to) / 2).map((part) => `${part.active ? "{\\bord3\\3a&H00&\\3c&H0063DFFF&\\1c&H00171717&}" : "{\\bord0\\3a&HFF&\\1c&H00FFFFFF&}"}${escape(part.text)}`).join("");
      events.push(`Dialogue: 0,${time(from)},${time(to)},Caption,,0,0,0,,${text}`);
    }
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Geist,${size},&H00FFFFFF,&H00FFFFFF,&H99000000,&H99000000,-1,0,0,0,100,100,0,0,3,0,0,${alignment},${Math.round(width * .08)},${Math.round(width * .08)},${Math.round(height * CAPTION_BOTTOM_SHARE)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// Files.

/**
 * A book in parts (rule 2): chapters in order, a part closed at the last chapter boundary that
 * keeps it within the cap (its opening counted), and a chapter longer than the cap a part alone.
 */
export function bookParts<T extends { seconds: number }>(chapters: readonly T[], cap = BOOK_PART_CAP_SEC, opening = BOOK_OPENING_SEC): Array<{ chapters: T[]; seconds: number }> {
  const parts: Array<{ chapters: T[]; seconds: number }> = [];
  let current: { chapters: T[]; seconds: number } | null = null;
  for (const chapter of chapters) {
    if (current !== null && current.seconds + chapter.seconds > cap) {
      parts.push(current);
      current = null;
    }
    if (current === null) current = { chapters: [], seconds: opening };
    current.chapters.push(chapter);
    current.seconds += chapter.seconds;
  }
  if (current !== null) parts.push(current);
  return parts;
}

/** A name's words as a file's: lower case, hyphens between, nothing a file system refuses. */
export function videoSlug(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "audiobook" : slug;
}

/** `na-love-or-juju-01-chapter-1.mp4`, `na-love-or-juju.mp4`, `na-love-or-juju-part-2.mp4` (rule 2). */
export function videoFileName(book: string, file: { kind: "chapter"; order: number; title: string } | { kind: "book"; part: number | null }): string {
  const base = videoSlug(book);
  if (file.kind === "book") return file.part === null ? `${base}.mp4` : `${base}-part-${file.part}.mp4`;
  return `${base}-${String(file.order).padStart(2, "0")}-${videoSlug(file.title)}.mp4`;
}

/** The dated folder under the world's exports: `na-love-or-juju-video-20261004`. */
export function videoFolderName(book: string, isoDate: string, scope?: AudiobookScope): string {
  // Add scope after truncating the title: long book titles must not erase chapter identity.
  return `${videoSlug(book)}${scope?.kind === "chapter" ? `-chapter-${scope.chapterId}` : ""}-video-${isoDate.slice(0, 10).replace(/-/g, "")}`;
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// Size and time before Render (rule 9).

export interface VideoRate {
  /** Bytes of file a second of video. */
  bytesPerSec: number;
  /** Seconds of video made a second on this machine. */
  speed: number;
}

/** Rates measured on this machine, by `<shape>/<push|still>`; absent until a chapter has been made. */
export type VideoRates = Record<string, VideoRate>;

export const videoRateKey = (shape: VideoShape, slowPush: boolean) => `${shape}/${slowPush ? "push" : "still"}`;

/**
 * Before anything is measured: what a 1080 render of held pictures came to on a 3080 desktop
 * (H.264 veryfast at CRF 20, AAC 128k), scaled by pixels for the smaller shape. Marked `~` until
 * this machine has made a chapter.
 */
const FIRST_RATES: Record<string, VideoRate> = {
  "1920x1080/push": { bytesPerSec: 92_000, speed: 6 },
  "1920x1080/still": { bytesPerSec: 46_000, speed: 18 },
  "1080x1920/push": { bytesPerSec: 92_000, speed: 6 },
  "1080x1920/still": { bytesPerSec: 46_000, speed: 18 },
  "1280x720/push": { bytesPerSec: 58_000, speed: 12 },
  "1280x720/still": { bytesPerSec: 30_000, speed: 30 },
};

export function videoEstimate(input: { shape: VideoShape; slowPush: boolean; videoSec: number; renderSec: number; rates: VideoRates }): { bytes: number; seconds: number; measured: boolean } {
  const key = videoRateKey(input.shape, input.slowPush);
  const measured = input.rates[key];
  const rate = measured ?? FIRST_RATES[key]!;
  return { bytes: Math.round(input.videoSec * rate.bytesPerSec), seconds: Math.round(input.renderSec / Math.max(0.1, rate.speed)), measured: measured !== undefined };
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// What a render made.

export interface AudiobookVideoFile {
  chapterIds?: string[];
  /** The file's name in the export's folder. */
  name: string;
  seconds: number;
  bytes: number;
  shape: VideoShape;
  /** `.srt` and `.vtt` beside it, when a sidecar was asked for. */
  sidecars: string[];
  /** The world-relative picture its thumbnail shows: the chapter's first picture, else the cover. */
  picture: string | null;
}

export type AudiobookVideoResult =
  | {
      ok: true;
      /** `exports/<folder>`. */
      dir: string;
      files: AudiobookVideoFile[];
      /** Chapters encoded by this render; the rest came from the cache. */
      made: number;
      renderedAt: string;
      scope?: AudiobookScope;
      chapterIds?: string[];
    }
  | { ok: false; blockers: string[] };

const VideoFileSchema = z
  .object({
    chapterIds: z.array(z.string().min(1)).min(1).optional(),
    name: z.string().regex(/^[A-Za-z0-9._-]+\.mp4$/),
    seconds: z.number().min(0),
    bytes: z.number().int().min(0),
    shape: z.enum(VIDEO_SHAPES),
    sidecars: z.array(z.enum([".srt", ".vtt"])),
    picture: z.string().nullable(),
  })
  .strict();

export const AudiobookVideoResultSchema: z.ZodType<AudiobookVideoResult, z.ZodTypeDef, unknown> = z.union([
  z.object({ ok: z.literal(true), dir: z.string().startsWith("exports/"), files: z.array(VideoFileSchema).min(1), made: z.number().int().min(0), renderedAt: z.string().min(1), scope: AudiobookScopeSchema.optional(), chapterIds: z.array(z.string().min(1)).min(1).optional() }).strict(),
  z.object({ ok: z.literal(false), blockers: z.array(z.string().min(1)).min(1) }).strict(),
]);

/** What the sheet is told before Render: which chapters this render would make, and this machine's rates. */
export interface AudiobookVideoState {
  scope?: AudiobookScope;
  blockers?: string[];
  chapters: Array<{ chapterId: string; seconds: number; rendered: boolean }>;
  rates: VideoRates;
  /** The narrator, for the book file's opening. */
  readBy: string;
  /** A render of this book going now, by its export id. */
  running: string | null;
}

export const AudiobookVideoStateSchema: z.ZodType<AudiobookVideoState, z.ZodTypeDef, unknown> = z
  .object({
    scope: AudiobookScopeSchema.optional(),
    blockers: z.array(z.string().min(1)).optional(),
    chapters: z.array(z.object({ chapterId: z.string().min(1), seconds: z.number().min(0), rendered: z.boolean() }).strict()),
    rates: z.record(z.object({ bytesPerSec: z.number().min(0), speed: z.number().positive() }).strict()),
    readBy: z.string(),
    running: z.string().nullable(),
  })
  .strict();

/** Where a render stands, for Activity (rule 10): measured against the chapters' length, never ffmpeg's clock. */
export interface AudiobookVideoProgress {
  title: string;
  chapter: number;
  of: number;
  doneSec: number;
  totalSec: number;
  /** Seconds of rendering left at this render's own pace; null until it has a pace. */
  leftSec: number | null;
}

export const AudiobookVideoProgressSchema: z.ZodType<AudiobookVideoProgress, z.ZodTypeDef, unknown> = z
  .object({
    title: z.string(),
    chapter: z.number().int().min(0),
    of: z.number().int().min(0),
    doneSec: z.number().min(0),
    totalSec: z.number().min(0),
    leftSec: z.number().min(0).nullable(),
  })
  .strict();

/** `31:40`, `1:02:05`: a length as the sheet and Activity say it. */
export function clockTime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** `11 h 40 m`, `5 min`: a long time said short. */
export function roughTime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h ${String(m).padStart(2, "0")} m`;
}
