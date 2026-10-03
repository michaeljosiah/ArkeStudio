import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema } from "./ids.js";
import { textDigest } from "./subtitles.js";

/**
 * The look of a chapter (design turn 191c, SPEC-047 R-98): what each character wears and carries
 * and how they appear in this chapter, and the place, the time and the light — read once from the
 * prose, kept on the chapter's audiobook record, editable line by line. Every picture prompt of
 * the chapter takes its lines from here, so a coat stays the same coat from one block to the next.
 *
 * A line is the author's (`by: "author"`) the moment they write or change it, and a later derive
 * never replaces it. A derived line says which blocks it was read from, so the sheet can show
 * where a coat comes from and the author can check it against the words.
 */

/** Longest a line may be: a coat, a ring of keys and a scarf, not a paragraph. */
export const LOOK_LINE_MAX = 400;
/** The characters a chapter's look holds: enough for a crowded chapter, bounded for the prompt. */
export const LOOK_CHARACTERS_MAX = 24;

export const LookLineSchema = z
  .object({
    text: z.string().min(1).max(LOOK_LINE_MAX),
    /** The blocks, by key, the line was read from; absent on a line the author wrote. */
    blocks: z.array(z.string().min(1).max(40)).max(80).optional(),
    /** `author` once a person wrote or changed the line: a derive again leaves it as it is. */
    by: z.literal("author").optional(),
  })
  .strict();
export type LookLine = z.infer<typeof LookLineSchema>;

export const LookCharacterSchema = z
  .object({
    /** The name the sheet shows, or the name the prose gives a character with no sheet. */
    name: z.string().min(1).max(120),
    /** The character's sheet, when the world has one: its main picture rides with every prompt they are in. */
    sheet: SlugSchema.optional(),
    text: z.string().min(1).max(LOOK_LINE_MAX),
    blocks: z.array(z.string().min(1).max(40)).max(80).optional(),
    by: z.literal("author").optional(),
  })
  .strict();
export type LookCharacter = z.infer<typeof LookCharacterSchema>;

export const AudiobookLookSchema = z
  .object({
    /** The hash of the prose the look was last read from — the body, not the file. */
    chapterHash: z.string().min(1),
    /** When the look was last read or changed. */
    at: IsoDateTimeSchema,
    place: LookLineSchema.optional(),
    /** By `lookKey`: the sheet's id, else the lower-cased name. */
    characters: z.record(z.string().min(1).max(120), LookCharacterSchema),
  })
  .strict();
export type AudiobookLook = z.infer<typeof AudiobookLookSchema>;

/** Who a line is about, as the look keys them: the sheet, else the name as the prose gives it. */
export function lookKey(who: { sheet?: string | undefined; name: string }): string {
  return who.sheet ?? who.name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether the author wrote or changed the line. */
export const lookByAuthor = (line: { by?: "author" | undefined }): boolean => line.by === "author";

/**
 * The lines a picture takes from the look (R-98): the place first, then each of these characters
 * in the order given. A character the look holds no line for is left out, never invented.
 */
export function lookLinesFor(look: AudiobookLook | null | undefined, who: readonly string[]): Array<{ label: string; key: string | null; text: string }> {
  if (look === null || look === undefined) return [];
  const lines: Array<{ label: string; key: string | null; text: string }> = [];
  if (look.place !== undefined) lines.push({ label: "Place", key: null, text: look.place.text });
  for (const key of who) {
    const line = look.characters[key];
    if (line !== undefined) lines.push({ label: line.name, key, text: line.text });
  }
  return lines;
}

/**
 * A fingerprint of the lines a picture was made under: the words of each, in order. A picture
 * stores it with who was in it, and is marked `look changed` when the lines for those same people
 * now say something else — one character's coat changed does not mark another character's pictures.
 */
export function lookDigest(lines: ReadonlyArray<{ key: string | null; text: string }>): string {
  return textDigest(`look-v1:${JSON.stringify(lines.map((line) => [line.key, line.text.replace(/\s+/g, " ").trim()]))}`);
}

/** What a picture keeps of the look it was made under (R-98): the digest of its lines and who was in it. */
export const PictureLookSchema = z
  .object({
    hash: z.string().min(1),
    who: z.array(z.string().min(1).max(120)).max(LOOK_CHARACTERS_MAX),
  })
  .strict();
export type PictureLook = z.infer<typeof PictureLookSchema>;

/** The look to stamp on a picture made now, from the chapter's look and the people in it. */
export function pictureLookFor(look: AudiobookLook | null | undefined, who: readonly string[]): PictureLook | undefined {
  const lines = lookLinesFor(look, who);
  return lines.length === 0 ? undefined : { hash: lookDigest(lines), who: [...who] };
}

/**
 * Whether the lines a picture was made under have since changed (R-98): `look changed`, shown on
 * the block, never remade without asking. A picture made with no look is never marked.
 */
export function pictureLookChanged(made: PictureLook | undefined, look: AudiobookLook | null | undefined): boolean {
  if (made === undefined) return false;
  return lookDigest(lookLinesFor(look, made.who)) !== made.hash;
}

export interface DerivedLook {
  place?: { text: string; blocks?: string[] };
  characters: Array<{ key: string; name: string; sheet?: string; text: string; blocks?: string[] }>;
}

/**
 * A derive laid over the look the chapter holds (R-98): the author's lines stand as they are, a
 * derived line is replaced by the new reading, a character the new reading does not find goes
 * unless the author wrote their line, and a character it adds is added. Returns the look and how
 * many of the author's lines it kept.
 */
export function mergeLook(
  held: AudiobookLook | null | undefined,
  derived: DerivedLook,
  stamp: { chapterHash: string; at: string },
): { look: AudiobookLook; kept: number } {
  let kept = 0;
  const characters: Record<string, LookCharacter> = {};
  for (const [key, line] of Object.entries(held?.characters ?? {})) {
    if (lookByAuthor(line)) {
      characters[key] = line;
      kept += 1;
    }
  }
  for (const entry of derived.characters) {
    if (characters[entry.key] !== undefined) continue;
    if (Object.keys(characters).length >= LOOK_CHARACTERS_MAX) break;
    characters[entry.key] = {
      name: entry.name,
      ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}),
      text: entry.text,
      ...(entry.blocks !== undefined && entry.blocks.length > 0 ? { blocks: entry.blocks } : {}),
    };
  }
  let place: LookLine | undefined;
  if (held?.place !== undefined && lookByAuthor(held.place)) {
    place = held.place;
    kept += 1;
  } else if (derived.place !== undefined) {
    place = { text: derived.place.text, ...(derived.place.blocks !== undefined && derived.place.blocks.length > 0 ? { blocks: derived.place.blocks } : {}) };
  }
  return { look: { chapterHash: stamp.chapterHash, at: stamp.at, ...(place !== undefined ? { place } : {}), characters }, kept };
}

/** What the author changes on the sheet: the place, or one character's line (a new character takes a name). */
export const LookTargetSchema = z.union([
  z.object({ kind: z.literal("place") }).strict(),
  z
    .object({
      kind: z.literal("character"),
      key: z.string().min(1).max(120),
      /** For a character the look does not hold yet: who they are. */
      name: z.string().min(1).max(120).optional(),
      sheet: SlugSchema.optional(),
    })
    .strict(),
]);
export type LookTarget = z.infer<typeof LookTargetSchema>;

/**
 * One line written by the author (R-98): the new words, or null to take the line away. A line
 * changed becomes the author's; the same words as before change nothing, so pressing in and out of
 * a field does not turn a derived line into one a derive can no longer replace.
 */
export function editLook(
  held: AudiobookLook | null | undefined,
  target: LookTarget,
  text: string | null,
  stamp: { chapterHash: string; at: string },
): AudiobookLook | null {
  const words = text === null ? null : text.replace(/\s+/g, " ").trim().slice(0, LOOK_LINE_MAX);
  const base: AudiobookLook = held ?? { chapterHash: stamp.chapterHash, at: stamp.at, characters: {} };
  if (target.kind === "place") {
    if ((words === null || words === "") && base.place === undefined) return null;
    if (words === base.place?.text) return null;
    const { place: _old, ...rest } = base;
    return words === null || words === "" ? { ...rest, at: stamp.at } : { ...rest, at: stamp.at, place: { ...(base.place?.blocks !== undefined ? { blocks: base.place.blocks } : {}), text: words, by: "author" } };
  }
  const current = base.characters[target.key];
  if (words === null || words === "") {
    if (current === undefined) return null;
    const { [target.key]: _gone, ...characters } = base.characters;
    return { ...base, at: stamp.at, characters };
  }
  if (words === current?.text) return null;
  const name = current?.name ?? target.name;
  if (name === undefined) return null;
  const sheet = current?.sheet ?? target.sheet;
  if (current === undefined && Object.keys(base.characters).length >= LOOK_CHARACTERS_MAX) return null;
  return {
    ...base,
    at: stamp.at,
    characters: {
      ...base.characters,
      [target.key]: { name, ...(sheet !== undefined ? { sheet } : {}), text: words, ...(current?.blocks !== undefined ? { blocks: current.blocks } : {}), by: "author" },
    },
  };
}
