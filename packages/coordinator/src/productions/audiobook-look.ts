import { z } from "zod";
import {
  AudiobookLookSchema,
  LOOK_CHARACTERS_MAX,
  LOOK_LINE_MAX,
  editLook,
  lookKey,
  mergeLook,
  normalizeSpeechText,
  productionStyleFor,
  type AudiobookLook,
  type ChapterAudiobook,
  type DerivedLook,
  type HarnessAdapter,
  type LookTarget,
  type Sheet,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import type { WorldStore } from "../world/store.js";
import { updateAudiobook, planAudiobook, type AudiobookPlan } from "./audiobook.js";
import { clip, section } from "./audiobook-direction.js";
import { anyNarrator } from "./audiobook-listening.js";
import { makeAdapterJsonDeriver } from "./continuity.js";

/**
 * The look of a chapter (design turn 191c, SPEC-047 R-98): the harness's model reads the chapter's
 * prose with the cast's sheets, the places and the book's art direction, and says where and when
 * the chapter is and what each character wears and carries in it — once, kept on the chapter's
 * audiobook record, every line the author's to change. A derive again replaces only the lines
 * Arke wrote; nothing it reads goes to a picture provider, and nothing is spent: the reader is
 * the writing service, as `Direct this chapter` is.
 */

/** The sizes the prompt is held to: a long chapter or a crowded cast cannot crowd the words out. */
export const LOOK_BOUNDS = { people: 12, section: 240, place: 200, art: 400, chapter: 60_000, block: 320 } as const;

const RawLookSchema = z.object({
  place: z.object({ text: z.string(), blocks: z.array(z.string()).optional() }).nullable().optional(),
  characters: z
    .array(z.object({ who: z.string(), text: z.string(), blocks: z.array(z.string()).optional() }))
    .optional(),
});
export type RawLook = z.infer<typeof RawLookSchema>;

/** Someone in a chapter: a sheet the prose names, or a speaker the cast gives a name with no sheet. */
export interface ChapterPerson {
  /** `lookKey`: the sheet's id, else the lower-cased name. */
  key: string;
  name: string;
  sheet?: string;
  billing?: string;
  essence?: string;
  appearance?: string;
  /** The sheet says this character is never to be pictured (issue 905): no line, no reference, never in a prompt. */
  neverDepicted: boolean;
  /** Where the prose first names them, so the order is the story's. */
  first: number;
}

/** A place a chapter's prose names: a location sheet, and what the sheet says it looks like. */
export interface ChapterPlace {
  key: string;
  name: string;
  look?: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where `name` is first named in `body` as a whole word, or -1. */
function mentionAt(body: string, name: string): number {
  const found = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "iu").exec(body);
  return found === null ? -1 : found.index;
}

/** A sheet's whole name or any one part of it long enough to name them, as the prose might. */
function nameAt(body: string, name: string): number {
  const whole = mentionAt(body, name);
  if (whole >= 0) return whole;
  const parts = name.split(/\s+/).filter((part) => part.length >= 3 && !/^(the|of|and|von|van|de|la)$/i.test(part));
  const hits = parts.map((part) => mentionAt(body, part)).filter((index) => index >= 0);
  return hits.length === 0 ? -1 : Math.min(...hits);
}

/**
 * Who is in a chapter: every character sheet the prose names, and every speaker the cast names with
 * no sheet. Leads first, then in the order the prose first names them; bounded for the prompt.
 */
export function chapterPeople(store: WorldStore, plan: Pick<AudiobookPlan, "body" | "cast">): ChapterPerson[] {
  const sheets = store.getBundle().sheets.filter((sheet) => sheet.type === "character" && sheet.retired !== true);
  const people = new Map<string, ChapterPerson>();
  const personOf = (sheet: Sheet, first: number): ChapterPerson => {
    const essence = clip(section(sheet, /^essence/i), LOOK_BOUNDS.section);
    const appearance = clip(section(sheet, /^appearance|^look/i), LOOK_BOUNDS.section);
    return {
      key: sheet.id,
      name: sheet.name,
      sheet: sheet.id,
      ...(sheet.billing !== undefined ? { billing: sheet.billing } : {}),
      ...(essence !== undefined ? { essence } : {}),
      ...(appearance !== undefined ? { appearance } : {}),
      neverDepicted: sheet.neverDepicted === true,
      first,
    };
  };
  for (const sheet of sheets) {
    const at = nameAt(plan.body, sheet.name);
    if (at >= 0) people.set(sheet.id, personOf(sheet, at));
  }
  const cast = plan.cast !== null && plan.cast !== "unreadable" ? plan.cast.lines : [];
  for (const line of cast) {
    const first = Math.max(0, plan.body.indexOf(line.quote.slice(0, 20)));
    if (line.sheet !== undefined) {
      // A speaker whose sheet the prose never names by name still speaks in the chapter.
      const sheet = people.has(line.sheet) ? undefined : sheets.find((candidate) => candidate.id === line.sheet);
      if (sheet !== undefined) people.set(sheet.id, personOf(sheet, first));
      continue;
    }
    const key = lookKey({ name: line.speaker });
    if (!people.has(key)) people.set(key, { key, name: line.speaker, neverDepicted: false, first });
  }
  return [...people.values()]
    .sort((a, b) => (a.billing === "lead" ? 0 : 1) - (b.billing === "lead" ? 0 : 1) || a.first - b.first)
    .slice(0, LOOK_BOUNDS.people);
}

/** The places a chapter names: location sheets the prose mentions, each with what its sheet says it looks like. */
export function chapterPlaces(store: WorldStore, plan: Pick<AudiobookPlan, "body">): ChapterPlace[] {
  const places: Array<ChapterPlace & { first: number }> = [];
  for (const sheet of store.getBundle().sheets as readonly Sheet[]) {
    if (sheet.type !== "location" || sheet.retired === true) continue;
    const at = nameAt(plan.body, sheet.name);
    if (at < 0) continue;
    const look = clip(section(sheet, /^look/i), LOOK_BOUNDS.place);
    places.push({ key: sheet.id, name: sheet.name, ...(look !== undefined ? { look } : {}), first: at });
  }
  return places.sort((a, b) => a.first - b.first).slice(0, 8).map(({ first: _first, ...place }) => place);
}

/** The book's art direction as a prompt carries it: the production's own style, else the world's. */
export function artDirectionFor(store: WorldStore, productionId: string): string | undefined {
  const bundle = store.getBundle();
  const production = bundle.productions.find((p) => p.meta.id === productionId);
  return clip(productionStyleFor(production?.meta, bundle.artDirection.description), LOOK_BOUNDS.art);
}

export interface LookDeriverInput {
  title: string;
  art?: string;
  people: ReadonlyArray<Pick<ChapterPerson, "key" | "name" | "essence" | "appearance">>;
  places: readonly ChapterPlace[];
  blocks: ReadonlyArray<{ key: string; text: string; speaker?: string }>;
}
export type LookDeriver = (input: LookDeriverInput, signal?: AbortSignal) => Promise<RawLook>;

/** The chapter as the prompt carries it: every block by key, each cut to a head when the whole would pass the bound. */
function promptBlocks(blocks: LookDeriverInput["blocks"]): string {
  const whole = blocks.reduce((sum, block) => sum + block.text.length + block.key.length + 8, 0);
  const cut = whole > LOOK_BOUNDS.chapter;
  return blocks
    .map((block) => `[${block.key}]${block.speaker !== undefined ? ` ${block.speaker}:` : ""} ${cut ? (clip(block.text, LOOK_BOUNDS.block) ?? "") : block.text}`)
    .join("\n\n");
}

export function buildLookPrompt(input: LookDeriverInput, retryNote?: string): string {
  const people = input.people
    .map((person) => `[${person.key}] ${person.name}${person.appearance !== undefined ? ` — the sheet says: ${person.appearance}` : ""}${person.essence !== undefined ? ` · who they are: ${person.essence}` : ""}`)
    .join("\n");
  const places = input.places.map((place) => `${place.name}${place.look !== undefined ? ` — ${place.look}` : ""}`).join("\n");
  return `Read the chapter below for how it looks, for an illustrated audiobook: where and when it is and in what light, and what each character wears, carries and looks like IN THIS CHAPTER. Respond with ONLY a JSON object:
{"place": {"text": "<where, when and the light: one or two phrases>", "blocks": ["<key of a block that says so>"]}, "characters": [{"who": "<the character's key>", "text": "<what they wear and carry and how they appear in this chapter>", "blocks": ["<keys of the blocks it comes from>"]}]}

Rules — each is enforced mechanically after you answer:
- "who" is one of the keys listed under Characters; any other is dropped. At most ${LOOK_CHARACTERS_MAX} characters.
- Every line is what a camera would see: clothes, what is carried, hair, how they stand or are marked (wet, hurt, tired). Never personality, feelings or backstory.
- Take it from the chapter's own words. Where the chapter says nothing of how someone looks, leave them out: a character the chapter does not describe is better absent than invented. The sheet is what they look like at all times; the line is what the chapter adds or changes.
- At most ${LOOK_LINE_MAX} characters a line, and short is better: a coat, a lamp, a scarf.
- "blocks" are keys of blocks listed below, the ones the detail comes from.
- Never rewrite the chapter. Nothing you write goes into the prose.
${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## The book's look

${input.art ?? "none stated"}

## Characters

${people === "" ? "none" : people}

## Places

${places === "" ? "none named" : places}

## Chapter (${input.title})

${promptBlocks(input.blocks)}`;
}

/** The built-in deriver: the shared runner, asked the look's prompt. */
export function makeAdapterLookDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): LookDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawLookSchema, "look");
  return (input, signal) => ask((note) => buildLookPrompt(input, note), signal);
}

export interface VerifiedLook {
  look: DerivedLook;
  /** Lines the model gave that named no one in the chapter, or had no words. */
  dropped: number;
}

/**
 * What the model said, held to the chapter (R-98): a line for someone the chapter does not hold is
 * dropped and counted, a name is taken for the character it names by exact name, a block is kept
 * only where the chapter has it, and a line over the bound is cut at a word. A character the sheet
 * never lets be pictured has no line.
 */
export function verifyLook(raw: RawLook, input: Pick<LookDeriverInput, "people"> & { blocks: ReadonlyArray<{ key: string }>; hidden?: readonly string[] }): VerifiedLook {
  let dropped = 0;
  const keys = new Set(input.blocks.map((block) => block.key));
  const only = (blocks: readonly string[] | undefined): string[] => [...new Set((blocks ?? []).filter((key) => keys.has(key)))].slice(0, 80);
  const lookup = new Map<string, ChapterPerson | (typeof input.people)[number]>();
  for (const person of input.people) {
    lookup.set(person.key, person);
    lookup.set(person.name.toLowerCase(), person);
  }
  const hidden = new Set(input.hidden ?? []);
  const characters: DerivedLook["characters"] = [];
  const seen = new Set<string>();
  for (const entry of raw.characters ?? []) {
    const person = lookup.get(entry.who) ?? lookup.get(entry.who.trim().toLowerCase());
    const text = clip(entry.text, LOOK_LINE_MAX);
    if (person === undefined || hidden.has(person.key) || text === undefined || seen.has(person.key)) {
      dropped += 1;
      continue;
    }
    seen.add(person.key);
    const blocks = only(entry.blocks);
    const sheet = "sheet" in person && typeof person.sheet === "string" ? person.sheet : undefined;
    characters.push({ key: person.key, name: person.name, ...(sheet !== undefined ? { sheet } : {}), text, ...(blocks.length > 0 ? { blocks } : {}) });
    if (characters.length >= LOOK_CHARACTERS_MAX) break;
  }
  const placeText = raw.place === null || raw.place === undefined ? undefined : clip(raw.place.text, LOOK_LINE_MAX);
  const place = placeText === undefined ? undefined : { text: placeText, ...(only(raw.place?.blocks).length > 0 ? { blocks: only(raw.place?.blocks) } : {}) };
  return { look: { ...(place !== undefined ? { place } : {}), characters }, dropped };
}

export interface DerivedChapterLook {
  look: DerivedLook;
  dropped: number;
  /** The prose the look was read from: written only while the chapter still says it. */
  hash: string;
}

/**
 * Read a chapter for its look (R-98): its blocks by key, who is in it, where, and the book's art
 * direction, asked of the deriver once and verified. Nothing is written here.
 */
export async function deriveChapterLook(store: WorldStore, productionId: string, chapterId: string, deriver: LookDeriver, signal?: AbortSignal): Promise<DerivedChapterLook> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: await anyNarrator(store, productionId) });
  const people = chapterPeople(store, plan);
  const sheets = store.getBundle().sheets;
  const speakerOf = (sheetId: string | undefined, speaker: string | undefined): string | undefined => (speaker === undefined ? undefined : (sheets.find((sheet) => sheet.id === sheetId)?.name ?? speaker));
  const blocks = plan.blocks.map((planned) => {
    const speaker = speakerOf(planned.block.sheet, planned.block.speaker);
    return { key: planned.block.key, text: normalizeSpeechText(planned.block.text), ...(speaker !== undefined ? { speaker } : {}) };
  });
  const visible = people.filter((person) => !person.neverDepicted);
  const art = artDirectionFor(store, productionId);
  if (signal?.aborted) throw new Error("stopped");
  const raw = await deriver({ title: plan.chapter.title, ...(art !== undefined ? { art } : {}), people: visible, places: chapterPlaces(store, plan), blocks }, signal);
  if (signal?.aborted) throw new Error("stopped");
  const verified = verifyLook(raw, { people: visible, blocks });
  return { look: verified.look, dropped: verified.dropped, hash: plan.chapter.hash };
}

/** What a derive wrote: the record, and how many of the author's lines it left alone. */
export interface WrittenLook {
  record: ChapterAudiobook;
  kept: number;
}

/**
 * A derive laid over the chapter's look (R-98), under the record's lane: the author's lines stand,
 * Arke's are replaced. Refused when the prose moved while the model read it — a look read from
 * other words is not this chapter's — and left alone when nothing changed.
 */
export async function writeDerivedLook(store: WorldStore, productionId: string, chapterId: string, derived: DerivedChapterLook): Promise<WrittenLook | "moved"> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: await anyNarrator(store, productionId) });
  if (plan.chapter.hash !== derived.hash) return "moved";
  let kept = 0;
  const at = store.now();
  const record = await updateAudiobook(store, productionId, plan.chapter, (current) => {
    const merged = mergeLook(current.look, derived.look, { chapterHash: derived.hash, at });
    kept = merged.kept;
    return { ...current, updatedAt: at, look: merged.look };
  });
  return { record, kept };
}

/**
 * One line of the look written by the author (R-98): the new words, or null to take the line away.
 * The same words change nothing. Refused for a name no one gave a new character.
 */
export async function setChapterLook(store: WorldStore, productionId: string, chapterId: string, target: LookTarget, text: string | null): Promise<ChapterAudiobook> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: await anyNarrator(store, productionId) });
  const at = store.now();
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const next = editLook(current.look, target, text, { chapterHash: plan.chapter.hash, at });
    if (next === null) return null;
    const parsed = AudiobookLookSchema.safeParse(next);
    if (!parsed.success) throw new Error("that is not a line the look can hold");
    return { ...current, updatedAt: at, look: parsed.data };
  });
}

/** The look a chapter holds, or null: read from the record, never from the model. */
export function lookOf(record: ChapterAudiobook | "unreadable" | null): AudiobookLook | null {
  return record === null || record === "unreadable" ? null : (record.look ?? null);
}
