import { z } from "zod";
import {
  ESTIMATED_CHARACTERS_PER_SECOND,
  PICTURE_PROPOSAL_GAP_SEC,
  PICTURE_TITLE_MAX,
  PictureReasonSchema,
  audiobookTextHash,
  bookPictureShapes,
  chapterLookDisagreement,
  kitLookLibrary,
  lookLinesFor,
  makesShape,
  normalizeSpeechText,
  ownLookPicks,
  pictureCap,
  pictureLookFor,
  pictureMarkKey,
  pictureWords,
  placePictures,
  pictureStarts,
  ridingPicks,
  sentenceHashes,
  sentenceStart,
  sentencesOf,
  thinPictures,
  type HarnessAdapter,
  type IllustrationProposal,
  type IllustrationRow,
  type ManifestModel,
  type PictureReason,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { referenceBudgetFor } from "../references/generate.js";
import type { WorldStore } from "../world/store.js";
import { clip } from "./audiobook-direction.js";
import { listeningBlocks } from "./audiobook-listening.js";
import { blockSpeakers, type ChapterPerson } from "./audiobook-look.js";
import { makeAdapterJsonDeriver } from "./continuity.js";
import { BRIEF_EXAMPLES, briefGiven, briefRiders, briefRules, holdBrief, pictureChecks, type BriefLine } from "./audiobook-picture-brief.js";
import { briefLines, clipPrompt, depictable, neutralWhereLooksRide, ownLooksThatRide, pictureAspect, pictureQuote, pictureWho, promptRoom, type PictureRoom } from "./audiobook-picture-suggest.js";
import { chapterReferenceCoverage } from "./audiobook-reference-coverage.js";
import { ownLookChanges, rewritePictureClothing, type PromptRewriter } from "./audiobook-picture-rewrite.js";

/**
 * Illustrate this chapter (design turn 191b, SPEC-047 R-101): the writing service reads the
 * chapter on its clock, its people and places, their look and the book's art direction, and says
 * where pictures go and what each shows. Everything that makes a proposal a proposal is then
 * held mechanically, whatever it said: never on a sentence that has a picture, never closer than
 * five seconds to another, at most one per twenty seconds of speech, and each row's references and
 * price the coordinator's own. Nothing is made or spent by reading.
 *
 * Design turn 237 (R-206, R-207): the chapter is given sentence by sentence, and a picture can start
 * at any of them — inside a beat read as one take as well as at its start — wherever what we would
 * see changes, each with its reason. The cap is a ceiling, never a pace to fill.
 */

const RawIllustrationSchema = z.object({
  pictures: z.array(
    z.object({
      /** The sentence the picture starts at, as listed: `<block key>#<n>`. */
      at: z.string().optional(),
      /** The block, from a model that answered as before turn 237: its first sentence. */
      block: z.string().optional(),
      reason: z.string().nullable().optional(),
      title: z.string().optional(),
      prompt: z.string(),
      who: z.array(z.string()).nullable().optional(),
      place: z.string().nullable().optional(),
      // The brief's answer for each picture (design turn 193k): read as Suggest picture reads it.
      frame: z.string().nullable().optional(),
      inFrame: z.array(z.string()).nullable().optional(),
      expressions: z.record(z.string(), z.string()).nullable().optional(),
      details: z.array(z.object({ of: z.string(), part: z.string().optional(), state: z.string().optional() })).nullable().optional(),
      notInFrame: z.array(z.string()).nullable().optional(),
    }),
  ),
  summary: z.string().optional(),
});
export type RawIllustration = z.infer<typeof RawIllustrationSchema>;

export interface IllustrateDeriverInput {
  title: string;
  /** The end of the chapter's clock, including the final picture's hold. */
  seconds: number;
  /** Sentence positions remain estimates even when every take has a recorded length. */
  estimated: boolean;
  /** The chapter's Mood line: light, colour and grain only (design turn 193, rule 9). */
  mood?: string;
  synopsis?: string;
  /** The chapter on its clock: each block by key with its start in seconds, and its sentences, each with its id and start (design turn 237). */
  blocks: ReadonlyArray<{ key: string; at: number; text: string; speaker?: string; sentences?: ReadonlyArray<{ id: string; at: number; text: string }> }>;
  /** The chapter's reading note (193k, rule 5). */
  note?: string;
  lines: readonly BriefLine[];
  people: ReadonlyArray<Pick<ChapterPerson, "key" | "name" | "appearance" | "essence" | "aliases" | "identity" | "pov">>;
  places: ReadonlyArray<{ key: string; name: string; look?: string }>;
  never: readonly string[];
  /** Where a picture already stands, in seconds: kept clear of. */
  standing: readonly number[];
  cap: number;
  maxChars: number;
}
export type IllustrateDeriver = (input: IllustrateDeriverInput, signal?: AbortSignal) => Promise<RawIllustration>;

const mmss = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function buildIllustratePrompt(input: IllustrateDeriverInput, retryNote?: string): string {
  const total = input.blocks.reduce((sum, block) => sum + block.text.length + block.key.length + 12 + (block.sentences?.length ?? 0) * 18, 0);
  const cut = total > 60_000;
  // Each block under its key, then its sentences one a line, each with the id a picture names and
  // its start (design turn 237): a picture can start at any of them.
  const blocks = input.blocks.map((block) => {
    const head = `[${block.key}] ${mmss(block.at)}${block.speaker !== undefined ? ` ${block.speaker}` : ""}`;
    const sentences = block.sentences ?? [{ id: `${block.key}#0`, at: block.at, text: block.text }];
    return [head, ...sentences.map((sentence) => `  ${sentence.id} ${mmss(sentence.at)} ${cut ? (clip(sentence.text, 200) ?? "") : sentence.text}`)].join("\n");
  }).join("\n\n");
  return `Choose where pictures go in the audiobook chapter below, and write each one's prompt. Each picture is shown from the sentence it starts at until the next picture: a still taken from those words, what they describe, seen by one camera. Answer with ONLY this JSON object:
{"pictures": [{"at": "<the id of the sentence the picture starts at, as listed: p3.0#2>", "reason": "<place | arrives | leaves | action | object | time | feeling>", "title": "<two to five words naming it>", "frame": "<shot size and subject>", "inFrame": ["<key>", ...], "expressions": {"<key>": "<expression and gaze, in the words the prompt uses>"}, "details": [{"of": "<key>", "part": "<hands | forearm | ...>", "state": "<ease or tension>"}], "notInFrame": ["<key>", ...], "place": "<place key, or null>", "prompt": "<the picture>"}], "summary": "<one sentence on how you chose>"}

WHERE THE PICTURES GO. The cap, spacing and occupied sentences are enforced mechanically after you answer.
- A picture goes wherever what we would see changes: a new place (place), someone arriving (arrives) or leaving (leaves), an action, an object that matters (object), a jump in time (time), a change of feeling (feeling). Name that reason in "reason".
- It can start at any sentence, inside a block as well as at its start: a long block that moves from one thing to another can have several.
- Choose meaningful coverage rather than a fixed count or regular slideshow. In a long conversation, a reaction, gesture, consequential object or change in emotional power may warrant a new picture even without a change of place. Never invent an event just to fill time.
- At most ${input.cap} pictures, in reading order. That is a ceiling, never an aim.
- Pictures are at least ${PICTURE_PROPOSAL_GAP_SEC} seconds apart, and at least that from the ones that already stand${input.standing.length > 0 ? ` (at ${input.standing.map(mmss).join(", ")})` : ""}. A sentence with a picture on it is left alone.

REVIEW THE HOLDS BEFORE ANSWERING. The chapter ends at ${mmss(input.seconds)} (${input.estimated ? "estimated duration where narration is missing" : "recorded narration duration"}); sentence positions on this clock are estimated. Combine your proposed starts with the pictures already standing, and check every interval, including the opening and the last picture through the chapter's end. An average or total count can conceal a long static stretch.
- Infer the story's tone and the passage's pace from the words and reading note. As an editorial starting point, consider 30–60 seconds for a still; review every hold over 75 seconds and either add a meaningful view or retain it deliberately. These are review guides, not enforced limits or a quota.
- Follow changing action in adventure; preserve setup and reveal in mystery and horror; allow anticipation and deliberate stillness in suspense; follow emotional turns in romance and drama; preserve the setup and timing of comedy; allow a clear tableau to breathe in contemplative writing. Let the actual passage override genre shorthand. Never show a discovery before its words reveal it.
- Vary establishing views, character reactions and relevant details when the text supports them. A new angle must add meaning; a near duplicate does not solve a long hold. Do not assume camera movement, animation or portrait variants provide a new story moment.
- Use the summary to explain the pacing choice and identify any deliberately retained hold over 75 seconds. If the cap or existing placements prevent better coverage, say so rather than claiming the count proves it is sufficient.

EACH PICTURE is written to the rules below, for its own words: the sentence named in "at" and those after it until the next picture are the block the rules speak of, and the words around them are only where you are.
${briefRules(input.maxChars, input.never)}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
${BRIEF_EXAMPLES}

${briefGiven(input)}
## The chapter's sentences, by block, with their start
${blocks}`;
}

export function makeAdapterIllustrateDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): IllustrateDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawIllustrationSchema, "illustrate");
  return (input, signal) => ask((note) => buildIllustratePrompt(input, note), signal);
}

export interface ProposedIllustrations {
  proposal: Omit<IllustrationProposal, "proposalId">;
  /** Rows the model gave that the rules left out: a block that has a picture, one too near another, one past the pace. */
  dropped: number;
}

/**
 * The proposal (R-101): the deriver's pictures held to the chapter. Refuses, in one clause, a
 * chapter with nothing to read and one that has its pictures already.
 */
export async function proposeIllustrations(store: WorldStore, room: PictureRoom, model: ManifestModel, deriver: IllustrateDeriver, signal?: AbortSignal, rewrite?: PromptRewriter): Promise<ProposedIllustrations> {
  const plan = room.plan;
  if (plan.blocks.length === 0) throw new Error("nothing to illustrate · the chapter has no words");
  const inputs = listeningBlocks(store, plan);
  const clock = pictureStarts(inputs.map((block) => ({ text: block.text, seconds: block.take?.seconds ?? null })));
  const record = plan.record === "unreadable" ? null : plan.record;
  const pictures = record?.pictures ?? {};
  // Where a sentence starts on the chapter's clock: its share of its block's take, or of the block's
  // words at the reading rate before it is read (design turn 237, R-204).
  const lengthOf = (index: number) => inputs[index]!.take?.seconds ?? inputs[index]!.text.length / ESTIMATED_CHARACTERS_PER_SECOND;
  const sentenceAt = (index: number, sentence: number) => Math.round(((clock.starts[index] ?? 0) + sentenceStart(inputs[index]!.text, sentence).share * lengthOf(index)) * 10) / 10;
  // Every picture the author has set stands where its words are, at its sentence; a lost one holds
  // nothing. Their starts are what a proposal keeps clear of, and their sentences are left alone.
  const { placed } = placePictures(inputs, pictures);
  const standing = placed.map((entry) => sentenceAt(entry.index, entry.sentence));
  const occupied = new Set(placed.map((entry) => `${entry.index}:${entry.sentence}`));
  const cap = pictureCap(clock.total, placed.length);
  // The book's Tall pictures are made with each (R-208), when the model makes 9:16: priced on the row.
  const tallPrice = bookPictureShapes(plan.book).includes("tall") && makesShape(model, "9:16") ? pictureQuote(model, 1, model.limits.providerSelectedSize === true ? undefined : "9:16") : undefined;
  if (cap === 0) throw new Error("the chapter has its pictures");
  const visible = depictable(room.people);
  const sheets = store.getBundle().sheets;
  const maxChars = promptRoom(model);
  if (signal?.aborted) throw new Error("stopped");
  const raw = await deriver(
    {
      title: plan.chapter.title,
      seconds: clock.total,
      estimated: clock.estimated,
      ...(room.mood !== undefined ? { mood: room.mood } : {}),
      ...(room.synopsis !== undefined ? { synopsis: room.synopsis } : {}),
      blocks: plan.blocks.map((planned, index) => {
        const speaker = blockSpeakers(sheets, planned.block);
        const sentences = sentencesOf(planned.block.text).map((text, at) => ({ id: `${planned.block.key}#${at}`, at: sentenceAt(index, at), text: normalizeSpeechText(text) }));
        return { key: planned.block.key, at: clock.starts[index] ?? 0, text: normalizeSpeechText(planned.block.text), ...(speaker !== undefined ? { speaker } : {}), sentences };
      }),
      ...(room.note !== undefined ? { note: room.note } : {}),
      lines: briefLines(store, room.look, visible.map((person) => person.key), referenceBudgetFor(model) > 0),
      people: visible,
      places: room.places,
      never: room.people.filter((person) => person.neverDepicted).map((person) => person.name),
      standing,
      cap,
      maxChars,
    },
    signal,
  );
  if (signal?.aborted) throw new Error("stopped");
  type Candidate = { index: number; sentence: number; at: number; title: string; prompt: string; reason?: PictureReason; held: ReturnType<typeof holdBrief> };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw.pictures) {
    // A sentence by its id (`p3.0#2`); a model that named a block is taken at its first sentence.
    const named = entry.at ?? (entry.block !== undefined ? `${entry.block}#0` : "");
    const hash = named.lastIndexOf("#");
    const index = hash < 0 ? -1 : plan.blocks.findIndex((planned) => planned.block.key === named.slice(0, hash));
    const sentence = hash < 0 ? -1 : Number(named.slice(hash + 1));
    const prompt = clipPrompt(entry.prompt, maxChars);
    const slot = `${index}:${sentence}`;
    // A mark names its sentence by its words, so a sentence a block says twice can be named only
    // where it first comes: a later one would be made at the first (codex on PR 2178).
    const hashes = index < 0 ? [] : sentenceHashes(plan.blocks[index]!.block.text);
    if (index < 0 || !Number.isInteger(sentence) || sentence < 0 || sentence >= hashes.length || hashes.indexOf(hashes[sentence]!) !== sentence || seen.has(slot) || occupied.has(slot) || prompt === "") {
      dropped += 1;
      continue;
    }
    seen.add(slot);
    // Held to the chapter as Suggest picture's answer is (R-120): who is in and out of frame, expressions, details.
    const held = holdBrief(entry, { people: room.people, places: room.places, prompt, fallback: () => [] });
    const title = clip(entry.title ?? "", PICTURE_TITLE_MAX) ?? clip(prompt, 40)!;
    // A reason outside the list is dropped to none, never the row (R-206).
    const reason = PictureReasonSchema.safeParse(entry.reason?.trim().toLowerCase()).data;
    candidates.push({ index, sentence, at: sentenceAt(index, sentence), title, prompt, ...(reason !== undefined ? { reason } : {}), held });
  }  // In reading order whatever order the model gave them; then the rules.
  candidates.sort((a, b) => a.index - b.index || a.sentence - b.sentence);
  const kept = thinPictures(candidates, standing, cap);
  dropped += candidates.length - kept.length;
  const library = kitLookLibrary(store.getBundle().referenceKits, room.look);
  // The illustrator wrote every row from the chapter's looks. A row on a block held a look of its
  // own for someone in frame (design turn 193d, R-146) has that person's clothing words rewritten
  // for it, as Update prompt does; a rewrite that fails leaves the row as written, and its look
  // lines check says what the words invented.
  const rewritten = new Map<number, string>();
  // A row's picture key: its block's own at the first sentence, a mark's inside it (design turn 237).
  const keyOf = (candidate: Candidate) => {
    const planned = plan.blocks[candidate.index]!;
    return candidate.sentence > 0 ? pictureMarkKey(planned.block.key, sentenceHashes(planned.block.text)[candidate.sentence]!) : planned.block.key;
  };
  const keptKeys = kept.map((position) => keyOf(candidates[position]!));
  if (rewrite !== undefined) {
    for (const position of kept) {
      const candidate = candidates[position]!;
      const own = ownLooksThatRide(store, room.look, room.own(keyOf(candidate)));
      const changes = ownLookChanges(store, room.look, briefRiders(candidate.held).filter((person) => person.kind === "character").map((person) => person.key), own, referenceBudgetFor(model) > 0);
      if (changes.length === 0) continue;
      try {
        rewritten.set(position, await rewritePictureClothing(rewrite, candidate.held.prompt, changes, maxChars, signal));
      } catch {
        if (signal?.aborted) throw new Error("stopped");
      }
    }
  }
  const rows: IllustrationRow[] = kept.map((position) => {
    const candidate = candidates[position]!;
    const planned = plan.blocks[candidate.index]!;
    const key = keyOf(candidate);
    // Who rides is who is shown, including the owners of body details; a frame with nobody in it the
    // place; a look held on the block for its picture alone rides for that person (R-146).
    const own = ownLooksThatRide(store, room.look, room.own(key));
    const who = pictureWho(store, model, briefRiders(candidate.held), { look: room.look, frame: candidate.held.frame, own });
    // Rule 4 where a look image rides: no skin, cut or body in the words (2026-10-04).
    const held = { ...candidate.held, prompt: neutralWhereLooksRide(rewritten.get(position) ?? candidate.held.prompt, who) };
    const needs = who.filter((entry) => entry.reference === null).map((entry) => entry.name);
    // A chapter look the Looks sheet flags would dress them against the prose (issue 1658); one
    // chosen for this picture alone is the author's own call.
    const disagrees = who.filter((entry) => entry.kind === "character" && entry.only !== true && chapterLookDisagreement(room.look, entry.key).length > 0).map((entry) => entry.key);
    const picks = ridingPicks(who);
    const keys = held.inFrame.map((person) => person.key);
    const stamp = pictureLookFor(room.look, who.filter((person) => person.kind === "character").map((person) => person.key), picks, library);
    const used = lookLinesFor(room.look, [...keys, ...held.details.map((detail) => detail.of)], { ...ownLookPicks(own), ...picks }, library);
    // Checked against the picture's own words, from its sentence to the next picture, standing or
    // proposed with it (R-205): a garment the next moment brings is not this one's.
    const words = pictureWords(inputs, pictures, key, keptKeys)?.text ?? "";
    const checks = pictureChecks({ held, who, people: visible, lines: used, block: words, mood: room.mood });
    const shot = { frame: held.frame, inFrame: keys, notInFrame: held.notInFrame, expressions: held.expressions, details: held.details, checks, checkedPrompt: held.prompt };
    return {
      block: key,
      textHash: audiobookTextHash(planned.block.text),
      at: candidate.at,
      ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
      title: candidate.title,
      prompt: held.prompt,
      who,
      estimatedMicroUsd: pictureQuote(model, who.filter((entry) => entry.carried).length),
      ...(tallPrice !== undefined ? { tallMicroUsd: tallPrice } : {}),
      ...(stamp !== undefined ? { look: stamp } : {}),
      ...(needs.length > 0 ? { needs } : {}),
      ...(disagrees.length > 0 ? { disagrees } : {}),
      shot,
    };
  });
  const summary = clip(raw.summary, 300);
  return {
    proposal: {
      hash: plan.chapter.hash,
      rows,
      coverage: chapterReferenceCoverage(store, undefined, plan, rows),
      model: { provider: model.provider, id: model.id, name: model.displayName, references: referenceBudgetFor(model),
        ...(model.pricing.kind === "included-plan" ? { plan: "included-plan" as const } : {}) },
      ...(pictureAspect(model) !== undefined ? { aspect: pictureAspect(model)! } : {}),
      seconds: clock.total,
      estimated: clock.estimated,
      standing: placed.length,
      ...(summary !== undefined ? { summary } : {}),
    },
    dropped,
  };
}
