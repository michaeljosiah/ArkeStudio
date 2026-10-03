import { z } from "zod";
import { audiobookTextHash } from "./audiobook.js";
import { PICTURE_MIN_HOLD_SEC, type AudiobookPicture } from "./audiobook-pictures.js";
import { SlugSchema } from "./ids.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-57..R-62): the made chapters in
 * order, each its takes back to back with nothing added between them — a grouped take was cut at
 * the middle of the reader's own pause, and a take read alone is as it was made (turn 185) — the
 * blocks not made counted as the gaps they are, and the pictures set on blocks placed on the
 * chapter's clock.
 *
 * One plan for both homes: the coordinator computes it for the player in the app, and the
 * exporter writes the same plan into the package beside the joined audio. Nothing here reads a
 * file or a clock; times are seconds from the start of the chapter.
 */

/** A block read at about this rate when it has no take yet: only for the chapter view's spans, never the player's clock. */
export const ESTIMATED_CHARACTERS_PER_SECOND = 15;

/** A sentence and where it starts in its chapter. */
export const ListeningSentenceSchema = z.object({ at: z.number().min(0), text: z.string() }).strict();
export type ListeningSentence = z.infer<typeof ListeningSentenceSchema>;

export const ListeningBlockSchema = z
  .object({
    key: z.string().min(1),
    /** The block's number in the chapter view (`Block 3`), the title first. */
    number: z.number().int().min(1),
    /** The take's media, world-relative; in a package, the package's own file. */
    file: z.string().min(1),
    at: z.number().min(0),
    seconds: z.number().positive(),
    /** What Text shows: the sentences of a grouped take, or a block read alone whole (R-61). */
    sentences: z.array(ListeningSentenceSchema).min(1),
  })
  .strict();
export type ListeningBlock = z.infer<typeof ListeningBlockSchema>;

/** A run of blocks with no take, where the chapter's clock skips over them: `blocks 12–14 not read`. */
export const ListeningGapSchema = z.object({ at: z.number().min(0), from: z.number().int().min(1), to: z.number().int().min(1) }).strict();
export type ListeningGap = z.infer<typeof ListeningGapSchema>;

export const ListeningPictureSchema = z
  .object({
    key: z.string().min(1),
    number: z.number().int().min(1),
    file: z.string().min(1),
    at: z.number().min(0),
    /** How long it holds before the next picture or the chapter's end. */
    seconds: z.number().min(0),
    /** Held for less than twenty seconds (R-60): flagged in the chapter's view, never dropped. */
    short: z.boolean(),
  })
  .strict();
export type ListeningPicture = z.infer<typeof ListeningPictureSchema>;

export const ListeningChapterSchema = z
  .object({
    chapterId: SlugSchema,
    order: z.number().int().min(1),
    title: z.string(),
    /** `read`: every block made; `part`: some; `not read`: none, or no prose — listed and held, never skipped silently (R-58). */
    state: z.enum(["read", "part", "not read"]),
    seconds: z.number().min(0),
    blocks: z.array(ListeningBlockSchema),
    gaps: z.array(ListeningGapSchema),
    pictures: z.array(ListeningPictureSchema),
    /** What shows before the chapter's first picture: its picture on its opening block, else the book's cover (R-60). */
    opening: z.string().nullable(),
  })
  .strict();
export type ListeningChapter = z.infer<typeof ListeningChapterSchema>;

export const AudiobookListeningSchema = z
  .object({
    productionId: SlugSchema,
    title: z.string(),
    /** The book's cover: the world's key art, world-relative, or none. */
    cover: z.string().nullable(),
    chapters: z.array(ListeningChapterSchema),
  })
  .strict();
export type AudiobookListening = z.infer<typeof AudiobookListeningSchema>;

/** A block as the plan reads it: its words, and the take that plays when it is made and current. */
export interface ListeningInputBlock {
  key: string;
  text: string;
  take?: { file: string; seconds: number; grouped: boolean };
}

/** A picture placed on one of the chapter's blocks. */
export interface PlacedPicture {
  key: string;
  /** The block's index in the chapter, the title at 0. */
  index: number;
  picture: AudiobookPicture;
  /** It sits on another key than the one it was set on: a paragraph moved, and the words were found again. */
  moved: boolean;
}

/**
 * Where each picture stands now (R-60). A picture follows its block's words: on its own key while
 * that block still says what it said, else on the one block that does, else on its key whatever
 * it says now. A picture whose key is gone and whose words are nowhere is `lost` — named, so the
 * chapter's view can say so, never shown on a block it was not set on. Two pictures on one block
 * keep the one set there.
 */
export function placePictures(
  blocks: readonly Pick<ListeningInputBlock, "key" | "text">[],
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  usable: (file: string) => boolean = () => true,
): { placed: PlacedPicture[]; lost: string[] } {
  const hashes = blocks.map((block) => audiobookTextHash(block.text));
  const byIndex = new Map<number, PlacedPicture>();
  const lost: string[] = [];
  for (const [key, picture] of Object.entries(pictures ?? {})) {
    if (!usable(picture.file)) {
      lost.push(key);
      continue;
    }
    const own = blocks.findIndex((block) => block.key === key);
    let index = own >= 0 && hashes[own] === picture.textHash ? own : -1;
    if (index < 0) {
      const found = hashes.flatMap((hash, at) => (hash === picture.textHash ? [at] : []));
      index = found.length === 1 ? found[0]! : own;
    }
    if (index < 0) {
      lost.push(key);
      continue;
    }
    const placed: PlacedPicture = { key, index, picture, moved: blocks[index]!.key !== key };
    const held = byIndex.get(index);
    if (held === undefined || (held.moved && !placed.moved)) byIndex.set(index, placed);
    else lost.push(key);
  }
  return { placed: [...byIndex.values()].sort((a, b) => a.index - b.index), lost };
}

/** A block's sentences, at sentence ends; a text with none is one sentence. */
export function sentencesOf(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return [];
  const parts = flat.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) ?? [flat];
  const kept = parts.map((part) => part.trim()).filter((part) => part !== "");
  return kept.length > 0 ? kept : [flat];
}

/**
 * What Text shows for a block (R-61), from the block's start: a grouped take's sentences, each
 * given its share of the take by its length — the split kept no word times past the cut — and a
 * block read alone whole, for its length, as the binding says.
 */
export function blockSentences(text: string, seconds: number, grouped: boolean): ListeningSentence[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!grouped) return [{ at: 0, text: flat }];
  const sentences = sentencesOf(flat);
  if (sentences.length <= 1) return [{ at: 0, text: flat }];
  const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
  let at = 0;
  return sentences.map((sentence) => {
    const entry = { at: round(at), text: sentence };
    at += (seconds * sentence.length) / total;
    return entry;
  });
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * Each picture's place on the chapter's clock and how long it holds (R-60): it shows from its
 * block's start until the next picture, or the chapter's end. `starts` is every block's start —
 * a block with no take starts where the clock stands when it is reached, which is where the next
 * take starts.
 */
export function pictureHolds(placed: readonly PlacedPicture[], starts: readonly number[], end: number): Array<PlacedPicture & { at: number; seconds: number; short: boolean }> {
  return placed.map((entry, index) => {
    const at = starts[entry.index] ?? end;
    const next = placed[index + 1];
    const until = next === undefined ? end : (starts[next.index] ?? end);
    const seconds = Math.max(0, round(until - at));
    return { ...entry, at: round(at), seconds, short: seconds < PICTURE_MIN_HOLD_SEC };
  });
}

/**
 * The chapter as it plays (R-58..R-60): the made blocks in order on one clock, the runs of blocks
 * not made as gaps, each picture placed and held, and what the chapter opens on.
 */
export function listeningChapter(input: {
  chapterId: string;
  order: number;
  title: string;
  blocks: readonly ListeningInputBlock[];
  pictures?: Readonly<Record<string, AudiobookPicture>>;
  cover: string | null;
  usable?: (file: string) => boolean;
}): ListeningChapter {
  const blocks: ListeningBlock[] = [];
  const gaps: ListeningGap[] = [];
  const starts: number[] = [];
  let clock = 0;
  input.blocks.forEach((block, index) => {
    const number = index + 1;
    starts.push(round(clock));
    if (block.take === undefined || !(block.take.seconds > 0)) {
      const open = gaps[gaps.length - 1];
      if (open !== undefined && open.to === number - 1) open.to = number;
      else gaps.push({ at: round(clock), from: number, to: number });
      return;
    }
    const sentences = blockSentences(block.text, block.take.seconds, block.take.grouped).map((sentence) => ({ at: round(clock + sentence.at), text: sentence.text }));
    blocks.push({ key: block.key, number, file: block.take.file, at: round(clock), seconds: block.take.seconds, sentences });
    clock += block.take.seconds;
  });
  const seconds = round(clock);
  const { placed } = placePictures(input.blocks, input.pictures, input.usable);
  const pictures = pictureHolds(placed, starts, seconds).map((entry) => ({
    key: input.blocks[entry.index]!.key,
    number: entry.index + 1,
    file: entry.picture.file,
    at: entry.at,
    seconds: entry.seconds,
    short: entry.short,
  }));
  const first = pictures[0];
  const opening = first !== undefined && first.at === 0 ? first.file : (input.cover ?? first?.file ?? null);
  const state = blocks.length === 0 ? "not read" : blocks.length === input.blocks.length ? "read" : "part";
  return { chapterId: input.chapterId, order: input.order, title: input.title, state, seconds, blocks, gaps, pictures, opening };
}

/**
 * Where a picture shows in the chapter's view before the chapter is read (turn 186c): the same
 * placement, with a block that has no take timed at the reading rate, and said to be estimated.
 */
export function pictureSpans(
  blocks: ReadonlyArray<Pick<ListeningInputBlock, "key" | "text"> & { seconds: number | null }>,
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  usable?: (file: string) => boolean,
): { spans: Array<PlacedPicture & { at: number; seconds: number; short: boolean; until: number | null }>; lost: string[]; estimated: boolean } {
  const starts: number[] = [];
  let clock = 0;
  let estimated = false;
  for (const block of blocks) {
    starts.push(round(clock));
    if (block.seconds !== null && block.seconds > 0) clock += block.seconds;
    else {
      estimated = true;
      clock += block.text.length / ESTIMATED_CHARACTERS_PER_SECOND;
    }
  }
  const { placed, lost } = placePictures(blocks, pictures, usable);
  const held = pictureHolds(placed, starts, round(clock));
  return {
    spans: held.map((entry, index) => ({ ...entry, until: held[index + 1]?.index ?? null })),
    lost,
    estimated,
  };
}

/** Where the listener is in the book (R-59): `chapter 7 of 22` and what is left from here, the chapter's rest and the chapters after it. */
export function bookPlace(chapters: readonly Pick<ListeningChapter, "seconds">[], index: number, at: number): { chapter: number; of: number; leftSeconds: number } {
  const here = chapters[index];
  const rest = here === undefined ? 0 : Math.max(0, here.seconds - at);
  const after = chapters.slice(index + 1).reduce((sum, chapter) => sum + chapter.seconds, 0);
  return { chapter: index + 1, of: chapters.length, leftSeconds: rest + after };
}
