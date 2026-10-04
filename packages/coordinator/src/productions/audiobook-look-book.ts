import { lookClothing, type CarriedLook, type ReferenceKit } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { readAudiobook } from "./audiobook.js";

/**
 * The looks a book's chapters have chosen (design turn 193, SPEC-047 R-114, R-116): which kit look
 * each chapter chose for each character, read from the chapters' records. A picker lists every look
 * with the chapters that chose it, and a new chapter starts each character with the one most
 * recently chosen before it. Carrying a look copies nothing and costs nothing.
 */

export interface ChapterLookChoices {
  /** The chapter's file, its order in the book, and each character's chosen look by `lookKey`, with where a carried choice came from. */
  file: string;
  order: number;
  choices: Record<string, { lookId: string; from?: string }>;
}

/** Every chapter of the production in order, with the looks its record holds a choice of. A chapter with no record or look has none. */
export async function bookLookChoices(store: WorldStore, productionId: string): Promise<ChapterLookChoices[]> {
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  const chapters = [...(production?.chapters ?? [])].sort((a, b) => a.order - b.order);
  const book: ChapterLookChoices[] = [];
  for (const chapter of chapters) {
    const record = await readAudiobook(store, productionId, chapter.file).catch(() => null);
    const choices: ChapterLookChoices["choices"] = {};
    if (record !== null && record !== "unreadable") {
      for (const [key, line] of Object.entries(record.look?.characters ?? {})) {
        if (line.lookId !== undefined) choices[key] = { lookId: line.lookId, ...(line.from !== undefined ? { from: line.from } : {}) };
      }
    }
    book.push({ file: chapter.file, order: chapter.order, choices });
  }
  return book;
}

/**
 * The look each of these people starts a chapter with (R-116): the one most recently chosen in an
 * earlier chapter of the book, in chapter order. A look since removed from the kit, or no longer
 * a costume, is passed over for the choice before it; a character with no sheet has no looks and
 * one chosen nowhere starts with none. `from` is the chapter the choice was made in — a choice
 * that was itself carried names where it began.
 */
export function carriedLooks(
  book: readonly ChapterLookChoices[],
  order: number,
  people: ReadonlyArray<{ key: string; name: string; sheet?: string | undefined }>,
  kitOf: (sheetId: string) => Pick<ReferenceKit, "looks"> | undefined,
): Record<string, CarriedLook> {
  const earlier = book.filter((chapter) => chapter.order < order).sort((a, b) => b.order - a.order);
  const carried: Record<string, CarriedLook> = {};
  for (const person of people) {
    if (person.sheet === undefined) continue;
    const looks = kitOf(person.sheet)?.looks ?? [];
    for (const chapter of earlier) {
      const choice = chapter.choices[person.key];
      if (choice === undefined) continue;
      const look = looks.find((candidate) => candidate.id === choice.lookId && candidate.kind === "costume");
      if (look === undefined) continue;
      carried[person.key] = { name: person.name, sheet: person.sheet, lookId: look.id, text: lookClothing(look), from: choice.from ?? chapter.file };
      break;
    }
  }
  return carried;
}

/** The chapters of a book that chose each look, by look id: `chapters 3, 5` on a picker. */
export function lookUsage(book: readonly ChapterLookChoices[]): Record<string, number[]> {
  const usage: Record<string, number[]> = {};
  for (const chapter of book) {
    for (const choice of Object.values(chapter.choices)) {
      const orders = (usage[choice.lookId] ??= []);
      if (!orders.includes(chapter.order)) orders.push(chapter.order);
    }
  }
  return usage;
}
