import { z } from "zod";
import type { ListeningChapter } from "./audiobook-listening.js";
import { IsoDateTimeSchema } from "./ids.js";

/**
 * The audiobook's opening and closing credits (design turn 252, SPEC-047 R-210 – R-218). ACX asks
 * that the opening name the title, the author and the narrator, and that the closing say the book
 * is over. They are two short readings at the ends of the book, not chapters: they carry no
 * number and no pictures, and the chapter count and the book's length leave them out.
 *
 * They are read as a chapter is, under a reserved id: the run plans the two as the blocks of a
 * chapter of their own, so they are read together in one grouped request and their words are
 * checked (design turn 185), and their takes are filed as a block's (`chapterId` names
 * `audiobook-credits`, `block` the credit), as an audio drama's episode takes name their script.
 */
export const AUDIOBOOK_CREDITS_ID = "audiobook-credits";
export const AUDIOBOOK_CREDIT_KEYS = ["opening", "closing"] as const;
export type AudiobookCreditKey = (typeof AUDIOBOOK_CREDIT_KEYS)[number];

const CREDIT_DETAIL_MAX = 200;
/** Longer than any credit ACX describes; a credit is a sentence or two, never a passage. */
export const CREDIT_WORDS_MAX = 1200;

/**
 * The four details the credits are drafted from (R-211). Each is absent until the author sets it,
 * and an absent one is drafted from the book: the production's title, the author Publish last
 * named, the narrator's voice by its name, and the year with the author. The narrator is the name
 * the author gives the narration (R-213); the credits never describe how the voice was made, as
 * the owner asked on 31 October 2026. An empty `copyright` is the author's choice of none.
 */
export const AudiobookCreditDetailsSchema = z
  .object({
    title: z.string().max(CREDIT_DETAIL_MAX).optional(),
    author: z.string().max(CREDIT_DETAIL_MAX).optional(),
    narrator: z.string().max(CREDIT_DETAIL_MAX).optional(),
    copyright: z.string().max(CREDIT_DETAIL_MAX).optional(),
  })
  .strict();
export type AudiobookCreditDetails = z.infer<typeof AudiobookCreditDetailsSchema>;

/**
 * `.audiobook/credits.json` (R-215): the details and the words the author wrote over a draft. The
 * takes and their flags are the credits' reading record, beside the chapters' (`AUDIOBOOK_CREDITS_ID`).
 */
export const AudiobookCreditsSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: IsoDateTimeSchema,
    details: AudiobookCreditDetailsSchema.default({}),
    words: z
      .object({
        opening: z.string().trim().min(1).max(CREDIT_WORDS_MAX).optional(),
        closing: z.string().trim().min(1).max(CREDIT_WORDS_MAX).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type AudiobookCredits = z.infer<typeof AudiobookCreditsSchema>;

/** The details as the credits read them, every one resolved. */
export interface AudiobookCreditFacts {
  title: string;
  author: string;
  narrator: string;
  /** What follows "Copyright": the year and the holder. Empty is none. */
  copyright: string;
}

/** What the book draws its details from where the author set none. */
export interface AudiobookCreditDefaults {
  title: string;
  author: string;
  /** The book narrator's voice by its display name, when the reader names one. */
  voiceLabel: string | null;
  year: number;
}

export function audiobookCreditFacts(details: AudiobookCreditDetails, defaults: AudiobookCreditDefaults): AudiobookCreditFacts {
  const title = (details.title ?? defaults.title).trim();
  const author = (details.author ?? defaults.author).trim();
  const narrator = (details.narrator ?? defaults.voiceLabel ?? "").trim();
  const copyright = (details.copyright ?? (author === "" ? "" : `${defaults.year} ${author}`)).trim();
  return { title, author, narrator, copyright };
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * A credit drafted from the details (R-211), in ACX's own shape: the opening names the title, the
 * author and the narrator; the closing says the same as finished and ends `The End.` An empty
 * detail drops its clause rather than leaving a gap the reader would speak.
 */
export function draftAudiobookCredit(key: AudiobookCreditKey, facts: AudiobookCreditFacts): string {
  const title = facts.title === "" ? "This audiobook" : facts.title;
  if (key === "opening") {
    return [sentence(title), ...(facts.author !== "" ? [`Written by ${facts.author}.`] : []), ...(facts.narrator !== "" ? [`Narrated by ${facts.narrator}.`] : [])].join(" ");
  }
  const heard = `You have been listening to ${facts.title === "" ? "this audiobook" : facts.title}${facts.author !== "" ? `, written by ${facts.author}` : ""}${facts.narrator !== "" ? `, narrated by ${facts.narrator}` : ""}.`;
  return [heard, ...(facts.copyright !== "" ? [`Copyright ${sentence(facts.copyright)}`] : []), "The End."].join(" ");
}

/** A credit's words: the author's where they wrote over the draft, else the draft. */
export function audiobookCreditWords(credits: AudiobookCredits | null, key: AudiobookCreditKey, facts: AudiobookCreditFacts): { words: string; edited: boolean } {
  const own = credits?.words[key];
  return own !== undefined ? { words: own, edited: true } : { words: draftAudiobookCredit(key, facts), edited: false };
}

export type AudiobookCreditName = "title" | "author" | "narrator";

/**
 * The names a credit's words do not carry (R-212). A title or author that is not set cannot be
 * dropped; a narrator always can, since ACX asks every credit to name one. Matched loosely, as a
 * reader would hear it.
 */
export function audiobookCreditMissing(words: string, facts: AudiobookCreditFacts): AudiobookCreditName[] {
  const fold = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const heard = ` ${fold(words)} `;
  const has = (name: string) => fold(name) === "" || heard.includes(` ${fold(name)} `);
  return [
    ...(facts.title !== "" && !has(facts.title) ? (["title"] as const) : []),
    ...(facts.author !== "" && !has(facts.author) ? (["author"] as const) : []),
    ...(facts.narrator === "" || !has(facts.narrator) ? (["narrator"] as const) : []),
  ];
}

/** The warning on a credit's label and row (R-212): `names no narrator`, `names no title or author`. */
export function audiobookCreditWarning(missing: readonly AudiobookCreditName[]): string | null {
  if (missing.length === 0) return null;
  const names = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]!}`;
  return `names no ${names}`;
}

/** One credit as the page and the Credits sheet draw it. */
export const AudiobookCreditViewSchema = z
  .object({
    words: z.string(),
    edited: z.boolean(),
    missing: z.array(z.enum(["title", "author", "narrator"])),
    state: z.enum(["made", "stale", "not made", "flagged"]),
    /** The take's length, once made. */
    seconds: z.number().min(0).optional(),
    artifactId: z.string().min(1).optional(),
    /** The take's file, world-relative, for Hear. */
    file: z.string().min(1).optional(),
    /** The flag's reason, when the read came back not matching its words. */
    flag: z.string().optional(),
  })
  .strict();
export type AudiobookCreditView = z.infer<typeof AudiobookCreditViewSchema>;

export const AudiobookCreditsViewSchema = z
  .object({
    details: z
      .object({
        title: z.string(),
        author: z.string(),
        narrator: z.string(),
        copyright: z.string(),
      })
      .strict(),
    /** The book narrator's voice by name, which Narrated by is drafted from; null when the reader names none. */
    voiceLabel: z.string().nullable(),
    opening: AudiobookCreditViewSchema,
    closing: AudiobookCreditViewSchema,
  })
  .strict();
export type AudiobookCreditsView = z.infer<typeof AudiobookCreditsViewSchema>;

/** A credit made and current, as the exports take it: its words and its take's file and length. */
export interface MadeAudiobookCredit {
  key: AudiobookCreditKey;
  text: string;
  /** World-relative, `artifacts/…`. */
  file: string;
  seconds: number;
  artifactId: string;
}

/** The credit audio a chapter of an edition carries around its own, world-relative. */
export interface CreditAudio {
  before?: string;
  after?: string;
}

/**
 * The credits folded into an edition's first and last chapters (SPEC-047 R-218, SPEC-058 R-94):
 * the opening plays before the first chapter's spoken heading and the closing after the last
 * chapter's final words, each its own block over the book's cover, every other block, sentence,
 * word, gap and picture of the chapter moved by the credit's length. No new kind of entry: a
 * package reads as before, and every installed Player plays the credits. The chapter's mix is left
 * as it is; `audio` says which credit files sit around it, for the file the chapter plays.
 */
export function foldAudiobookCredits(
  chapters: readonly ListeningChapter[],
  credits: Partial<Record<AudiobookCreditKey, MadeAudiobookCredit>>,
  cover: string | null,
): { chapters: ListeningChapter[]; audio: Map<string, CreditAudio> } {
  const audio = new Map<string, CreditAudio>();
  if (chapters.length === 0) return { chapters: [...chapters], audio };
  const folded = [...chapters];
  const opening = credits.opening;
  if (opening !== undefined) {
    const chapter = folded[0]!;
    const by = opening.seconds;
    const shifted = shiftChapter(chapter, by);
    folded[0] = {
      ...shifted,
      seconds: chapter.seconds + by,
      blocks: [creditBlock(opening, 0, 1), ...shifted.blocks.map((block) => ({ ...block, number: block.number + 1 }))],
      pictures: cover === null ? shifted.pictures : [coverPicture("credits-opening", cover, 0, by), ...shifted.pictures.map((picture) => ({ ...picture, number: picture.number + 1 }))],
    };
    audio.set(chapter.chapterId, { before: opening.file });
  }
  const closing = credits.closing;
  if (closing !== undefined) {
    const index = folded.length - 1;
    const chapter = folded[index]!;
    const at = chapter.seconds;
    folded[index] = {
      ...chapter,
      seconds: chapter.seconds + closing.seconds,
      blocks: [...chapter.blocks, creditBlock(closing, at, chapter.blocks.length + 1)],
      pictures: cover === null ? chapter.pictures : [...chapter.pictures, coverPicture("credits-closing", cover, at, closing.seconds, chapter.pictures.length + 1)],
    };
    audio.set(chapter.chapterId, { ...audio.get(chapter.chapterId), after: closing.file });
  }
  return { chapters: folded, audio };
}

function creditBlock(credit: MadeAudiobookCredit, at: number, number: number): ListeningChapter["blocks"][number] {
  return { key: credit.key, number, file: credit.file, artifactId: credit.artifactId, at, seconds: credit.seconds, sentences: [{ at, text: credit.text }] };
}

function coverPicture(key: string, file: string, at: number, seconds: number, number = 1): ListeningChapter["pictures"][number] {
  return { key, number, file, at, seconds };
}

function shiftChapter(chapter: ListeningChapter, by: number): ListeningChapter {
  return {
    ...chapter,
    blocks: chapter.blocks.map((block) => ({
      ...block,
      at: block.at + by,
      sentences: block.sentences.map((sentence) => ({ ...sentence, at: sentence.at + by })),
      ...(block.words !== undefined ? { words: block.words.map((word) => ({ ...word, startSec: word.startSec + by, endSec: word.endSec + by })) } : {}),
    })),
    gaps: chapter.gaps.map((gap) => ({ ...gap, at: gap.at + by })),
    pictures: chapter.pictures.map((picture) => ({ ...picture, at: picture.at + by })),
  };
}
