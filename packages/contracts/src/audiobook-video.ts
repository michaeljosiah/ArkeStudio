import { z } from "zod";
import { PICTURE_CROSSFADE_SEC } from "./audiobook-pictures.js";
import type { ListeningChapter } from "./audiobook-listening.js";
import { SubtitleOutputModeSchema, type SubtitleOutputMode } from "./subtitles.js";

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
  /** One file a chapter (the default), or one for the book in parts of at most twelve hours. */
  files: "chapter" | "book";
  shape: VideoShape;
  /** Each picture moves 6% closer over its hold, toward its focus (on by default, the owner's answer). */
  slowPush: boolean;
  /** The Cut's own control: Sidecar, Burned in, Both or None. */
  subtitles: SubtitleOutputMode;
  captionPosition: CaptionPosition;
  captionSize: CaptionSize;
  titleCards: boolean;
}

// Annotated (TS7056): an inferred schema rides into the frames and events unions, whose
// declarations the engine's bundle has refused as too long to serialize.
export const AudiobookVideoOptionsSchema: z.ZodType<AudiobookVideoOptions, z.ZodTypeDef, unknown> = z
  .object({
    files: z.enum(["chapter", "book"]),
    shape: z.enum(VIDEO_SHAPES),
    slowPush: z.boolean(),
    subtitles: SubtitleOutputModeSchema,
    captionPosition: z.enum(["bottom", "middle"]),
    captionSize: z.enum(["s", "m", "l"]),
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
    segments.push({ kind: "picture", file: picture.file, key: picture.key, from: round(picture.at), to, ...(picture.focus !== undefined ? { focus: picture.focus } : {}) });
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

/**
 * The vertical crop (rule 3): a full-height column of the picture's 9:16 around its focus, kept
 * inside the picture. Returned as the column's left edge and width, as shares of the picture's
 * width. A picture narrower than 9:16 keeps its whole width.
 */
export function verticalCrop(pictureWidth: number, pictureHeight: number, focusX = 0.5): { left: number; width: number } {
  const width = Math.min(1, (pictureHeight * 9) / 16 / pictureWidth);
  const left = Math.min(1 - width, Math.max(0, focusX - width / 2));
  return { left: Math.round(left * 10000) / 10000, width: Math.round(width * 10000) / 10000 };
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// The words.

export interface VideoCue {
  text: string;
  startSec: number;
  endSec: number;
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

/**
 * The chapter's words as cues, timed exactly as the player's Text times them (rule 5): each
 * sentence from its place in its block until the next sentence, the block's last until the block
 * ends — the takes keep no word times, so a grouped take's sentences share it by length. A
 * sentence longer than `maxLines` lines of `maxChars` is cut at line breaks into cues that share
 * its time by length.
 */
export function chapterCues(chapter: Pick<ListeningChapter, "blocks">, maxChars = 42, maxLines = 2): VideoCue[] {
  const cues: VideoCue[] = [];
  for (const block of chapter.blocks) {
    const end = block.at + block.seconds;
    block.sentences.forEach((sentence, index) => {
      const from = Math.max(block.at, sentence.at);
      const to = Math.min(end, block.sentences[index + 1]?.at ?? end);
      if (!(to > from)) return;
      const lines = wrapWords(sentence.text, maxChars);
      if (lines.length === 0) return;
      const pieces: string[][] = [];
      for (let at = 0; at < lines.length; at += maxLines) pieces.push(lines.slice(at, at + maxLines));
      const total = pieces.reduce((sum, piece) => sum + piece.join(" ").length, 0);
      let clock = from;
      for (const piece of pieces) {
        const share = ((to - from) * piece.join(" ").length) / total;
        cues.push({ text: piece.join("\n"), startSec: round(clock), endSec: round(clock + share) });
        clock += share;
      }
    });
  }
  return cues;
}

/**
 * The burned-in words (rule 5): only the sentence being read, broken to the frame's width at the
 * chosen size, at most three lines a cue; none over a title card, which is the title being read.
 */
export function burnedCues(chapter: Pick<ListeningChapter, "blocks">, shape: VideoShape, size: CaptionSize, after = 0): VideoCue[] {
  return chapterCues(chapter, captionLineChars(shape, size), 3)
    .filter((cue) => cue.endSec > after)
    .map((cue) => ({ ...cue, startSec: Math.max(cue.startSec, after) }))
    .filter((cue) => cue.endSec - cue.startSec > 0.05);
}

/** The cue showing at a time: the preview's caption. */
export function cueAt(cues: readonly VideoCue[], at: number): VideoCue | null {
  return cues.find((cue) => at >= cue.startSec && at < cue.endSec) ?? null;
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
export function videoFolderName(book: string, isoDate: string): string {
  return `${videoSlug(book)}-video-${isoDate.slice(0, 10).replace(/-/g, "")}`;
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
    }
  | { ok: false; blockers: string[] };

const VideoFileSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._-]+\.mp4$/),
    seconds: z.number().min(0),
    bytes: z.number().int().min(0),
    shape: z.enum(VIDEO_SHAPES),
    sidecars: z.array(z.enum([".srt", ".vtt"])),
    picture: z.string().nullable(),
  })
  .strict();

export const AudiobookVideoResultSchema: z.ZodType<AudiobookVideoResult, z.ZodTypeDef, unknown> = z.union([
  z.object({ ok: z.literal(true), dir: z.string().startsWith("exports/"), files: z.array(VideoFileSchema).min(1), made: z.number().int().min(0), renderedAt: z.string().min(1) }).strict(),
  z.object({ ok: z.literal(false), blockers: z.array(z.string().min(1)).min(1) }).strict(),
]);

/** What the sheet is told before Render: which chapters this render would make, and this machine's rates. */
export interface AudiobookVideoState {
  chapters: Array<{ chapterId: string; seconds: number; rendered: boolean }>;
  rates: VideoRates;
  /** The narrator, for the book file's opening. */
  readBy: string;
  /** A render of this book going now, by its export id. */
  running: string | null;
}

export const AudiobookVideoStateSchema: z.ZodType<AudiobookVideoState, z.ZodTypeDef, unknown> = z
  .object({
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
