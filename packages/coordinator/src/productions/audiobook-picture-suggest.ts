import { z } from "zod";
import {
  PICTURE_PROMPT_MAX,
  aspectOffered,
  estimateMicroUsd,
  imageOutputFor,
  lookLinesFor,
  normalizeSpeechText,
  pictureLookFor,
  referenceBudget,
  sheetReferencePicture,
  type AudiobookBlock,
  type AudiobookLook,
  type BudgetCandidate,
  type HarnessAdapter,
  type ManifestModel,
  type PictureSuggestion,
  type PictureWho,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { referenceBudgetFor } from "../references/generate.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, type AudiobookPlan } from "./audiobook.js";
import { clip } from "./audiobook-direction.js";
import { anyNarrator } from "./audiobook-listening.js";
import { artDirectionFor, blockSpeakers, chapterPeople, chapterPlaces, nameAt, type ChapterPerson, type ChapterPlace } from "./audiobook-look.js";
import { makeAdapterJsonDeriver } from "./continuity.js";

/**
 * Suggest picture (design turn 191a, SPEC-047 R-99, R-100): the writing service reads the block's
 * words, the chapter around it, who is in it and their look, the places and the book's art
 * direction, and drafts ONE picture prompt the author can edit. Around it, deterministically: who
 * rides as a reference — each character by their sheet's main picture, a place by its establishing
 * view, up to the number the model takes — the look lines the prompt was written from, the model,
 * the ratio and the price. Nothing is made and nothing is spent by drafting.
 */

export const PICTURE_BOUNDS = { neighbour: 240, synopsis: 600, art: 400, reserve: 700 } as const;

const RawPictureSchema = z.object({
  prompt: z.string(),
  who: z.array(z.string()).nullable().optional(),
  place: z.string().nullable().optional(),
});
export type RawPicture = z.infer<typeof RawPictureSchema>;

export interface PictureDeriverInput {
  title: string;
  art?: string;
  synopsis?: string;
  block: { key: string; text: string; speaker?: string };
  before?: string;
  after?: string;
  /** The look the prompt takes its lines from: the place, then each person's. */
  lines: ReadonlyArray<{ label: string; text: string }>;
  people: ReadonlyArray<Pick<ChapterPerson, "key" | "name" | "appearance">>;
  places: readonly ChapterPlace[];
  /** Sheets that are never to be pictured: named so the model leaves them out of frame. */
  never: readonly string[];
  maxChars: number;
}
export type PictureDeriver = (input: PictureDeriverInput, signal?: AbortSignal) => Promise<RawPicture>;

export function buildPicturePrompt(input: PictureDeriverInput, retryNote?: string): string {
  const people = input.people.map((person) => `[${person.key}] ${person.name}${person.appearance !== undefined ? ` — ${person.appearance}` : ""}`).join("\n");
  const places = input.places.map((place) => `[${place.key}] ${place.name}${place.look !== undefined ? ` — ${place.look}` : ""}`).join("\n");
  const lines = input.lines.map((line) => `${line.label}: ${line.text}`).join("\n");
  return `Write the prompt for ONE picture to be shown while the block below is heard, in an illustrated audiobook. Respond with ONLY a JSON object:
{"prompt": "<the picture>", "who": ["<key of each character in frame>"], "place": "<key of the place shown, or null>"}

Rules — what the prompt says is held to these after you answer:
- One moment, drawn from the block: where the camera is, who is in frame and what they are doing, the light. Concrete and visual, in one to three sentences, at most ${input.maxChars} characters.
- What people wear and carry, the place and the light come from the look below. Use them; never contradict them, and never invent a coat the look does not give.
- Name each character as the characters list does. "who" holds the keys of the characters the picture shows, from that list, and only those; "place" is a key from the places list or null.
- Never write the book's style (it is added separately), and never ask for text, captions, titles, speech bubbles or logos in the picture.
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

## Around the block

${input.before !== undefined ? `Before: ${input.before}\n` : ""}${input.after !== undefined ? `After: ${input.after}\n` : ""}
## The block [${input.block.key}]${input.block.speaker !== undefined ? ` spoken by ${input.block.speaker}` : ""}

${input.block.text}`;
}

export function makeAdapterPictureDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): PictureDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawPictureSchema, "picture");
  return (input, signal) => ask((note) => buildPicturePrompt(input, note), signal);
}

/** A prompt held to its cap: cut after the last whole sentence that fits, else at a word. */
export function clipPrompt(text: string, max: number): string {
  const folded = normalizeSpeechText(text);
  if (folded.length <= max) return folded;
  const cut = folded.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (stop > max / 2) return cut.slice(0, stop + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** The shape a picture is asked for: widescreen where the model offers it, as the player letterboxes. */
export function pictureAspect(model: ManifestModel): string | undefined {
  return model.unverified !== true && aspectOffered(model, "16:9") ? "16:9" : undefined;
}

/** What a picture would cost on this model with this many reference pictures riding, from the same figures the Bench plans with. */
export function pictureQuote(model: ManifestModel, referenceImages: number, aspect = pictureAspect(model)): number {
  const output = imageOutputFor(model, { landscape: true, ...(aspect !== undefined ? { aspect } : {}) });
  return estimateMicroUsd(model, {
    images: 1,
    megapixels: (output.width * output.height) / 1_000_000,
    referenceImages,
    ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
  });
}

/** The longest prompt the Bench will take once the references and the look are written around it. */
export function promptRoom(model: ManifestModel): number {
  const cap = model.limits.maxPromptChars;
  return cap === undefined ? PICTURE_PROMPT_MAX : Math.max(200, Math.min(PICTURE_PROMPT_MAX, cap - PICTURE_BOUNDS.reserve));
}

/**
 * Who rides as a reference (R-100): each named person by their sheet's main picture and the place
 * by its establishing view, ranked as every other budget is — characters before places, leads
 * first, then in the order they come — and cut at the number the model takes. A sheet with no
 * picture is listed and not carried, so the card can say `Make a reference`; one the limit leaves
 * out is listed and not carried either. The model's limit is the only limit.
 */
export function pictureWho(
  store: Pick<WorldStore, "getBundle">,
  model: ManifestModel,
  chosen: ReadonlyArray<{ key: string; name: string; sheet?: string; kind: "character" | "place"; billing?: string }>,
): PictureWho[] {
  const world = store.getBundle();
  const reference = (sheet: string | undefined): string | null => (sheet === undefined ? null : sheetReferencePicture(world, sheet));
  const candidates: BudgetCandidate[] = chosen.flatMap((entry, index) =>
    entry.sheet === undefined
      ? []
      : [{ sheetId: entry.sheet, kind: entry.kind === "place" ? "location" as const : "character" as const, ...(entry.billing !== undefined ? { billing: entry.billing } : {}), appearanceOrder: index, hasReference: reference(entry.sheet) !== null }],
  );
  const budget = referenceBudget(candidates, { ...model, accepts: { ...model.accepts, referenceImages: referenceBudgetFor(model) } });
  const carried = new Set(budget.carried.filter((candidate) => candidate.referenceRole === "primary").map((candidate) => candidate.sheetId));
  return chosen.map((entry): PictureWho => {
    const file = reference(entry.sheet);
    return {
      key: entry.key,
      name: entry.name,
      ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}),
      kind: entry.kind,
      reference: file,
      carried: file !== null && entry.sheet !== undefined && carried.has(entry.sheet),
    };
  });
}

/** What the writing service is given of a block's chapter, read once for the suggestion and for the run. */
export interface PictureRoom {
  plan: AudiobookPlan;
  people: ChapterPerson[];
  places: ChapterPlace[];
  look: AudiobookLook | null;
  art: string | undefined;
  synopsis: string | undefined;
}

export async function pictureRoom(store: WorldStore, productionId: string, chapterId: string, look: AudiobookLook | null): Promise<PictureRoom> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: await anyNarrator(store, productionId) });
  const summary = store.getBundle().productions.find((p) => p.meta.id === productionId)?.chapters.find((c) => c.id === plan.chapter.id);
  return {
    plan,
    people: chapterPeople(store, plan),
    places: chapterPlaces(store, plan),
    look,
    art: artDirectionFor(store, productionId),
    synopsis: clip(summary?.synopsis, PICTURE_BOUNDS.synopsis),
  };
}

/** The people a block may show: not those the sheet never lets be pictured. */
export const depictable = (people: readonly ChapterPerson[]): ChapterPerson[] => people.filter((person) => !person.neverDepicted);

/** Who a block shows when the model named no one: those who speak in it, and the characters whose names its words hold. */
function namedIn(block: Pick<AudiobookBlock, "text" | "sheet" | "speaker" | "rows">, people: readonly ChapterPerson[]): ChapterPerson[] {
  const speaking = new Set((block.rows ?? [block]).flatMap((turn) => (turn.sheet === undefined ? [] : [turn.sheet])));
  return people.filter((person) => (person.sheet !== undefined && speaking.has(person.sheet)) || nameAt(block.text, person.name) >= 0);
}

export interface SuggestOptions {
  deriver: PictureDeriver;
  model: ManifestModel;
  signal?: AbortSignal;
}

/**
 * One block's suggestion (R-99): drafted by the deriver, then held — who it names must be someone
 * in the chapter the sheet lets be pictured, a prompt over the model's room is cut at a sentence,
 * and the references, the look lines used, the ratio and the price are the coordinator's own.
 */
export async function suggestPicture(store: WorldStore, room: PictureRoom, blockKey: string, options: SuggestOptions): Promise<PictureSuggestion> {
  const index = room.plan.blocks.findIndex((planned) => planned.block.key === blockKey);
  if (index < 0) throw new Error("that block is no longer in the chapter");
  const planned = room.plan.blocks[index]!;
  const visible = depictable(room.people);
  const sheets = store.getBundle().sheets;
  const speaker = blockSpeakers(sheets, planned.block);
  const maxChars = promptRoom(options.model);
  const lines = lookLinesFor(room.look, visible.map((person) => person.key));
  if (options.signal?.aborted) throw new Error("stopped");
  const raw = await options.deriver(
    {
      title: room.plan.chapter.title,
      ...(room.art !== undefined ? { art: room.art } : {}),
      ...(room.synopsis !== undefined ? { synopsis: room.synopsis } : {}),
      block: { key: planned.block.key, text: normalizeSpeechText(planned.block.text), ...(speaker !== undefined ? { speaker } : {}) },
      ...(index > 0 ? { before: clip(room.plan.blocks[index - 1]!.block.text, PICTURE_BOUNDS.neighbour)! } : {}),
      ...(index < room.plan.blocks.length - 1 ? { after: clip(room.plan.blocks[index + 1]!.block.text, PICTURE_BOUNDS.neighbour)! } : {}),
      lines: lines.map((line) => ({ label: line.label, text: line.text })),
      people: visible,
      places: room.places,
      never: room.people.filter((person) => person.neverDepicted).map((person) => person.name),
      maxChars,
    },
    options.signal,
  );
  if (options.signal?.aborted) throw new Error("stopped");
  const prompt = clipPrompt(raw.prompt, maxChars);
  if (prompt === "") throw new Error("the writing service gave no picture");
  const named = (raw.who ?? []).flatMap((key) => {
    const person = visible.find((candidate) => candidate.key === key || candidate.name.toLowerCase() === key.trim().toLowerCase());
    return person === undefined ? [] : [person];
  });
  const inFrame = [...new Map((named.length > 0 ? named : namedIn(planned.block, visible)).map((person) => [person.key, person])).values()].slice(0, 12);
  const place = raw.place === null || raw.place === undefined ? undefined : room.places.find((candidate) => candidate.key === raw.place);
  const who = pictureWho(store, options.model, [
    ...inFrame.map((person) => ({ key: person.key, name: person.name, ...(person.sheet !== undefined ? { sheet: person.sheet } : {}), kind: "character" as const, ...(person.billing !== undefined ? { billing: person.billing } : {}) })),
    ...(place === undefined ? [] : [{ key: place.key, name: place.name, sheet: place.key, kind: "place" as const }]),
  ]);
  const used = lookLinesFor(room.look, inFrame.map((person) => person.key));
  const aspect = pictureAspect(options.model);
  const stamp = pictureLookFor(room.look, inFrame.map((person) => person.key));
  return {
    block: blockKey,
    prompt,
    who,
    lines: used.map((line) => ({ label: line.label, text: line.text })),
    model: { provider: options.model.provider, id: options.model.id, name: options.model.displayName, references: referenceBudgetFor(options.model) },
    ...(aspect !== undefined ? { aspect } : {}),
    estimatedMicroUsd: pictureQuote(options.model, who.filter((entry) => entry.carried).length, aspect),
    ...(stamp !== undefined ? { look: stamp } : {}),
  };
}
