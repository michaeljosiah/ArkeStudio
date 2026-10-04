import { z } from "zod";
import {
  PICTURE_PACE_SEC,
  PICTURE_PROPOSAL_GAP_SEC,
  PICTURE_TITLE_MAX,
  audiobookTextHash,
  lookLinesFor,
  normalizeSpeechText,
  pictureCap,
  pictureLookFor,
  placePictures,
  pictureStarts,
  ridingPicks,
  thinPictures,
  type HarnessAdapter,
  type IllustrationProposal,
  type IllustrationRow,
  type ManifestModel,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { referenceBudgetFor } from "../references/generate.js";
import type { WorldStore } from "../world/store.js";
import { clip } from "./audiobook-direction.js";
import { listeningBlocks } from "./audiobook-listening.js";
import { blockSpeakers } from "./audiobook-look.js";
import { makeAdapterJsonDeriver } from "./continuity.js";
import { BRIEF_EXAMPLES, briefGiven, briefRiders, briefRules, holdBrief, pictureChecks, type BriefLine } from "./audiobook-picture-brief.js";
import { briefLines, clipPrompt, depictable, neutralWhereLooksRide, pictureAspect, pictureQuote, pictureWho, promptRoom, type PictureRoom } from "./audiobook-picture-suggest.js";

/**
 * Illustrate this chapter (design turn 191b, SPEC-047 R-101): the writing service reads the
 * chapter on its clock, its people and places, their look and the book's art direction, and says
 * where pictures go and what each shows. Everything that makes a proposal a proposal is then
 * held mechanically, whatever it said: never on a block that has a picture, never closer than the
 * twenty seconds a picture holds to another, about one a minute and a half of speech, and each
 * row's references and price the coordinator's own. Nothing is made or spent by reading.
 */

const RawIllustrationSchema = z.object({
  pictures: z.array(
    z.object({
      block: z.string(),
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
  /** The chapter's Mood line: light, colour and grain only (design turn 193, rule 9). */
  mood?: string;
  synopsis?: string;
  /** The chapter on its clock: each block by key with its start in seconds. */
  blocks: ReadonlyArray<{ key: string; at: number; text: string; speaker?: string }>;
  /** The chapter's reading note (193k, rule 5). */
  note?: string;
  lines: readonly BriefLine[];
  people: ReadonlyArray<{ key: string; name: string; appearance?: string; essence?: string }>;
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
  const total = input.blocks.reduce((sum, block) => sum + block.text.length + block.key.length + 12, 0);
  const cut = total > 60_000;
  const blocks = input.blocks.map((block) => `[${block.key}] ${mmss(block.at)}${block.speaker !== undefined ? ` ${block.speaker}:` : ""} ${cut ? (clip(block.text, 320) ?? "") : block.text}`).join("\n\n");
  return `Choose where pictures go in the audiobook chapter below, and write each one's prompt. Each picture is shown while its block is heard: a still taken from that block, what its words describe, seen by one camera. Answer with ONLY this JSON object:
{"pictures": [{"block": "<the key of the block the picture appears at>", "title": "<two to five words naming it>", "frame": "<shot size and subject>", "inFrame": ["<key>", ...], "expressions": {"<key>": "<expression and gaze, in the words the prompt uses>"}, "details": [{"of": "<key>", "part": "<hands | forearm | ...>", "state": "<ease or tension>"}], "notInFrame": ["<key>", ...], "place": "<place key, or null>", "prompt": "<the picture>"}], "summary": "<one sentence on how you chose>"}

WHERE THE PICTURES GO. Each is enforced mechanically after you answer.
- At most ${input.cap} pictures, in reading order, about one every ${PICTURE_PACE_SEC} seconds of speech. Fewer is better than a weak one.
- A picture goes where the chapter turns: a change of place or of time, a change of who is there, an entrance, a turn in what is happening. Not on every paragraph, and never to illustrate a line of talk for its own sake.
- Pictures are at least ${PICTURE_PROPOSAL_GAP_SEC} seconds apart, and at least that from the ones that already stand${input.standing.length > 0 ? ` (at ${input.standing.map(mmss).join(", ")})` : ""}. A block with a picture on it is left alone.

EACH PICTURE is written to the rules below, for its own block: the block named in "block" is the block the rules speak of, and the blocks around it are only where you are.
${briefRules(input.maxChars, input.never)}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
${BRIEF_EXAMPLES}

${briefGiven(input)}
## The chapter's blocks, with their start
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
export async function proposeIllustrations(store: WorldStore, room: PictureRoom, model: ManifestModel, deriver: IllustrateDeriver, signal?: AbortSignal): Promise<ProposedIllustrations> {
  const plan = room.plan;
  if (plan.blocks.length === 0) throw new Error("nothing to illustrate · the chapter has no words");
  const inputs = listeningBlocks(store, plan);
  const clock = pictureStarts(inputs.map((block) => ({ text: block.text, seconds: block.take?.seconds ?? null })));
  const record = plan.record === "unreadable" ? null : plan.record;
  const pictures = record?.pictures ?? {};
  // Every picture the author has set stands where its words are, and holds its block; a lost one
  // holds nothing. Their starts are what a proposal keeps clear of.
  const { placed } = placePictures(inputs, pictures);
  const standing = placed.map((entry) => clock.starts[entry.index] ?? 0);
  const occupied = new Set([...placed.map((entry) => inputs[entry.index]!.key), ...Object.keys(pictures)]);
  const cap = pictureCap(clock.total, placed.length);
  if (cap === 0) throw new Error("the chapter has its pictures");
  const visible = depictable(room.people);
  const sheets = store.getBundle().sheets;
  const maxChars = promptRoom(model);
  if (signal?.aborted) throw new Error("stopped");
  const raw = await deriver(
    {
      title: plan.chapter.title,
      ...(room.mood !== undefined ? { mood: room.mood } : {}),
      ...(room.synopsis !== undefined ? { synopsis: room.synopsis } : {}),
      blocks: plan.blocks.map((planned, index) => {
        const speaker = blockSpeakers(sheets, planned.block);
        return { key: planned.block.key, at: clock.starts[index] ?? 0, text: normalizeSpeechText(planned.block.text), ...(speaker !== undefined ? { speaker } : {}) };
      }),
      ...(room.note !== undefined ? { note: room.note } : {}),
      lines: briefLines(store, room.look, visible.map((person) => person.key)),
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
  type Candidate = { index: number; at: number; title: string; prompt: string; held: ReturnType<typeof holdBrief> };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw.pictures) {
    const index = plan.blocks.findIndex((planned) => planned.block.key === entry.block);
    const prompt = clipPrompt(entry.prompt, maxChars);
    if (index < 0 || seen.has(entry.block) || occupied.has(entry.block) || prompt === "") {
      dropped += 1;
      continue;
    }
    seen.add(entry.block);
    // Held to the chapter as Suggest picture's answer is (R-120): who is in and out of frame, expressions, details.
    const held = holdBrief(entry, { people: visible, places: room.places, prompt, fallback: () => [] });
    const title = clip(entry.title ?? "", PICTURE_TITLE_MAX) ?? clip(prompt, 40)!;
    candidates.push({ index, at: clock.starts[index] ?? 0, title, prompt, held });
  }  // In reading order whatever order the model gave them; then the rules.
  candidates.sort((a, b) => a.index - b.index);
  const kept = thinPictures(candidates, standing, cap);
  dropped += candidates.length - kept.length;
  const rows: IllustrationRow[] = kept.map((position) => {
    const candidate = candidates[position]!;
    const planned = plan.blocks[candidate.index]!;
    // Who rides is who is in frame (rule 12): a detail carries no one, a frame with nobody in it the place.
    const who = pictureWho(store, model, briefRiders(candidate.held), { look: room.look, frame: candidate.held.frame });
    // Rule 4 where a look image rides: no skin, cut or body in the words (2026-10-04).
    const held = { ...candidate.held, prompt: neutralWhereLooksRide(candidate.held.prompt, who) };
    const needs = who.filter((entry) => entry.kind === "character" && entry.sheet !== undefined && entry.reference === null).map((entry) => entry.name);
    const picks = ridingPicks(who);
    const keys = held.inFrame.map((person) => person.key);
    const stamp = pictureLookFor(room.look, keys, picks);
    const used = lookLinesFor(room.look, [...keys, ...held.details.map((detail) => detail.of)], picks);
    const checks = pictureChecks({ held, who, people: visible, lines: used, block: planned.block.text, mood: room.mood });
    const shot = { frame: held.frame, inFrame: keys, notInFrame: held.notInFrame, expressions: held.expressions, details: held.details, checks };    return {
      block: planned.block.key,
      textHash: audiobookTextHash(planned.block.text),
      at: candidate.at,
      title: candidate.title,
      prompt: held.prompt,
      who,
      estimatedMicroUsd: pictureQuote(model, who.filter((entry) => entry.carried).length),
      ...(stamp !== undefined ? { look: stamp } : {}),
      ...(needs.length > 0 ? { needs } : {}),
      shot,
    };
  });
  const summary = clip(raw.summary, 300);
  return {
    proposal: {
      hash: plan.chapter.hash,
      rows,
      model: { provider: model.provider, id: model.id, name: model.displayName, references: referenceBudgetFor(model) },
      ...(pictureAspect(model) !== undefined ? { aspect: pictureAspect(model)! } : {}),
      seconds: clock.total,
      estimated: clock.estimated,
      standing: placed.length,
      ...(summary !== undefined ? { summary } : {}),
    },
    dropped,
  };
}
