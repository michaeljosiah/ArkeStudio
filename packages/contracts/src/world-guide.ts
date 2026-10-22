import { z } from "zod";
import { CanonIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { mainPhotoFor, orderedLocationViews, type ReferenceKit } from "./reference.js";
import type { CanonEntry, Sheet } from "./world.js";
import { GUIDE_FORMAT, GUIDE_VERSION, packageSlug, type GuideCharacter, type GuideDocument, type GuideLore, type GuidePlace, type GuideSection, type GuideVoice } from "./world-package.js";

/**
 * A world's Guide (SPEC-059 R-1 – R-8): which of the world's characters, places and settled lore a
 * reader of the world may see in Arke Player, each from the start or after a chapter, section by
 * section. The record is `guide.json` at the world's root. It stores choices, never text (R-5): an
 * edit to a sheet or an entry shows in the next package, and a section not named here is not
 * public, so a heading added later waits for the author like everything else (R-2).
 */

export const GUIDE_RECORD_FILE = "guide.json";

/** A chapter of one of the world's productions, by the world's own ids. */
export const GuideRecordAfterSchema = z.object({ production: SlugSchema, chapter: SlugSchema }).strict();
export type GuideRecordAfter = z.infer<typeof GuideRecordAfterSchema>;

export const GuideRecordSectionSchema = z.object({ public: z.boolean(), after: GuideRecordAfterSchema.optional() }).strict();
export type GuideRecordSection = z.infer<typeof GuideRecordSectionSchema>;

/** A line in the character's voice (R-6): a sentence of a block's take in a chapter read whole. */
export const GuideRecordVoiceSchema = z
  .object({
    production: SlugSchema,
    chapter: SlugSchema,
    /** The block's key in the chapter's listening plan. */
    block: z.string().min(1),
    /** The sentence's index in that block. */
    sentence: z.number().int().min(0),
    /** Its length as chosen, for the Guide's row; the package reads the take again. */
    seconds: z.number().positive().optional(),
  })
  .strict();
export type GuideRecordVoice = z.infer<typeof GuideRecordVoiceSchema>;

export const GuideRecordEntrySchema = z
  .object({
    public: z.boolean(),
    after: GuideRecordAfterSchema.optional(),
    /** By heading. */
    sections: z.record(z.string().min(1), GuideRecordSectionSchema).optional(),
    voice: GuideRecordVoiceSchema.optional(),
  })
  .strict();
export type GuideRecordEntry = z.infer<typeof GuideRecordEntrySchema>;

export const GuideRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Stamped by the committer: the Guide is versioned as a sheet is (R-8). */
    version: z.number().int().min(1).optional(),
    characters: z.record(SlugSchema, GuideRecordEntrySchema),
    locations: z.record(SlugSchema, GuideRecordEntrySchema),
    factions: z.record(SlugSchema, GuideRecordEntrySchema),
    lore: z.record(CanonIdSchema, GuideRecordEntrySchema.pick({ public: true, after: true })),
  })
  .strict();
export type GuideRecord = z.infer<typeof GuideRecordSchema>;
export type GuideKind = "characters" | "locations" | "factions" | "lore";
export type GuideSheetKind = Exclude<GuideKind, "lore">;

/** One entry's choices, replaced whole; null clears them. A lore entry has neither sections nor a voice. */
export const SetGuideEntrySchema = z.discriminatedUnion("entryKind", [
  z.object({ entryKind: z.enum(["characters", "locations", "factions"]), id: SlugSchema, entry: GuideRecordEntrySchema.nullable() }).strict(),
  z.object({ entryKind: z.literal("lore"), id: CanonIdSchema, entry: GuideRecordEntrySchema.pick({ public: true, after: true }).nullable() }).strict(),
]);
export type SetGuideEntry = z.infer<typeof SetGuideEntrySchema>;

/**
 * A sentence a character speaks in a take of a chapter read whole (R-6), as `Change` offers it:
 * where it is in the world, so the Studio plays it from its take, and what it says.
 */
export const GuideVoiceLineSchema = z
  .object({
    production: SlugSchema,
    productionTitle: z.string(),
    chapter: SlugSchema,
    /** As the Guide numbers chapters. */
    chapterNumber: z.number().int().min(1),
    block: z.string().min(1),
    sentence: z.number().int().min(0),
    text: z.string().min(1),
    /** The take, world-relative, and where in it the sentence is heard, in seconds. */
    file: z.string().min(1),
    start: z.number().min(0),
    seconds: z.number().positive(),
  })
  .strict();
export type GuideVoiceLine = z.infer<typeof GuideVoiceLineSchema>;

export const GuideVoiceLinesRequestSchema = z.object({ worldId: UlidSchema, requestId: UlidSchema, character: SlugSchema }).strict();

/** A world's Guide before the author has chosen anything (R-2). */
export const EMPTY_GUIDE_RECORD: GuideRecord = { schemaVersion: 1, characters: {}, locations: {}, factions: {}, lore: {} };

/** The author's Markdown less any blockquote beginning `Room note`: a run of `>` lines, its first line deciding it. */
function withoutRoomNotes(body: string): string {
  const kept: string[] = [];
  let quote: "note" | "kept" | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) {
      quote ??= /^\s*>\s*(\*\*|__|\*|_)?\s*room note/i.test(line) ? "note" : "kept";
      if (quote === "note") continue;
    } else {
      quote = null;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const inline = (text: string) =>
  text
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2");

/**
 * Markdown as a reader is given it: words, not markup. A sheet's prose is wrapped where its author
 * typed it, so a paragraph's lines join into one; its paragraphs, and a list's items, stay apart;
 * emphasis, quote marks, headings' hashes and links' addresses go.
 */
function plain(markdown: string): string {
  return markdown
    .split(/\n\s*\n/)
    .map((paragraph) => {
      let text = "";
      for (const raw of paragraph.split("\n")) {
        const line = raw.replace(/^\s*>\s?/, "").replace(/^\s*#{1,6}\s+/, "").trim();
        if (line === "") continue;
        text = text === "" ? line : /^(?:[-*+]|\d+[.)])\s/.test(line) ? `${text}\n${line}` : `${text} ${line}`;
      }
      return inline(text);
    })
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
}

/** A section's public text (R-5): the section as written, less its Room notes, as plain text. */
export function guidePublicText(body: string): string {
  return plain(withoutRoomNotes(body));
}

/**
 * A canon entry's public text (R-5): its statement less the amendment notes, a paragraph that
 * opens in bold on `Amended` (`**Amended at revision 52**`, `**Further amended at revision 56.**`)
 * and everything after it. An amendment is how canon records a change of mind, and the later ones
 * carry what no reader is meant to have yet; the author edits a statement in to publish it.
 */
export function guideLoreText(body: string): string {
  const paragraphs = withoutRoomNotes(body).split(/\n\s*\n/);
  const first = paragraphs.findIndex((paragraph) => /^\*\*[^*]*\bamended\b/i.test(paragraph.trim()));
  return plain((first === -1 ? paragraphs : paragraphs.slice(0, first)).join("\n\n"));
}

/** A sheet's sections as a reader could be given them, in authored order; one its notes leave empty is not offered. */
export function guideSections(sheet: Pick<Sheet, "sections">): Array<{ heading: string; text: string }> {
  return sheet.sections.map((section) => ({ heading: section.heading, text: guidePublicText(section.body) })).filter((section) => section.text !== "");
}

/**
 * The picture a sheet is shown by (R-13): a location's establishing view, else its main photo; a
 * character's or faction's main photo; else the conventional head-front, which older worlds may
 * have. World-relative; whether the file is there is the caller's to check.
 */
export function guideSheetPicture(kits: readonly ReferenceKit[], kind: GuideSheetKind, sheetId: string): string {
  const kit = kits.find((candidate) => candidate.sheetId === sheetId);
  const view = kit !== undefined && kind === "locations" ? orderedLocationViews(kit)[0] : undefined;
  const photo = kit !== undefined ? mainPhotoFor(kit) : null;
  return `references/${sheetId}/${view?.file ?? photo?.file ?? "head-front.png"}`;
}

/** Only settled canon can be public (R-3). */
export const guideLoreChoosable = (entry: Pick<CanonEntry, "status">) => entry.status === "settled";

/** A production's chapters in manuscript order, numbered as a reader counts them. */
export interface GuideProductionChapters {
  id: string;
  title: string;
  chapters: Array<{ id: string; number: number; title: string; book?: string }>;
}

/**
 * Each production's chapters in manuscript order, as `After a chapter` offers them (R-4) and a
 * package numbers them: by the chapter's own order, the number the Studio calls it by, raised past
 * a tie so the numbers always rise. A production with no chapter has none to offer.
 */
export function guideProductionsOf(
  productions: ReadonlyArray<{ meta: { id: string; title: string }; chapters: ReadonlyArray<{ id: string; order: number; title: string; retired?: boolean }> }>,
): GuideProductionChapters[] {
  return productions
    .map((production) => {
      let last = 0;
      const chapters = production.chapters
        .filter((chapter) => chapter.retired !== true)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((chapter) => {
          const number = Math.max(chapter.order, last + 1);
          last = number;
          return { id: chapter.id, number, title: chapter.title };
        });
      return { id: production.meta.id, title: production.meta.title, chapters };
    })
    .filter((production) => production.chapters.length > 0);
}

/** The number of the chapter a choice waits for, or null when it names none the world still has. */
export function guideChapterOf(productions: readonly GuideProductionChapters[], after: GuideRecordAfter | undefined): { production: GuideProductionChapters; number: number; title: string } | null {
  if (after === undefined) return null;
  const production = productions.find((candidate) => candidate.id === after.production);
  const chapter = production?.chapters.find((candidate) => candidate.id === after.chapter);
  return production !== undefined && chapter !== undefined ? { production, number: chapter.number, title: chapter.title } : null;
}

/** What the Guide's head counts (R-1): `4 of 5 characters · 3 of 6 places · 7 of 16 lore · 4 after a chapter`. */
export interface GuideCounts {
  characters: { public: number; of: number };
  places: { public: number; of: number };
  lore: { public: number; of: number };
  after: number;
}

export interface GuideWorld {
  characters: readonly Sheet[];
  locations: readonly Sheet[];
  factions: readonly Sheet[];
  canon: readonly CanonEntry[];
}

/** Retired sheets and entries are not listed (R-3); they keep their choices in case they return. */
export const guideLiving = <T extends { retired?: boolean }>(list: readonly T[]): T[] => list.filter((item) => item.retired !== true);

export function guideCounts(record: GuideRecord, world: GuideWorld): GuideCounts {
  const on = (kind: GuideKind, id: string) => record[kind][id]?.public === true;
  const waits = (kind: GuideKind, id: string) => on(kind, id) && record[kind][id]!.after !== undefined;
  const characters = guideLiving(world.characters);
  const places = [...guideLiving(world.locations).map((sheet) => ["locations", sheet.id] as const), ...guideLiving(world.factions).map((sheet) => ["factions", sheet.id] as const)];
  const lore = guideLiving(world.canon).filter(guideLoreChoosable);
  return {
    characters: { public: characters.filter((sheet) => on("characters", sheet.id)).length, of: characters.length },
    places: { public: places.filter(([kind, id]) => on(kind, id)).length, of: places.length },
    lore: { public: lore.filter((entry) => on("lore", entry.id)).length, of: lore.length },
    after:
      characters.filter((sheet) => waits("characters", sheet.id)).length +
      places.filter(([kind, id]) => waits(kind, id)).length +
      lore.filter((entry) => waits("lore", entry.id)).length,
  };
}

/** What a package needs that only the exporter has: each picture as an asset, and each voice line cut. */
export interface GuideMaterial extends GuideWorld {
  productions: readonly GuideProductionChapters[];
  picture: (kind: GuideSheetKind, sheet: Sheet) => string | undefined;
  voice: (sheet: Sheet, voice: GuideRecordVoice) => GuideVoice | undefined;
}

/**
 * The guide document a package carries (R-11, R-12): what the record makes public, with the text
 * read now, so an edit to a sheet ships in the next package. Null when nothing is public (R-15).
 * Ids are package ids: the sheets' and productions' slugs, the canon ids in lower case, and the
 * chapters' ids as the listening document has them. A link keeps only entries that ship;
 * and an `after` naming a chapter the world no longer has keeps its entry or section out, rather
 * than showing it from the start.
 */
export function guideDocument(record: GuideRecord, material: GuideMaterial): GuideDocument | null {
  const named = new Map<string, GuideProductionChapters>();
  const resolve = (after: GuideRecordAfter | undefined): { production: string; chapter: string } | null | false => {
    if (after === undefined) return null;
    const production = material.productions.find((candidate) => candidate.id === after.production);
    if (production === undefined || !production.chapters.some((chapter) => chapter.id === after.chapter)) return false;
    named.set(production.id, production);
    return { production: packageSlug(after.production), chapter: after.chapter };
  };

  // A link names an entry without its kind, so an id is the guide's own: a place or faction whose
  // slug a character already has takes a number.
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  const idOf = (key: string, wanted: string) => {
    let id = packageSlug(wanted);
    for (let n = 2; taken.has(id); n++) id = `${packageSlug(wanted).slice(0, 60)}-${n}`;
    ids.set(key, id);
    taken.add(id);
    return id;
  };
  const sectionsOf = (sheet: Sheet, entry: GuideRecordEntry): GuideSection[] => {
    const sections: GuideSection[] = [];
    for (const section of guideSections(sheet)) {
      const choice = entry.sections?.[section.heading];
      if (choice?.public !== true) continue;
      const after = resolve(choice.after);
      if (after === false) continue;
      sections.push({ heading: section.heading.slice(0, 200), text: section.text.slice(0, 20_000), ...(after !== null ? { after } : {}) });
    }
    return sections;
  };

  type Pending<T> = { entry: T; links: readonly string[] };
  const characters: Pending<GuideCharacter>[] = [];
  for (const sheet of guideLiving(material.characters)) {
    const entry = record.characters[sheet.id];
    if (entry?.public !== true) continue;
    const after = resolve(entry.after);
    if (after === false) continue;
    const portrait = material.picture("characters", sheet);
    const voice = entry.voice !== undefined ? material.voice(sheet, entry.voice) : undefined;
    // A voice line names its chapter in the guide too, so a reader can say where it was heard.
    const heard = voice !== undefined && resolve({ production: voice.production, chapter: voice.chapter }) !== false;
    const spoken = heard ? { ...voice, production: packageSlug(voice.production) } : undefined;
    characters.push({
      entry: {
        id: idOf(`characters:${sheet.id}`, sheet.id),
        name: sheet.name.slice(0, 200),
        ...(sheet.role?.trim() ? { role: sheet.role.trim().slice(0, 200) } : {}),
        ...(portrait !== undefined ? { portrait } : {}),
        ...(after !== null ? { after } : {}),
        sections: sectionsOf(sheet, entry),
        ...(spoken !== undefined ? { voice: spoken } : {}),
      },
      links: sheet.links,
    });
  }
  const places: Pending<GuidePlace>[] = [];
  for (const kind of ["locations", "factions"] as const) {
    for (const sheet of guideLiving(material[kind])) {
      const entry = record[kind][sheet.id];
      if (entry?.public !== true) continue;
      const after = resolve(entry.after);
      if (after === false) continue;
      const picture = material.picture(kind, sheet);
      const role = kind === "locations" ? sheet.region?.trim() : "Faction";
      places.push({
        entry: {
          id: idOf(`${kind}:${sheet.id}`, sheet.id),
          name: sheet.name.slice(0, 200),
          ...(role ? { role: role.slice(0, 200) } : {}),
          ...(picture !== undefined ? { picture } : {}),
          ...(after !== null ? { after } : {}),
          sections: sectionsOf(sheet, entry),
        },
        links: sheet.links,
      });
    }
  }
  const lore: Pending<GuideLore>[] = [];
  for (const canon of guideLiving(material.canon)) {
    const choice = record.lore[canon.id];
    if (choice?.public !== true || !guideLoreChoosable(canon)) continue;
    const text = guideLoreText(canon.body);
    const after = resolve(choice.after);
    if (text === "" || after === false) continue;
    lore.push({
      entry: { id: idOf(`lore:${canon.id}`, canon.id.toLowerCase()), kind: canon.type, title: canon.title.slice(0, 200), text: text.slice(0, 20_000), ...(after !== null ? { after } : {}) },
      links: canon.links,
    });
  }
  if (characters.length + places.length + lore.length === 0) return null;

  // A sheet's link is a slug, a canon entry's a slug or a CANON id: each names the entry that ships
  // under it, a character first, then a place, then a faction.
  const target = (link: string): string | undefined =>
    /^CANON-\d+$/.test(link) ? ids.get(`lore:${link}`) : (ids.get(`characters:${link}`) ?? ids.get(`locations:${link}`) ?? ids.get(`factions:${link}`));
  const linked = <T extends { id: string }>({ entry, links }: Pending<T>): T => {
    const kept = [...new Set(links.map(target).filter((id): id is string => id !== undefined && id !== entry.id))];
    return kept.length > 0 ? { ...entry, links: kept.slice(0, 200) } : entry;
  };
  return {
    format: GUIDE_FORMAT,
    version: GUIDE_VERSION,
    productions: [...named.values()].map((production) => ({
      id: packageSlug(production.id),
      title: production.title.slice(0, 200),
      chapters: production.chapters.map((chapter) => ({ id: chapter.id, number: chapter.number, ...(chapter.book !== undefined ? { book: chapter.book } : {}) })),
    })),
    characters: characters.map(linked),
    places: places.map(linked),
    lore: lore.map(linked),
  };
}
