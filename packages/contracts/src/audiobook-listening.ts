import { z } from "zod";
import { audiobookTextHash } from "./audiobook.js";
import { pictureKeyParts, pictureMarkKey, tallFromEarlier, type AudiobookPicture } from "./audiobook-pictures.js";
import { SlugSchema } from "./ids.js";
import { AudiobookMotionSchema } from "./audiobook-motion.js";
import { AcousticWordSchema, timingWord, type AcousticWord } from "./audiobook-word-timing.js";

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
    /** The source clock: grouped sentences or an individual block, subdivided into Text's bounded phrases (R-70). */
    sentences: z.array(ListeningSentenceSchema).min(1),
    /** Validated acoustic words on this chapter's mix clock; absent when unavailable or stale. */
    words: z.array(AcousticWordSchema).optional(),
    wordTimingReason: z.string().optional(),
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
    /** How long it holds before the next picture or the chapter's end: however short, it holds (design turn 237, R-207). */
    seconds: z.number().min(0),
    /**
     * A mark inside its block (design turn 237, R-204): the index of its first word in the block's
     * timed words, by which `retimePictureMarks` moves it from its estimate to the moment it is
     * spoken. The Studio's own; the package writes the time alone.
     */
    word: z.number().int().min(0).optional(),
    /** Where its subject stands (design turn 197): the video's vertical crop and Slow push follow it. */
    focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
    motion: AudiobookMotionSchema.optional(),
    motionProblem: z.string().optional(),
    /** The same moment made Tall for a phone (design turn 235, SPEC-047 R-197), when it has one that can be shown. */
    tall: z.string().min(1).optional(),
    /** Its Tall was made from an earlier picture than this one (the owner's call 3): it plays, and Make tall remakes it. */
    tallEarlier: z.literal(true).optional(),
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
    audioStudio: z.object({ revision: z.number().int().positive(), issues: z.array(z.string()), omissions: z.array(z.string()) }).strict().optional(),
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
  /**
   * Which of the block's sentences it starts at (design turn 237, R-202), as `sentencesOf` cuts
   * them: 0 for a picture at the block's first word, as every picture without a mark is.
   */
  sentence: number;
  picture: AudiobookPicture;
  /** It sits on another key than the one it was set on: a paragraph moved, and the words were found again. */
  moved: boolean;
}

/** Each sentence of a block by its words' hash, as a mark names it (R-202). */
export function sentenceHashes(text: string): string[] {
  return sentencesOf(text).map((sentence) => audiobookTextHash(sentence));
}

/**
 * Where a block's sentence starts in it (design turn 237, R-204): the share of the block's
 * characters before it, for a take not yet timed, and how many timed words come before it, as
 * `validateAcousticWords` counts the author's words — the index of its first word in the take's
 * word timing. Sentence 0 is the block's start.
 */
export function sentenceStart(text: string, sentence: number): { share: number; word: number } {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = sentencesOf(flat);
  if (sentence <= 0 || sentence >= sentences.length || flat.length === 0) return { share: 0, word: 0 };
  let from = 0;
  for (let index = 0; index < sentence; index += 1) {
    const found = flat.indexOf(sentences[index]!, from);
    from = found < 0 ? from : found + sentences[index]!.length;
  }
  const at = flat.indexOf(sentences[sentence]!, from);
  const offset = at < 0 ? from : at;
  const word = flat.slice(0, offset).trim().split(/\s+/).filter((token) => token !== "" && timingWord(token) !== "").length;
  return { share: offset / flat.length, word };
}

/**
 * Where each picture stands now (R-69). A picture follows its block's words: on its own key while
 * that block still says what it said, else on the one block that does, else on its key whatever
 * it says now. A picture whose key is gone and whose words are nowhere is `lost` — named, so the
 * chapter's view can say so, never shown on a block it was not set on. Two pictures on one block
 * keep the one set there.
 *
 * A mark (design turn 237, R-202) follows its sentence instead: on its own block while that block
 * still says the sentence, else on the one block that does, else lost. A block holds as many marks
 * as it has sentences; two at one sentence keep the one that has not moved, and a block's own
 * picture always keeps its first word.
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
  const marks: PlacedPicture[] = [];
  const sentenceLists = new Map<number, string[]>();
  const sentencesAt = (index: number) => {
    if (!sentenceLists.has(index)) sentenceLists.set(index, sentenceHashes(blocks[index]!.text));
    return sentenceLists.get(index)!;
  };
  for (const [key, picture] of Object.entries(pictures ?? {})) {
    if (!usable(picture.file)) {
      lost.push(key);
      continue;
    }
    if (picture.mark !== undefined) {
      const sentence = picture.mark.sentence;
      const home = blocks.findIndex((block) => block.key === pictureKeyParts(key).block);
      const holding = blocks.flatMap((_, index) => (sentencesAt(index).includes(sentence) ? [index] : []));
      const index = home >= 0 && holding.includes(home) ? home : holding.length === 1 ? holding[0]! : -1;
      if (index < 0) lost.push(key);
      else marks.push({ key, index, sentence: sentencesAt(index).indexOf(sentence), picture, moved: index !== home });
      continue;
    }
    const own = blocks.findIndex((block) => block.key === key);
    let index = own >= 0 && hashes[own] === picture.textHash ? own : -1;
    if (index < 0) {
      const found = hashes.flatMap((hash, at) => (hash === picture.textHash ? [at] : []));
      if (found.length === 1) index = found[0]!;
    }
    // An insertion can reuse this old key inside an unrelated join. Exact surviving words
    // still own their picture; only a picture without that match follows the join's first image.
    const into = own < 0 ? joinedInto.get(key) : undefined;
    if (index < 0 && into !== undefined && into.order > 0) {
      offered.push({ key, ...into, picture });
      continue;
    }
    if (index < 0) index = own;
    if (index < 0) {
      lost.push(key);
      continue;
    }
    const placed: PlacedPicture = { key, index, sentence: 0, picture, moved: blocks[index]!.key !== key };
    const held = byIndex.get(index);
    if (held === undefined || (held.moved && !placed.moved)) byIndex.set(index, placed);
    else lost.push(key);
  }
  for (const entry of offered.sort((a, b) => a.order - b.order)) {
    if (byIndex.has(entry.index)) off.push(entry.key);
    else byIndex.set(entry.index, { key: entry.key, index: entry.index, sentence: 0, picture: entry.picture, moved: true });
  }
  // A mark at a sentence another picture already holds — a block's own at its first word, or a
  // mark that has not moved — is lost; the rest stand beside the block's own picture.
  const bySlot = new Map<string, PlacedPicture>([...byIndex.values()].map((entry) => [`${entry.index}:0`, entry]));
  for (const mark of marks.sort((a, b) => Number(a.moved) - Number(b.moved))) {
    const slot = `${mark.index}:${mark.sentence}`;
    if (bySlot.has(slot)) lost.push(mark.key);
    else bySlot.set(slot, mark);
  }
  return { placed: [...bySlot.values()].sort((a, b) => a.index - b.index || a.sentence - b.sentence), lost, off };
}

/**
 * The key a placed picture is named by now (design turn 237): its block's key for a picture at the
 * block's first word, else the mark's key as its block now names it — what every command takes.
 */
export function placedKey(blocks: readonly Pick<ListeningInputBlock, "key" | "text">[], placed: Pick<PlacedPicture, "index" | "sentence">): string {
  const block = blocks[placed.index]!;
  return placed.sentence > 0 ? pictureMarkKey(block.key, sentenceHashes(block.text)[placed.sentence]!) : block.key;
}

/**
 * The pictures after a change of the chapter's blocks — a Join, a Split, grouping by beats — with
 * every picture the change would take off its own first words (design turn 237, R-203) filed
 * instead as a mark at that first sentence, inside the block that now holds it. Under 198 a join
 * took a later block's picture off (rule 6), or showed it at the join's start when the first block
 * had none; blocks are the narration's alone now, and neither moves a picture. A picture that did
 * not stand at its own words before the change is left as it is (call 5). Null when nothing changes.
 */
export function picturesKeptOnJoin(
  before: readonly Pick<ListeningInputBlock, "key" | "text" | "starts">[],
  after: readonly Pick<ListeningInputBlock, "key" | "text" | "starts">[],
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
): Record<string, AudiobookPicture> | null {
  if (pictures === undefined) return null;
  const was = placePictures(before, pictures);
  const now = placePictures(after, pictures);
  const next: Record<string, AudiobookPicture> = { ...pictures };
  const filled = new Set(now.placed.map((entry) => `${entry.index}:${entry.sentence}`));
  let changed = false;
  for (const entry of was.placed) {
    // Only a picture at a block's first word, standing on its own block's words, is the join's to keep.
    if (entry.sentence !== 0 || entry.moved || entry.picture.mark !== undefined) continue;
    const first = sentenceHashes(before[entry.index]!.text)[0];
    if (first === undefined) continue;
    const standing = now.placed.find((candidate) => candidate.key === entry.key);
    if (standing !== undefined && sentenceHashes(after[standing.index]!.text)[standing.sentence] === first) continue;
    // The block the join folded it into names it among the blocks it starts; else the one that says its words.
    const joined = after.findIndex((block) => block.starts?.includes(entry.key) === true && sentenceHashes(block.text).includes(first));
    const holding = joined >= 0 ? joined : after.findIndex((block) => sentenceHashes(block.text).includes(first));
    if (holding < 0) continue;
    const sentence = sentenceHashes(after[holding]!.text).indexOf(first);
    if (sentence === 0) continue;
    if (standing !== undefined) filled.delete(`${standing.index}:${standing.sentence}`);
    if (filled.has(`${holding}:${sentence}`)) continue;
    filled.add(`${holding}:${sentence}`);
    delete next[entry.key];
    next[pictureMarkKey(after[holding]!.key, first)] = { ...entry.picture, textHash: audiobookTextHash(after[holding]!.text), mark: { sentence: first } };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Where a picture key stands in the chapter now (design turn 237, R-202): a block's key names the
 * picture at its first word, a mark's key its sentence. Null when the block, or the sentence, is
 * no longer there. `placed` is whatever picture stands at that place, under whichever key it is
 * kept — the one a Remove, a focus or a Tall acts on. A mark's key at its block's first sentence
 * is that block's own place.
 */
export function pictureSlot(
  blocks: readonly Pick<ListeningInputBlock, "key" | "text" | "starts">[],
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  key: string,
  usable?: (file: string) => boolean,
): { index: number; sentence: number; placed: PlacedPicture | undefined } | null {
  const parts = pictureKeyParts(key);
  const index = blocks.findIndex((block) => block.key === parts.block);
  if (index < 0) return null;
  const sentence = parts.sentence === undefined ? 0 : sentenceHashes(blocks[index]!.text).indexOf(parts.sentence);
  if (sentence < 0) return null;
  return { index, sentence, placed: placePictures(blocks, pictures, usable).placed.find((entry) => entry.index === index && entry.sentence === sentence) };
}

/**
 * A picture's words (design turn 237, R-205): from the sentence it stands at to the next picture in
 * its block, or the block's end — the moment it shows, which its brief starts from — with the
 * block's words either side of them. Null when its place is no longer in the chapter.
 */
export function pictureWords(
  blocks: readonly Pick<ListeningInputBlock, "key" | "text" | "starts">[],
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  key: string,
): { text: string; before?: string; after?: string } | null {
  const slot = pictureSlot(blocks, pictures, key);
  if (slot === null) return null;
  const sentences = sentencesOf(blocks[slot.index]!.text);
  const next = Math.min(sentences.length, ...placePictures(blocks, pictures).placed.filter((entry) => entry.index === slot.index && entry.sentence > slot.sentence).map((entry) => entry.sentence));
  const before = sentences.slice(0, slot.sentence).join(" ");
  const after = sentences.slice(next).join(" ");
  return { text: sentences.slice(slot.sentence, next).join(" "), ...(before !== "" ? { before } : {}), ...(after !== "" ? { after } : {}) };
}

/**
 * A block's sentences, at sentence ends; a text with none is one sentence. What closes after the
 * stop stays with it — a quote, a bracket, emphasis's `*` or `_` — or the next sentence, and the
 * mark set at it (design turn 237), would open on a stray `**`.
 */
export function sentencesOf(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return [];
  const parts = flat.match(/[^.!?…]+(?:[.!?…]+["'”’)\]*_]*|$)/g) ?? [flat];
  const kept = parts.map((part) => part.trim()).filter((part) => part !== "");
  return kept.length > 0 ? kept : [flat];
}

/**
 * Text's source intervals (R-70), from the block's start: a grouped take's sentences, each
 * given its share of the take by its length — the split kept no word times past the cut — and a
 * block read alone whole, for its length. The shared player divides either into bounded phrases.
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
 * take starts. A mark inside a block (design turn 237) starts `within` its block's start; it
 * holds until the next, however soon (R-207).
 */
export function pictureHolds(placed: readonly PlacedPicture[], starts: readonly number[], end: number, within: (entry: PlacedPicture) => number = () => 0): Array<PlacedPicture & { at: number; seconds: number }> {
  const ats = placed.map((entry) => Math.min(end, (starts[entry.index] ?? end) + (entry.sentence > 0 ? within(entry) : 0)));
  return placed.map((entry, index) => {
    const at = ats[index]!;
    const until = ats[index + 1] ?? end;
    return { ...entry, at: round(at), seconds: Math.max(0, round(until - at)) };
  });
}

/**
 * The marks of a chapter moved from their estimate to the moment their first word is spoken
 * (design turn 237, R-204), once the blocks carry their validated words on the chapter's clock
 * (R-70's acoustic words). Each picture's hold is then counted again to the next.
 */
export function retimePictureMarks(chapter: ListeningChapter): void {
  let moved = false;
  for (const picture of chapter.pictures) {
    if (picture.word === undefined) continue;
    const block = chapter.blocks.find((candidate) => candidate.key === picture.key);
    const words: readonly AcousticWord[] | undefined = block?.words;
    const spoken = words?.[picture.word];
    // The word at that place must be the mark's own: a head trim drops words from the front of
    // the list, and a picture put on the wrong word is worse than one left on its estimate.
    const authored = (block?.sentences ?? []).map((sentence) => sentence.text).join(" ").trim().split(/\s+/).filter((token) => timingWord(token) !== "");
    if (spoken === undefined || words?.length !== authored.length || timingWord(spoken.text) !== timingWord(authored[picture.word] ?? "")) continue;
    picture.at = round(spoken.startSec);
    moved = true;
  }
  if (!moved) return;
  chapter.pictures.sort((a, b) => a.at - b.at);
  chapter.pictures.forEach((picture, index) => {
    picture.seconds = Math.max(0, round((chapter.pictures[index + 1]?.at ?? chapter.seconds) - picture.at));
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
  /** Each block's length on the clock, 0 for one not made: a mark's estimate is its share of it. */
  const lengths: number[] = [];
  let clock = 0;
  const timedAt = new Map((input.timed?.bars ?? []).map((bar) => [bar.key, bar]));
  input.blocks.forEach((block, index) => {
    const number = index + 1;
    const bar = timedAt.get(block.key);
    // On the timed clock a block not made stands where the next made one starts: the mix skips it.
    if (input.timed !== undefined) clock = bar?.at ?? input.blocks.slice(index + 1).map((later) => timedAt.get(later.key)?.at).find((at) => at !== undefined) ?? input.timed.seconds;
    starts.push(round(clock));
    lengths.push(0);
    if (block.take === undefined || !(block.take.seconds > 0) || (input.timed !== undefined && bar === undefined)) {
      const open = gaps[gaps.length - 1];
      if (open !== undefined && open.to === number - 1) open.to = number;
      else gaps.push({ at: round(clock), from: number, to: number });
      return;
    }
    const length = bar?.seconds ?? block.take.seconds;
    lengths[index] = length;
    const sentences = blockSentences(block.text, length, block.take.grouped).map((sentence) => ({ at: round(clock + sentence.at), text: sentence.text }));
    blocks.push({ key: block.key, number, file: block.take.file, ...(block.take.artifactId !== undefined ? { artifactId: block.take.artifactId } : {}), at: round(clock), seconds: length, sentences });
    clock += length;
  });
  const seconds = input.timed !== undefined ? round(input.timed.mix.seconds) : round(clock);
  const { placed } = placePictures(input.blocks, input.pictures, input.usable);
  // A mark inside a block starts at its words' share of the take until the take is timed
  // (design turn 237, R-204); `retimePictureMarks` then puts it on its first word.
  const starting = (entry: PlacedPicture) => sentenceStart(input.blocks[entry.index]!.text, entry.sentence);
  const pictures = pictureHolds(placed, starts, seconds, (entry) => starting(entry).share * (lengths[entry.index] ?? 0)).map((entry) => ({
    key: input.blocks[entry.index]!.key,
    number: entry.index + 1,
    file: entry.picture.file,
    at: entry.at,
    seconds: entry.seconds,
    ...(entry.sentence > 0 ? { word: starting(entry).word } : {}),
    ...(entry.picture.focus !== undefined ? { focus: entry.picture.focus } : {}),
    ...(entry.picture.motion?.active === true ? { motion: entry.picture.motion } : {}),
    // A Tall whose file is gone is left out, as a picture's own is (placePictures): the phone then
    // shows the Wide one, which is what a package without one does.
    ...(entry.picture.tall !== undefined && (input.usable?.(entry.picture.tall.file) ?? true) ? { tall: entry.picture.tall.file, ...(tallFromEarlier(entry.picture) ? { tallEarlier: true as const } : {}) } : {}),
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
  blocks: ReadonlyArray<
    Pick<ListeningInputBlock, "key" | "text" | "starts"> & {
      seconds: number | null;
      /** Where each of the take's words starts, from its word timing when that is current (design turn 237, R-204). */
      words?: readonly number[];
    }
  >,
  pictures: Readonly<Record<string, AudiobookPicture>> | undefined,
  usable?: (file: string) => boolean,
): { spans: Array<PlacedPicture & { at: number; seconds: number; until: number | null; startEstimated: boolean }>; lost: string[]; estimated: boolean } {
  const starts: number[] = [];
  const lengths: number[] = [];
  /** Whether each block's start leans on an estimate: some block before it had no measured length. */
  const guessed: boolean[] = [];
  let clock = 0;
  let estimated = false;
  for (const block of blocks) {
    starts.push(round(clock));
    guessed.push(estimated);
    const length = block.seconds !== null && block.seconds > 0 ? block.seconds : block.text.length / ESTIMATED_CHARACTERS_PER_SECOND;
    lengths.push(length);
    if (!(block.seconds !== null && block.seconds > 0)) estimated = true;
    clock += length;
  }
  const { placed, lost } = placePictures(blocks, pictures, usable);
  // A mark inside a block starts on its first word when the take is timed, else at its words'
  // share of the block and said to be estimated (design turn 237, R-204).
  const timedAt = (entry: PlacedPicture): number | undefined => {
    const block = blocks[entry.index]!;
    return block.seconds !== null && block.seconds > 0 ? block.words?.[sentenceStart(block.text, entry.sentence).word] : undefined;
  };
  const held = pictureHolds(placed, starts, round(clock), (entry) => timedAt(entry) ?? sentenceStart(blocks[entry.index]!.text, entry.sentence).share * lengths[entry.index]!);
  return {
    spans: held.map((entry, index) => ({ ...entry, until: held[index + 1]?.index ?? null, startEstimated: (guessed[entry.index] ?? estimated) || (entry.sentence > 0 && timedAt(entry) === undefined) })),
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
