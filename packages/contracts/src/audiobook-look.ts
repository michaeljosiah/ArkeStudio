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

/**
 * Where the chapter's own reading of the prose and the look chosen for it disagree (design turn
 * 193a, SPEC-047 R-112): `Hood · chapter down · look up`. `chapter` sets the prose's reading (`a`)
 * against the chosen look's line (`b`); `photo` sets the main photo (`a`) against the words (`b`).
 * Shown as a row with Make again; never put in a prompt — the image is the arbiter.
 */
export const LookConflictSchema = z
  .object({
    kind: z.enum(["chapter", "photo"]),
    part: z.string().min(1).max(40),
    a: z.string().min(1).max(120),
    b: z.string().min(1).max(120),
  })
  .strict();
export type LookConflict = z.infer<typeof LookConflictSchema>;

export const LookCharacterSchema = z
  .object({
    /** The name the sheet shows, or the name the prose gives a character with no sheet. */
    name: z.string().min(1).max(120),
    /** The character's sheet, when the world has one: its main picture rides with every prompt they are in. */
    sheet: SlugSchema.optional(),
    text: z.string().min(1).max(LOOK_LINE_MAX),
    blocks: z.array(z.string().min(1).max(40)).max(80).optional(),
    by: z.literal("author").optional(),
    /**
     * The kit look this chapter chose for the character (design turn 193, R-112): a pointer, not
     * the look's `attachedTo`, because a look chosen in chapter 1 stays choosable in chapter 5.
     * With it, `text` is the look's own clothing line and the look's image is the reference that
     * rides in place of the main photo.
     */
    lookId: z.string().min(1).max(120).optional(),
    /** The chapter the choice was carried from, by file, when the chapter did not choose it itself (R-116). */
    from: z.string().min(1).max(200).optional(),
    /** The prose's own reading of this chapter, kept beside a chosen look's line and never replacing it. */
    reading: z.string().min(1).max(LOOK_LINE_MAX).optional(),
    conflicts: z.array(LookConflictSchema).max(8).optional(),
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
    /**
     * The book's art direction as a picture takes it (design turn 193, R-117): light, colour,
     * grain and lens, read once with the look and editable — never what anyone wears or carries.
     * Only this line goes to the writing service and into a picture's brief.
     */
    mood: LookLineSchema.optional(),
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
 * Which image of a look rides (design turn 193, R-109): the full-body image, or the close view
 * (head and shoulders). The frame decides — never both.
 */
export const LookViewSchema = z.enum(["full", "close"]);
export type LookView = z.infer<typeof LookViewSchema>;

/**
 * The look one person rode in one picture (R-112): the kit look and which of its two images.
 * `only` is a look chosen for this picture alone — the chapter's choice is not its choice, so a
 * later change of the chapter's choice never marks the picture `look changed` (R-115).
 */
export const PictureLookPickSchema = z
  .object({
    lookId: z.string().min(1).max(120),
    view: LookViewSchema,
    only: z.literal(true).optional(),
  })
  .strict();
export type PictureLookPick = z.infer<typeof PictureLookPickSchema>;

/** A kit look's own clothing line, for the one-picture override: the look and its words, or undefined where it is gone. */
export type LookLibrary = (key: string, lookId: string) => { text: string } | undefined;

export interface PictureLookLine {
  label: string;
  key: string | null;
  text: string;
  /** The kit look the line comes from, and which of its images rides: absent where the main photo rides. */
  lookId?: string;
  view?: LookView;
}

/**
 * The lines a picture takes from the look (R-98): the place first, then each of these characters
 * in the order given. A character the look holds no line for is left out, never invented.
 *
 * `picks` are the looks chosen for one picture alone (R-115): that person's words are the chosen
 * look's own line, from `library`, not the chapter's. A look the library no longer holds leaves
 * the chapter's line, marked, so the picture reads as changed.
 */
export function lookLinesFor(
  look: AudiobookLook | null | undefined,
  who: readonly string[],
  picks?: Readonly<Record<string, PictureLookPick>>,
  library?: LookLibrary,
): PictureLookLine[] {
  if (look === null || look === undefined) return [];
  const lines: PictureLookLine[] = [];
  if (look.place !== undefined) lines.push({ label: "Place", key: null, text: look.place.text });
  for (const key of who) {
    const line = look.characters[key];
    const pick = picks?.[key];
    if (pick?.only === true) {
      // The override's words are the look's own; the chapter's line is not in this picture at all.
      const own = library?.(key, pick.lookId);
      lines.push({ label: line?.name ?? key, key, text: own?.text ?? "\u0000gone", lookId: pick.lookId, view: pick.view });
      continue;
    }
    if (line === undefined) continue;
    lines.push({ label: line.name, key, text: line.text, ...(line.lookId !== undefined ? { lookId: line.lookId, view: pick?.view ?? "full" } : {}) });
  }
  return lines;
}

/**
 * A fingerprint of the lines a picture was made under: the words of each, in order, and the look
 * each person rode with (R-112). A picture stores it with who was in it, and is marked `look
 * changed` when the lines for those same people now say something else — one character's coat
 * changed does not mark another character's pictures. A line with no look hashes as it did in 191,
 * so a picture made before looks existed is not marked by their arrival alone.
 */
export function lookDigest(lines: ReadonlyArray<{ key: string | null; text: string; lookId?: string | undefined; view?: string | undefined }>): string {
  return textDigest(
    `look-v1:${JSON.stringify(lines.map((line) => (line.lookId === undefined ? [line.key, line.text.replace(/\s+/g, " ").trim()] : [line.key, line.text.replace(/\s+/g, " ").trim(), line.lookId, line.view ?? "full"])))}`,
  );
}

/**
 * What a picture keeps of the look it was made under (R-98): the digest of its lines and who was
 * in it, and for each person the kit look that rode and which of its images (R-112, R-109).
 */
export const PictureLookSchema = z
  .object({
    hash: z.string().min(1),
    who: z.array(z.string().min(1).max(120)).max(LOOK_CHARACTERS_MAX),
    looks: z.record(z.string().min(1).max(120), PictureLookPickSchema).optional(),
  })
  .strict();
export type PictureLook = z.infer<typeof PictureLookSchema>;

/**
 * The look to stamp on a picture made now, from the chapter's look and the people in it. `picks`
 * says which image of the chapter's chosen look rides for each person (the frame decides, R-109)
 * and any look chosen for this picture alone (R-115); a person who rode the main photo has none.
 */
export function pictureLookFor(
  look: AudiobookLook | null | undefined,
  who: readonly string[],
  picks?: Readonly<Record<string, PictureLookPick>>,
  library?: LookLibrary,
): PictureLook | undefined {
  const lines = lookLinesFor(look, who, picks, library);
  if (lines.length === 0) return undefined;
  const kept: Record<string, PictureLookPick> = {};
  for (const key of who) {
    const pick = picks?.[key];
    if (pick !== undefined) kept[key] = pick;
  }
  return { hash: lookDigest(lines), who: [...who], ...(Object.keys(kept).length > 0 ? { looks: kept } : {}) };
}

/**
 * Whether the lines a picture was made under have since changed (R-98): `look changed`, shown on
 * the block, never remade without asking. A picture made with no look is never marked. A look
 * chosen for one picture alone is marked only by a change to that look's own line (R-115): the
 * chapter changing its choice does not reach it.
 */
export function pictureLookChanged(made: PictureLook | undefined, look: AudiobookLook | null | undefined, library?: LookLibrary): boolean {
  if (made === undefined) return false;
  return lookDigest(lookLinesFor(look, made.who, made.looks, library)) !== made.hash;
}

/**
 * Whether a chapter's record holds anything the builds before turn 193 read as unreadable — a look
 * chosen, a reading kept beside it, conflicts, the mood line, or the look a picture rode — so the
 * world is raised before the record is written (SPEC-023 R-23).
 */
export function lookNeedsChoiceBoundary(record: { look?: AudiobookLook | undefined; pictures?: Readonly<Record<string, { look?: PictureLook | undefined }>> | undefined }): boolean {
  const look = record.look;
  if (look !== undefined) {
    if (look.mood !== undefined) return true;
    if (Object.values(look.characters).some((line) => line.lookId !== undefined || line.from !== undefined || line.reading !== undefined || line.conflicts !== undefined)) return true;
  }
  return Object.values(record.pictures ?? {}).some((picture) => picture.look?.looks !== undefined);
}

export interface DerivedLook {
  place?: { text: string; blocks?: string[] };
  mood?: { text: string };
  characters: Array<{
    key: string;
    name: string;
    sheet?: string;
    text: string;
    blocks?: string[];
    /** Where the chapter's reading and the look this character already has disagree, from the writing service. */
    conflicts?: LookConflict[];
  }>;
}

/** What carries a look into a chapter that has not chosen one (R-116): the look, its words and the chapter it was chosen in. */
export interface CarriedLook {
  name: string;
  sheet?: string;
  lookId: string;
  text: string;
  from: string;
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
  /**
   * The looks earlier chapters chose, by character (R-116): a character who has none chosen here
   * starts with the one most recently chosen. A choice already made — by the author or carried —
   * is never undone by a derive, and the chapter's own reading is kept beside it as `reading`.
   */
  carried?: Readonly<Record<string, CarriedLook>>,
): { look: AudiobookLook; kept: number } {
  let kept = 0;
  const characters: Record<string, LookCharacter> = {};
  for (const [key, line] of Object.entries(held?.characters ?? {})) {
    // The author's lines stand, and so does a look that was chosen: its line is the look's.
    if (lookByAuthor(line) || line.lookId !== undefined) {
      characters[key] = line;
      kept += 1;
    }
  }
  const read = new Map(derived.characters.map((entry) => [entry.key, entry]));
  for (const [key, line] of Object.entries(characters)) {
    const entry = read.get(key);
    if (line.lookId === undefined || entry === undefined) continue;
    // The chapter's own reading, compared with the look rather than put in its place.
    const { reading: _old, conflicts: _oldConflicts, ...rest } = line;
    const same = entry.text.replace(/\s+/g, " ").trim() === line.text.replace(/\s+/g, " ").trim();
    characters[key] = { ...rest, ...(same ? {} : { reading: entry.text }), ...(entry.conflicts !== undefined && entry.conflicts.length > 0 ? { conflicts: entry.conflicts } : {}) };
  }
  for (const entry of derived.characters) {
    if (characters[entry.key] !== undefined) continue;
    if (Object.keys(characters).length >= LOOK_CHARACTERS_MAX) break;
    // Carried only to a character the look held nothing for: one the author set to no look stays so after a derive again.
    const take = held?.characters[entry.key] === undefined ? carried?.[entry.key] : undefined;
    if (take !== undefined) {
      // Carrying a look copies nothing and costs nothing: the choice and its words, from the chapter it was made in.
      const same = entry.text.replace(/\s+/g, " ").trim() === take.text.replace(/\s+/g, " ").trim();
      characters[entry.key] = {
        name: entry.name,
        ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}),
        text: take.text,
        lookId: take.lookId,
        from: take.from,
        ...(entry.blocks !== undefined && entry.blocks.length > 0 ? { blocks: entry.blocks } : {}),
        ...(same ? {} : { reading: entry.text }),
        ...(entry.conflicts !== undefined && entry.conflicts.length > 0 ? { conflicts: entry.conflicts } : {}),
      };
      continue;
    }
    characters[entry.key] = {
      name: entry.name,
      ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}),
      text: entry.text,
      ...(entry.blocks !== undefined && entry.blocks.length > 0 ? { blocks: entry.blocks } : {}),
    };
  }
  // A character the chapter names but the reading found no clothing for still starts with the look carried to them.
  for (const [key, take] of Object.entries(carried ?? {})) {
    if (characters[key] !== undefined || held?.characters[key] !== undefined || Object.keys(characters).length >= LOOK_CHARACTERS_MAX) continue;
    characters[key] = { name: take.name, ...(take.sheet !== undefined ? { sheet: take.sheet } : {}), text: take.text, lookId: take.lookId, from: take.from };
  }
  let place: LookLine | undefined;
  if (held?.place !== undefined && lookByAuthor(held.place)) {
    place = held.place;
    kept += 1;
  } else if (derived.place !== undefined) {
    place = { text: derived.place.text, ...(derived.place.blocks !== undefined && derived.place.blocks.length > 0 ? { blocks: derived.place.blocks } : {}) };
  }
  // The mood is read once and then the author's to change; a derive that reads none leaves the one held.
  let mood: LookLine | undefined;
  if (held?.mood !== undefined && lookByAuthor(held.mood)) {
    mood = held.mood;
    kept += 1;
  } else if (derived.mood !== undefined) mood = { text: derived.mood.text.slice(0, LOOK_LINE_MAX) };
  else if (held?.mood !== undefined) mood = held.mood;
  return { look: { chapterHash: stamp.chapterHash, at: stamp.at, ...(place !== undefined ? { place } : {}), ...(mood !== undefined ? { mood } : {}), characters }, kept };
}

/**
 * A look chosen for a character in this chapter (R-112), or the choice taken away with null. The
 * character's line becomes the look's own clothing line — the image and its words agree by
 * construction — and the chapter's earlier words are kept as `reading`, so taking the choice away
 * goes back to them. Choosing the look already chosen changes nothing. A choice made here is the
 * chapter's own: it is no longer `from` another chapter.
 */
export function chooseLook(
  held: AudiobookLook | null | undefined,
  who: { key: string; name?: string; sheet?: string | undefined },
  pick: { lookId: string; text: string } | null,
  stamp: { chapterHash: string; at: string },
): AudiobookLook | null {
  const base: AudiobookLook = held ?? { chapterHash: stamp.chapterHash, at: stamp.at, characters: {} };
  const current = base.characters[who.key];
  if (pick === null) {
    if (current?.lookId === undefined) return null;
    const { lookId: _id, from: _from, conflicts: _conflicts, reading, ...rest } = current;
    return { ...base, at: stamp.at, characters: { ...base.characters, [who.key]: { ...rest, text: reading ?? current.text } } };
  }
  const words = pick.text.replace(/\s+/g, " ").trim().slice(0, LOOK_LINE_MAX);
  if (words === "") return null;
  if (current?.lookId === pick.lookId && current.from === undefined && current.text === words) return null;
  const name = current?.name ?? who.name;
  if (name === undefined) return null;
  if (current === undefined && Object.keys(base.characters).length >= LOOK_CHARACTERS_MAX) return null;
  const sheet = current?.sheet ?? who.sheet;
  // What the chapter said of them before the choice is what a later look is compared with.
  const reading = current?.lookId === undefined ? current?.text : current.reading;
  return {
    ...base,
    at: stamp.at,
    characters: {
      ...base.characters,
      [who.key]: {
        name,
        ...(sheet !== undefined ? { sheet } : {}),
        text: words,
        ...(current?.blocks !== undefined ? { blocks: current.blocks } : {}),
        lookId: pick.lookId,
        ...(reading !== undefined && reading !== words ? { reading } : {}),
      },
    },
  };
}

/** What the author changes on the sheet: the place, the mood, or one character's line (a new character takes a name). */
export const LookTargetSchema = z.union([
  z.object({ kind: z.literal("place") }).strict(),
  z.object({ kind: z.literal("mood") }).strict(),
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
  if (target.kind === "mood") {
    if ((words === null || words === "") && base.mood === undefined) return null;
    if (words === base.mood?.text) return null;
    const { mood: _old, ...rest } = base;
    return words === null || words === "" ? { ...rest, at: stamp.at } : { ...rest, at: stamp.at, mood: { text: words, by: "author" } };
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
      // The choice of a look stays through an edit of its line (the line is then marked edited, the image still rides, R-114).
      [target.key]: {
        name,
        ...(sheet !== undefined ? { sheet } : {}),
        text: words,
        ...(current?.blocks !== undefined ? { blocks: current.blocks } : {}),
        by: "author",
        ...(current?.lookId !== undefined ? { lookId: current.lookId } : {}),
        ...(current?.from !== undefined ? { from: current.from } : {}),
        ...(current?.reading !== undefined ? { reading: current.reading } : {}),
      },
    },
  };
}
