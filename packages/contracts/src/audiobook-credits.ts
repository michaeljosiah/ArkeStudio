import { z } from "zod";
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
