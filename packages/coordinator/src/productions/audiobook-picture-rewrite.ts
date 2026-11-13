import { z } from "zod";
import { MAIN_PHOTO_LOOK, kitLookLibrary, neutralClothing, type AudiobookLook, type HarnessAdapter, type PictureOwnLooks } from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import type { WorldStore } from "../world/store.js";
import { makeAdapterJsonDeriver } from "./continuity.js";
import { clipPrompt } from "./audiobook-picture-suggest.js";

/**
 * Update prompt (design turn 193d, rule 8; SPEC-047 R-146): a person's look for one picture is not
 * the look the prompt was written for, so their clothing words are rewritten from the look now
 * chosen. The rule is that a choice changes that person's clothing words only and the author's
 * edits elsewhere stand — and a prompt is prose, where `the oilskin coat is dark and stiff with
 * salt, hood down` cannot be found and swapped by matching the look's line, which the writing
 * service paraphrased when it drafted. So the writing service is asked to change only those words,
 * told what the prompt says now and what it should say, and every other word is its to keep.
 */

const RawRewriteSchema = z.object({ prompt: z.string() });

/** One person whose clothing words change: what the prompt was written for, and what it should now say. */
export interface ClothingChange {
  key: string;
  name: string;
  /** The words the prompt was written from; empty where it was written with none for them. */
  was: string;
  now: string;
  /** The new words are a kit look's, whose image rides: named neutrally (rule 4). */
  look: boolean;
}

export interface RewriteInput {
  prompt: string;
  changes: readonly ClothingChange[];
  maxChars: number;
}
export type PromptRewriter = (input: RewriteInput, signal?: AbortSignal) => Promise<{ prompt: string }>;

/** What the writing service is asked (R-146): the people, their old and new words, and the prompt to keep otherwise whole. */
export function buildRewritePrompt(input: RewriteInput, retryNote?: string): string {
  const people = input.changes
    .map((change) => `- ${change.name} [${change.key}]: ${change.was !== "" ? `the prompt was written for "${change.was}"` : "the prompt was written with no clothing for them"}; for this picture they wear "${change.now}".`)
    .join("\n");
  return `You edit the prompt for ONE picture in an illustrated audiobook. Only the clothes of the people below change: what they wear, carry and how their hair is done, as their look for this picture now says. Answer with ONLY this JSON object:
{"prompt": "the whole prompt, edited"}

Rules:
- Change only the words about these people's clothing, hair and what they carry. Keep every other word as it is: the frame word the prompt opens with, who is where, the action, each expression and gaze, the objects, the place and the light.
- Name each garment once, by the garment and its colour. Never name skin, how much a garment shows, its cut or the body under it.
- Where the prompt says nothing of their clothes, add them once, in a few words, where the person is first named.
- Do not add people, words of the story, a reference to an image, or anything about style.
- At most ${input.maxChars} characters.${retryNote ? `\n\nYour previous response was rejected: ${retryNote}` : ""}

## The people
${people}

## The prompt
${input.prompt}`;
}

export function makeAdapterPromptRewriter(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): PromptRewriter {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawRewriteSchema, "picture-prompt");
  return (input, signal) => ask((note) => buildRewritePrompt(input, note), signal);
}

/**
 * The words a look gives a person in a picture's prompt (R-146): a kit look's clothing line —
 * neutral where its image rides (rule 4) — or, for the main photo, what the chapter's prose says
 * they wear (the reading kept beside a chosen look, else the chapter's line). Undefined where
 * there is nothing to say: a look the kit no longer holds, or a person the chapter has no line for.
 */
export function lookWords(store: Pick<WorldStore, "getBundle">, look: AudiobookLook | null | undefined, key: string, lookId: string, carries: boolean): { text: string; look: boolean } | undefined {
  if (lookId === MAIN_PHOTO_LOOK) {
    const line = look?.characters[key];
    return line === undefined ? undefined : { text: line.reading ?? line.text, look: false };
  }
  const own = kitLookLibrary(store.getBundle().referenceKits, look)(key, lookId);
  if (own === undefined) return undefined;
  return { text: carries ? neutralClothing(own.text) : own.text, look: true };
}

/** What the chapter's choice gives a person (R-112): its look, else the main photo. */
export function chapterLookOf(look: AudiobookLook | null | undefined, key: string): string {
  return look?.characters[key]?.lookId ?? MAIN_PHOTO_LOOK;
}

/**
 * The people whose clothing words a prompt written from the chapter's choices must change for the
 * looks chosen for this picture alone (R-146), among those in frame.
 */
export function ownLookChanges(store: Pick<WorldStore, "getBundle">, look: AudiobookLook | null | undefined, keys: readonly string[], own: Readonly<PictureOwnLooks>, carries: boolean): ClothingChange[] {
  return keys.flatMap((key) => {
    const to = own[key];
    if (to === undefined) return [];
    return clothingChange(store, look, key, chapterLookOf(look, key), to, carries);
  });
}

/** One person's change, from one look to another; none where the words would not change. */
export function clothingChange(store: Pick<WorldStore, "getBundle">, look: AudiobookLook | null | undefined, key: string, from: string, to: string, carries: boolean): ClothingChange[] {
  if (from === to) return [];
  const now = lookWords(store, look, key, to, carries);
  if (now === undefined) return [];
  const was = lookWords(store, look, key, from, carries)?.text ?? "";
  if (was.replace(/\s+/g, " ").trim() === now.text.replace(/\s+/g, " ").trim()) return [];
  const sheet = look?.characters[key]?.sheet ?? key;
  const name = look?.characters[key]?.name ?? store.getBundle().sheets.find((candidate) => candidate.id === sheet)?.name ?? key;
  return [{ key, name, was, now: now.text, look: now.look }];
}

/**
 * The prompt with these people's clothing words rewritten (R-146), held to the model's room and,
 * where a look's image now rides, to rule 4 as every drafted prompt is.
 */
export async function rewritePictureClothing(rewriter: PromptRewriter, prompt: string, changes: readonly ClothingChange[], maxChars: number, signal?: AbortSignal): Promise<string> {
  if (changes.length === 0) return prompt;
  if (signal?.aborted) throw new Error("stopped");
  const raw = await rewriter({ prompt, changes, maxChars }, signal);
  if (signal?.aborted) throw new Error("stopped");
  const written = clipPrompt(raw.prompt, maxChars);
  if (written === "") throw new Error("the writing service gave no prompt");
  return changes.some((change) => change.look) ? neutralClothing(written) : written;
}
