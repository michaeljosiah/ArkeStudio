import {
  AUDIOBOOK_CREDIT_KEYS,
  AUDIOBOOK_CREDITS_ID,
  audiobookCreditFacts,
  audiobookCreditMissing,
  audiobookCreditWords,
  type AudiobookCreditKey,
  type AudiobookCreditView,
  type AudiobookCreditsView,
  type AudiobookReader,
  type ListeningChapter,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audiobookCreditDefaults, planAudiobook, readAudiobookCredits, updateAudiobookCredits } from "./audiobook.js";
import { listeningBlocks } from "./audiobook-listening.js";

/**
 * The credits as the page and the Credits sheet draw them (design turn 252, SPEC-047 R-210 – R-213):
 * each credit's words, whether the author wrote them, the names they no longer carry, and its state
 * and length as the run's own plan of the credits reads them.
 */
export async function audiobookCreditsView(store: WorldStore, productionId: string, narrator: AudiobookReader): Promise<AudiobookCreditsView> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const read = await readAudiobookCredits(store, productionId);
  const credits = read === "unreadable" ? null : read;
  const defaults = audiobookCreditDefaults(production, narrator);
  const facts = audiobookCreditFacts(credits?.details ?? {}, defaults);
  const plan = await planAudiobook(store, productionId, AUDIOBOOK_CREDITS_ID, { narrator });
  const blocks = listeningBlocks(store, plan);
  const record = plan.record === "unreadable" ? null : plan.record;
  const view = (key: AudiobookCreditKey): AudiobookCreditView => {
    const { words, edited } = audiobookCreditWords(credits, key, facts);
    const planned = plan.blocks.find((block) => block.block.key === key);
    const take = blocks.find((block) => block.key === key)?.take;
    const flag = record?.flags[key];
    const state = planned === undefined || planned.state === "awaiting" ? "not made" : planned.state;
    return {
      words,
      edited,
      missing: audiobookCreditMissing(words, facts),
      state,
      ...(take !== undefined ? { seconds: take.seconds, file: take.file, ...(take.artifactId !== undefined ? { artifactId: take.artifactId } : {}) } : {}),
      ...(state === "flagged" && flag !== undefined ? { flag: flag.reason } : {}),
    };
  };
  return {
    details: { title: facts.title, author: facts.author, narrator: facts.narrator, copyright: facts.copyright },
    voiceLabel: defaults.voiceLabel,
    opening: view("opening"),
    closing: view("closing"),
  };
}

/** A credit made and current, as the exports take it: its words and its take's file and length. */
export interface MadeAudiobookCredit {
  key: AudiobookCreditKey;
  text: string;
  /** World-relative, `artifacts/…`. */
  file: string;
  seconds: number;
  artifactId: string;
}

/**
 * The credits an edition carries (R-216 – R-218, SPEC-058 R-94): those made and saying their words
 * now, by key. A credit not read, or read under words since changed, is left out, and its edition
 * goes without it rather than waiting for it.
 */
export async function madeAudiobookCredits(store: WorldStore, productionId: string, narrator: AudiobookReader): Promise<Partial<Record<AudiobookCreditKey, MadeAudiobookCredit>>> {
  const plan = await planAudiobook(store, productionId, AUDIOBOOK_CREDITS_ID, { narrator });
  const made: Partial<Record<AudiobookCreditKey, MadeAudiobookCredit>> = {};
  for (const block of listeningBlocks(store, plan)) {
    const key = AUDIOBOOK_CREDIT_KEYS.find((candidate) => candidate === block.key);
    if (key === undefined || block.take?.artifactId === undefined) continue;
    made[key] = { key, text: block.text, file: block.take.file, seconds: block.take.seconds, artifactId: block.take.artifactId };
  }
  return made;
}

/**
 * Written by, drafted from the author Publish names (R-211), into the credits themselves the first
 * time they are opened, set or read. The run, the view and every export then read one author from
 * one file; looking Publish up in each would let a credit drafted one way be checked another. An
 * author the credits already hold, even an empty one, is the author's own and is never replaced.
 */
export async function adoptPublishedAuthor(store: WorldStore, productionId: string, author: string | undefined, now: () => string): Promise<void> {
  const named = author?.trim() ?? "";
  if (named === "") return;
  await updateAudiobookCredits(
    store,
    productionId,
    (current) => (current?.details.author !== undefined ? null : { details: { ...current?.details, author: named }, words: current?.words ?? {} }),
    now,
  );
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
