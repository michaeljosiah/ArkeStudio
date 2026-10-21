import { CHAPTER_PLACES_MAX, namedChapterLocations, sameLocationName } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { AudiobookPlan } from "./audiobook.js";
import { clip, section } from "./audiobook-direction.js";

export const CHAPTER_PLACE_LOOK_MAX = 200;

/** A named location candidate. Unlinked evidence has no authority to name a world reference. */
export interface ChapterPlace {
  key: string;
  name: string;
  look?: string;
  unlinked?: true;
  /** Full-world name collision, retained when the other candidate falls outside the prompt. */
  ambiguousName?: true;
}

/** Exact saved names in story order; coverage separately discloses this prompt's existing limit. */
export function chapterPlaces(store: Pick<WorldStore, "getBundle">, plan: Pick<AudiobookPlan, "body">): ChapterPlace[] {
  const named = namedChapterLocations(plan.body, store.getBundle().sheets);
  return named.slice(0, CHAPTER_PLACES_MAX).map(sheet => {
    const look = clip(section(sheet, /^look/i), CHAPTER_PLACE_LOOK_MAX);
    return { key: sheet.id, name: sheet.name, ...(look === undefined ? {} : { look }),
      ...(named.some(other => other.id !== sheet.id && sameLocationName(other.name, sheet.name)) ? { ambiguousName: true as const } : {}) };
  });
}

/** An ambiguous or unknown name stays visible for the author rather than vanishing from a brief. */
export function resolveChapterPlace(places: readonly ChapterPlace[], value: string | null | undefined): ChapterPlace | undefined {
  const name = value?.trim().slice(0, 120);
  if (!name) return undefined;
  const byKey = places.find(place => place.key === name);
  if (byKey !== undefined) return byKey;
  const byName = places.filter(place => sameLocationName(place.name, name));
  return byName.length === 1 && byName[0]?.ambiguousName !== true ? byName[0] : { key: name.toLowerCase(), name, unlinked: true };
}
