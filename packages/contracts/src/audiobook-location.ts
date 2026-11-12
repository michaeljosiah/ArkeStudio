import type { LookLine } from "./audiobook-look.js";
import type { PictureWho } from "./audiobook-illustrate.js";
import { orderedLocationViews, type ReferenceKit } from "./reference.js";

/** The existing picture brief's place budget; coverage reports what the prompt cannot hold. */
export const CHAPTER_PLACES_MAX = 8;
export type CoverageLocation = { id: string; name: string; type: string; retired?: boolean };

const locationWords = (text: string): string => text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/\p{Pd}/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole location names, with an optional initial The; a generic word such as House is not an alias. */
export function locationNameAt(body: string, name: string): number {
  const phrase = locationWords(name).replace(/^the /, "");
  if (phrase === "") return -1;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(phrase)}(?![\\p{L}\\p{N}])`, "u").exec(locationWords(body))?.index ?? -1;
}

export const sameLocationName = (a: string, b: string): boolean => locationWords(a).replace(/^the /, "") === locationWords(b).replace(/^the /, "");

/** Candidate order only: these normalized offsets are not source-selection positions. */
export function namedChapterLocations<T extends CoverageLocation>(body: string, sheets: readonly T[]): T[] {
  return sheets.filter(sheet => sheet.type === "location" && sheet.retired !== true)
    .map(sheet => ({ sheet, at: locationNameAt(body, sheet.name) })).filter(row => row.at >= 0)
    .sort((a, b) => a.at - b.at).map(row => row.sheet);
}

export type LocationCoverageRow = {
  key: string;
  name: string;
  blocks: string[];
  state: "unlinked" | "ambiguous" | "missing-reference" | "ready" | "needs-review";
  sheet?: string;
  reference?: string;
};

/**
 * Evidence for author review, never an exhaustive setting detector. A place line can name several
 * rooms without any world sheet; keep it visible even when every known name has an accepted view.
 * A portrait, old main-photo fallback or a Without/Skip choice cannot establish a location.
 */
export function chapterLocationCoverage(input: {
  body: string;
  sheets: readonly CoverageLocation[];
  kits: readonly ReferenceKit[];
  place?: LookLine | null;
  blocks?: readonly { key: string; text: string }[];
  pictures?: readonly { block: string; who: readonly PictureWho[] }[];
}): { rows: LocationCoverageRow[]; limit: number; omitted: number } {
  const named = namedChapterLocations(input.body, input.sheets);
  const rows = new Map<string, LocationCoverageRow>();
  const known = (sheet: CoverageLocation, blocks: string[]): LocationCoverageRow => {
    const kit = input.kits.find(kit => kit.sheetId === sheet.id);
    const view = kit === undefined ? undefined : orderedLocationViews(kit)[0];
    return { key: sheet.id, name: sheet.name, blocks, sheet: sheet.id,
      state: view === undefined ? "missing-reference" : "ready",
      ...(view === undefined ? {} : { reference: `references/${sheet.id}/${view.file}` }) };
  };
  for (const sheet of named) rows.set(sheet.id, known(sheet, (input.blocks ?? []).filter(block => locationNameAt(block.text, sheet.name) >= 0).map(block => block.key)));
  if (input.place !== undefined && input.place !== null) rows.set("description:place", {
    key: "description:place", name: input.place.text, blocks: [...new Set(input.place.blocks ?? [])], state: "needs-review",
  });
  for (const picture of input.pictures ?? []) for (const who of picture.who) {
    if (who.kind !== "place") continue;
    const sheet = input.sheets.find(sheet => sheet.id === who.sheet && sheet.type === "location" && sheet.retired !== true);
    const key = sheet?.id ?? `unlinked-place:${who.key}`;
    const existing = rows.get(key);
    if (existing !== undefined) { if (!existing.blocks.includes(picture.block)) existing.blocks.push(picture.block); continue; }
    const sameName = input.sheets.filter(sheet => sheet.type === "location" && sheet.retired !== true && sameLocationName(sheet.name, who.name));
    rows.set(key, sheet !== undefined ? known(sheet, [picture.block]) : {
      key, name: who.name, blocks: [picture.block], state: sameName.length > 1 ? "ambiguous" : "unlinked",
    });
  }
  return { rows: [...rows.values()], limit: CHAPTER_PLACES_MAX, omitted: Math.max(0, named.length - CHAPTER_PLACES_MAX) };
}
