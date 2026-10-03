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
import { clipPrompt, depictable, pictureAspect, pictureQuote, pictureWho, promptRoom, type PictureRoom } from "./audiobook-picture-suggest.js";

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
    }),
  ),
  summary: z.string().optional(),
});
export type RawIllustration = z.infer<typeof RawIllustrationSchema>;

export interface IllustrateDeriverInput {
  title: string;
  art?: string;
  synopsis?: string;
  /** The chapter on its clock: each block by key with its start in seconds. */
  blocks: ReadonlyArray<{ key: string; at: number; text: string; speaker?: string }>;
  lines: ReadonlyArray<{ label: string; text: string }>;
  people: ReadonlyArray<{ key: string; name: string; appearance?: string }>;
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
  const people = input.people.map((person) => `[${person.key}] ${person.name}${person.appearance !== undefined ? ` — ${person.appearance}` : ""}`).join("\n");
  const places = input.places.map((place) => `[${place.key}] ${place.name}${place.look !== undefined ? ` — ${place.look}` : ""}`).join("\n");
  const lines = input.lines.map((line) => `${line.label}: ${line.text}`).join("\n");
  const total = input.blocks.reduce((sum, block) => sum + block.text.length + block.key.length + 12, 0);
  const cut = total > 60_000;
  const blocks = input.blocks.map((block) => `[${block.key}] ${mmss(block.at)}${block.speaker !== undefined ? ` ${block.speaker}:` : ""} ${cut ? (clip(block.text, 320) ?? "") : block.text}`).join("\n\n");
  return `Choose where pictures go in the audiobook chapter below, and what each shows. Respond with ONLY a JSON object:
{"pictures": [{"block": "<the key of the block the picture appears at>", "title": "<two to five words naming it>", "prompt": "<the picture>", "who": ["<key of each character in frame>"], "place": "<key of the place shown, or null>"}], "summary": "<one sentence on how you chose>"}

Rules — each is enforced mechanically after you answer:
- At most ${input.cap} pictures, in reading order, about one every ${PICTURE_PACE_SEC} seconds of speech. Fewer is better than a weak one.
- A picture goes where the chapter turns: a change of place or of time, a change of who is there, an entrance, a turn in what is happening. Not on every paragraph, and never to illustrate a line of talk for its own sake.
- Pictures are at least ${PICTURE_PROPOSAL_GAP_SEC} seconds apart, and at least that from the ones that already stand${input.standing.length > 0 ? ` (at ${input.standing.map(mmss).join(", ")})` : ""}. A block with a picture on it is left alone.
- Each prompt is one moment drawn from its block: where the camera is, who is in frame and what they are doing, the light. Concrete and visual, one to three sentences, at most ${input.maxChars} characters. What people wear and carry, the place and the light come from the look below; never contradict it, never invent a coat it does not give.
- "who" holds keys from the characters list, only those the picture shows; "place" is a key from the places list or null.
- Never write the book's style (it is added separately), and never ask for text, captions, titles, speech bubbles or logos in a picture.
${input.never.length > 0 ? `- Never show, name or hint at: ${input.never.join(", ")}.\n` : ""}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## The book's look

${input.art ?? "none stated"}

## The chapter (${input.title})

${input.synopsis ?? "no synopsis"}

## The look of this chapter

${lines === "" ? "not read" : lines}

## Characters

${people === "" ? "none" : people}

## Places

${places === "" ? "none named" : places}

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
      ...(room.art !== undefined ? { art: room.art } : {}),
      ...(room.synopsis !== undefined ? { synopsis: room.synopsis } : {}),
      blocks: plan.blocks.map((planned, index) => {
        const speaker = blockSpeakers(sheets, planned.block);
        return { key: planned.block.key, at: clock.starts[index] ?? 0, text: normalizeSpeechText(planned.block.text), ...(speaker !== undefined ? { speaker } : {}) };
      }),
      lines: lookLinesFor(room.look, visible.map((person) => person.key)).map((line) => ({ label: line.label, text: line.text })),
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
  type Candidate = { index: number; at: number; title: string; prompt: string; people: typeof visible; place?: PictureRoom["places"][number] };
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
    const named = (entry.who ?? []).flatMap((key) => {
      const person = visible.find((candidate) => candidate.key === key || candidate.name.toLowerCase() === key.trim().toLowerCase());
      return person === undefined ? [] : [person];
    });
    const title = clip(entry.title ?? "", PICTURE_TITLE_MAX) ?? clip(prompt, 40)!;
    candidates.push({
      index,
      at: clock.starts[index] ?? 0,
      title,
      prompt,
      people: [...new Map(named.map((person) => [person.key, person])).values()].slice(0, 12),
      ...(entry.place === null || entry.place === undefined ? {} : { place: room.places.find((candidate) => candidate.key === entry.place) }),
    } as Candidate);
  }
  // In reading order whatever order the model gave them; then the rules.
  candidates.sort((a, b) => a.index - b.index);
  const kept = thinPictures(candidates, standing, cap);
  dropped += candidates.length - kept.length;
  const rows: IllustrationRow[] = kept.map((position) => {
    const candidate = candidates[position]!;
    const planned = plan.blocks[candidate.index]!;
    const who = pictureWho(store, model, [
      ...candidate.people.map((person) => ({ key: person.key, name: person.name, ...(person.sheet !== undefined ? { sheet: person.sheet } : {}), kind: "character" as const, ...(person.billing !== undefined ? { billing: person.billing } : {}) })),
      ...(candidate.place === undefined ? [] : [{ key: candidate.place.key, name: candidate.place.name, sheet: candidate.place.key, kind: "place" as const }]),
    ]);
    const needs = who.filter((entry) => entry.kind === "character" && entry.sheet !== undefined && entry.reference === null).map((entry) => entry.name);
    const stamp = pictureLookFor(room.look, candidate.people.map((person) => person.key));
    return {
      block: planned.block.key,
      textHash: audiobookTextHash(planned.block.text),
      at: candidate.at,
      title: candidate.title,
      prompt: candidate.prompt,
      who,
      estimatedMicroUsd: pictureQuote(model, who.filter((entry) => entry.carried).length),
      ...(stamp !== undefined ? { look: stamp } : {}),
      ...(needs.length > 0 ? { needs } : {}),
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
