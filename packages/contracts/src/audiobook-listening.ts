import { z } from "zod";
import { audiobookTextHash } from "./audiobook.js";
import { PICTURE_MIN_HOLD_SEC, type AudiobookPicture } from "./audiobook-pictures.js";
import { SlugSchema } from "./ids.js";

/** Inclusion is independent of how video files are partitioned (turn 209, SPEC-047 R-179). */
export const AudiobookScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("book") }).strict(),
  z.object({ kind: z.literal("chapter"), chapterId: SlugSchema }).strict(),
]);
export type AudiobookScope = z.infer<typeof AudiobookScopeSchema>;

/** An absent scope is an older whole-book request; an invalid chapter never broadens it. */
export function audiobookScopeKey(scope: AudiobookScope | undefined): string {
  return scope?.kind === "chapter" ? `chapter-${scope.chapterId}` : "book";
}

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-66..R-71): the made chapters in
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
    /** The take that plays, by its artifact: what a timing layer addresses the block's take by (turn 187). */
    artifactId: z.string().min(1).optional(),
    at: z.number().min(0),
    seconds: z.number().positive(),
    /** What Text shows: the sentences of a grouped take, or a block read alone whole (R-70). */
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
    /** Held for less than twenty seconds (R-69): flagged in the chapter's view, never dropped. */
    short: z.boolean(),
    /** Where its subject stands (design turn 197): the video's vertical crop and Slow push follow it. */
    focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
  })
  .strict();
export type ListeningPicture = z.infer<typeof ListeningPictureSchema>;

export const ListeningChapterSchema = z
  .object({
    chapterId: SlugSchema,
    order: z.number().int().min(1),
    title: z.string(),
    /** `read`: every block made; `part`: some; `not read`: none, or no prose — listed and held, never skipped silently (R-67). */
    state: z.enum(["read", "part", "not read"]),
    seconds: z.number().min(0),
    blocks: z.array(ListeningBlockSchema),
    gaps: z.array(ListeningGapSchema),
    pictures: z.array(ListeningPictureSchema),
    /** What shows before the chapter's first picture: its picture on its opening block, else the book's cover (R-69). */
    opening: z.string().nullable(),
    /**
     * The chapter's one mix (design turn 187, R-85), when it has timing: overlaps, reactions, beds
     * and trims as set. The player plays this in place of the takes; blocks keep their places on
     * its clock for Text and the pictures.
     */
    mix: z.object({ file: z.string().min(1), seconds: z.number().min(0) }).strict().optional(),
  })
  .strict();
export type ListeningChapter = z.infer<typeof ListeningChapterSchema>;

export const AudiobookListeningSchema = z
  .object({
    productionId: SlugSchema,
    title: z.string(),
    scope: AudiobookScopeSchema.optional(),
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
  /** A block joined by hand (design turn 198): the automatic blocks whose first turn it holds, whose first picture it shows. */
  starts?: readonly string[];
  take?: { file: string; seconds: number; grouped: boolean; artifactId?: string };
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
 * Where each picture stands now (R-69). A picture follows its block's words: on its own key while
 * that block still says what it said, else on the one block that does, else on its key whatever
 * it says now. A picture whose key is gone and whose words are nowhere is `lost` — named, so the
 * chapter's view can say so, never shown on a block it was not set on. Two pictures on one block
 * keep the one set there.
 */
export function placePictures(
  blocks: readonly Pick<ListeningInputBlock, "key" | "text" | "starts">[],
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  usable: (file: string) => boolean = () => true,
): { placed: PlacedPicture[]; lost: string[]; /** Pictures a join took off their block (design turn 198): kept on the record under it, shown nowhere, never lost. */ off: string[] } {
  const hashes = blocks.map((block) => audiobookTextHash(block.text));
  const byIndex = new Map<number, PlacedPicture>();
  const lost: string[] = [];
  const off: string[] = [];
  // A block joined by hand shows the first picture among the blocks it was made of (design turn
  // 198, rule 6); a later one comes off its block and stays on the record under it, so a split or
  // Reset puts it back.
  const joinedInto = new Map<string, { index: number; order: number }>();
  blocks.forEach((block, index) => block.starts?.forEach((key, order) => joinedInto.set(key, { index, order })));
  const offered: Array<{ key: string; index: number; order: number; picture: AudiobookPicture }> = [];
  for (const [key, picture] of Object.entries(pictures ?? {})) {
    if (!usable(picture.file)) {
      lost.push(key);
      continue;
    }
    const own = blocks.findIndex((block) => block.key === key);
    const into = own < 0 ? joinedInto.get(key) : undefined;
    if (into !== undefined && into.order > 0) {
      offered.push({ key, ...into, picture });
      continue;
    }
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
  for (const entry of offered.sort((a, b) => a.order - b.order)) {
    if (byIndex.has(entry.index)) off.push(entry.key);
    else byIndex.set(entry.index, { key: entry.key, index: entry.index, picture: entry.picture, moved: true });
  }
  return { placed: [...byIndex.values()].sort((a, b) => a.index - b.index), lost, off };
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
 * What Text shows for a block (R-70), from the block's start: a grouped take's sentences, each
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
 * Each picture's place on the chapter's clock and how long it holds (R-69): it shows from its
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
 * The chapter as it plays (R-67..R-69): the made blocks in order on one clock, the runs of blocks
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
  /**
   * The chapter's clock with its timing (design turn 187, SPEC-047 R-85), when it has any: each
   * made block at its place in the one mix — trimmed, nudged, cutting in — and the mix itself,
   * which the player plays in place of the takes. Absent, the takes play back to back.
   */
  timed?: { bars: ReadonlyArray<{ key: string; at: number; seconds: number }>; seconds: number; mix: { file: string; seconds: number } };
}): ListeningChapter {
  const blocks: ListeningBlock[] = [];
  const gaps: ListeningGap[] = [];
  const starts: number[] = [];
  let clock = 0;
  const timedAt = new Map((input.timed?.bars ?? []).map((bar) => [bar.key, bar]));
  input.blocks.forEach((block, index) => {
    const number = index + 1;
    const bar = timedAt.get(block.key);
    // On the timed clock a block not made stands where the next made one starts: the mix skips it.
    if (input.timed !== undefined) clock = bar?.at ?? input.blocks.slice(index + 1).map((later) => timedAt.get(later.key)?.at).find((at) => at !== undefined) ?? input.timed.seconds;
    starts.push(round(clock));
    if (block.take === undefined || !(block.take.seconds > 0) || (input.timed !== undefined && bar === undefined)) {
      const open = gaps[gaps.length - 1];
      if (open !== undefined && open.to === number - 1) open.to = number;
      else gaps.push({ at: round(clock), from: number, to: number });
      return;
    }
    const length = bar?.seconds ?? block.take.seconds;
    const sentences = blockSentences(block.text, length, block.take.grouped).map((sentence) => ({ at: round(clock + sentence.at), text: sentence.text }));
    blocks.push({ key: block.key, number, file: block.take.file, ...(block.take.artifactId !== undefined ? { artifactId: block.take.artifactId } : {}), at: round(clock), seconds: length, sentences });
    clock += length;
  });
  const seconds = input.timed !== undefined ? round(input.timed.mix.seconds) : round(clock);
  const { placed } = placePictures(input.blocks, input.pictures, input.usable);
  const pictures = pictureHolds(placed, starts, seconds).map((entry) => ({
    key: input.blocks[entry.index]!.key,
    number: entry.index + 1,
    file: entry.picture.file,
    at: entry.at,
    seconds: entry.seconds,
    short: entry.short,
    ...(entry.picture.focus !== undefined ? { focus: entry.picture.focus } : {}),
  }));
  const first = pictures[0];
  const opening = first !== undefined && first.at === 0 ? first.file : (input.cover ?? first?.file ?? null);
  const state = blocks.length === 0 ? "not read" : blocks.length === input.blocks.length ? "read" : "part";
  return { chapterId: input.chapterId, order: input.order, title: input.title, state, seconds, blocks, gaps, pictures, opening, ...(input.timed !== undefined && blocks.length > 0 ? { mix: input.timed.mix } : {}) };
}

/**
 * Where a picture shows in the chapter's view before the chapter is read (turn 186c): the same
 * placement, with a block that has no take timed at the reading rate, and said to be estimated.
 *
 * A picture's start is estimated only when a block before it was (`startEstimated`): one unread
 * block near the chapter's end once put a `~` on every chip above it, whose times were all measured
 * (design turn 194 draws `10:22` on a chapter with a block not yet made below it).
 */
export function pictureSpans(
  blocks: ReadonlyArray<Pick<ListeningInputBlock, "key" | "text" | "starts"> & { seconds: number | null }>,
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  usable?: (file: string) => boolean,
): { spans: Array<PlacedPicture & { at: number; seconds: number; short: boolean; until: number | null; startEstimated: boolean }>; lost: string[]; estimated: boolean } {
  const starts: number[] = [];
  /** Whether each block's start leans on an estimate: some block before it had no measured length. */
  const guessed: boolean[] = [];
  let clock = 0;
  let estimated = false;
  for (const block of blocks) {
    starts.push(round(clock));
    guessed.push(estimated);
    if (block.seconds !== null && block.seconds > 0) clock += block.seconds;
    else {
      estimated = true;
      clock += block.text.length / ESTIMATED_CHARACTERS_PER_SECOND;
    }
  }
  const { placed, lost } = placePictures(blocks, pictures, usable);
  const held = pictureHolds(placed, starts, round(clock));
  return {
    spans: held.map((entry, index) => ({ ...entry, until: held[index + 1]?.index ?? null, startEstimated: guessed[entry.index] ?? estimated })),
    lost,
    estimated,
  };
}

/** Where the listener is in the book (R-68): `chapter 7 of 22` and what is left from here, the chapter's rest and the chapters after it. */
export function bookPlace(chapters: readonly Pick<ListeningChapter, "seconds">[], index: number, at: number): { chapter: number; of: number; leftSeconds: number } {
  const here = chapters[index];
  const rest = here === undefined ? 0 : Math.max(0, here.seconds - at);
  const after = chapters.slice(index + 1).reduce((sum, chapter) => sum + chapter.seconds, 0);
  return { chapter: index + 1, of: chapters.length, leftSeconds: rest + after };
}
