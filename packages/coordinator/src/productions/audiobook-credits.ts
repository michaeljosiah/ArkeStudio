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
  type MadeAudiobookCredit,
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
