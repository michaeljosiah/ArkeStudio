import { characterAliasKey, type Sheet } from "./world.js";
import { mainPhotoFor, type ReferenceKit } from "./reference.js";
import type { AudiobookLook } from "./audiobook-look.js";
import type { PictureWho } from "./audiobook-illustrate.js";

import type { ChapterReferenceCoverage, ReferenceCoverageRow } from "./audiobook-reference-coverage-schema.js";
export * from "./audiobook-reference-coverage-schema.js";

type CoverageCharacter = Pick<Sheet, "id" | "name" | "type" | "retired" | "aliases" | "billing" | "neverDepicted">;
export type CharacterReferenceIdentity = { state: "linked"; sheet: CoverageCharacter } | { state: "unlinked" | "ambiguous" };

/** Stable sheet IDs and explicit chapter choices precede exact authored names; collisions never guess. */
export function resolveReferenceCharacter(who: { key: string; name: string; sheet?: string }, sheets: readonly CoverageCharacter[], look?: AudiobookLook | null): CharacterReferenceIdentity {
  const active = sheets.filter(sheet => sheet.type === "character" && sheet.retired !== true);
  if (who.sheet !== undefined) {
    const sheet = active.find(sheet => sheet.id === who.sheet);
    return sheet === undefined ? { state: "unlinked" } : { state: "linked", sheet };
  }
  const direct = active.find(sheet => sheet.id === who.key);
  if (direct !== undefined) return { state: "linked", sheet: direct };
  const local = look?.characters[who.key]?.sheet;
  if (local !== undefined) {
    const sheet = active.find(sheet => sheet.id === local);
    return sheet === undefined ? { state: "unlinked" } : { state: "linked", sheet };
  }
  const name = characterAliasKey(who.name);
  const localIds = new Set(Object.values(look?.characters ?? {}).filter(line => line.sheet !== undefined && characterAliasKey(line.name) === name).map(line => line.sheet));
  const localMatches = active.filter(sheet => localIds.has(sheet.id));
  if (localIds.size > 0) return localMatches.length === 1 && localIds.size === 1 ? { state: "linked", sheet: localMatches[0]! } : { state: localIds.size > 1 ? "ambiguous" : "unlinked" };
  const matches = active.filter(sheet => [sheet.name, ...(sheet.aliases ?? [])].some(alias => characterAliasKey(alias) === name));
  return matches.length === 1 ? { state: "linked", sheet: matches[0]! } : { state: matches.length > 1 ? "ambiguous" : "unlinked" };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function named(body: string, name: string): boolean {
  const normalized = characterAliasKey(name);
  return normalized !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${escape(normalized)}(?![\\p{L}\\p{N}])`, "u").test(characterAliasKey(body));
}

/** Saved chapter lines, exact known names and prepared picture subjects stay distinguishable from undiscovered people. */
export function chapterCharacterCoverage(input: {
  body: string; sheets: readonly CoverageCharacter[]; kits: readonly ReferenceKit[];
  look?: AudiobookLook | null;
  blocks?: readonly { key: string; text: string }[];
  pictures?: readonly { block: string; who: readonly PictureWho[] }[];
}): ReferenceCoverageRow[] {
  const rows = new Map<string, ReferenceCoverageRow>();
  const add = (who: { key: string; name: string; sheet?: string }, blocks: readonly string[]) => {
    const resolved = resolveReferenceCharacter(who, input.sheets, input.look);
    const sheet = resolved.state === "linked" ? resolved.sheet : undefined;
    const key = sheet?.id ?? `unlinked:${who.key}`;
    const previous = rows.get(key);
    if (previous !== undefined) { previous.blocks = [...new Set([...previous.blocks, ...blocks])]; return; }
    const kit = sheet === undefined ? undefined : input.kits.find(kit => kit.sheetId === sheet.id);
    const photo = kit === undefined ? null : mainPhotoFor(kit);
    const state = sheet === undefined ? resolved.state === "ambiguous" ? "ambiguous" : "unlinked" : sheet.neverDepicted === true ? "not-depicted" : photo === null ? "missing-reference" : "ready";
    rows.set(key, { kind: "character", key, name: sheet?.name ?? who.name, blocks: [...new Set(blocks)], state,
      ...(sheet === undefined ? {} : { sheet: sheet.id, ...(sheet.billing === undefined ? {} : { billing: sheet.billing }), ...(sheet.aliases?.length ? { aliases: sheet.aliases } : {}) }),
      ...(sheet === undefined || photo === null || sheet.neverDepicted === true ? {} : { reference: `references/${sheet.id}/${photo.file}` }),
    });
  };
  for (const [key, line] of Object.entries(input.look?.characters ?? {})) add({ key, name: line.name, ...(line.sheet === undefined ? {} : { sheet: line.sheet }) }, line.blocks ?? []);
  const names = new Map<string, string>();
  for (const sheet of input.sheets.filter(sheet => sheet.type === "character" && sheet.retired !== true)) for (const name of [sheet.name, ...(sheet.aliases ?? [])]) {
    if (named(input.body, name)) names.set(characterAliasKey(name), name);
  }
  for (const [key, name] of names) {
    if (Object.values(input.look?.characters ?? {}).some(line => characterAliasKey(line.name) === key)) continue;
    add({ key: `named:${key}`, name }, (input.blocks ?? []).filter(block => named(block.text, name)).map(block => block.key));
  }
  for (const picture of input.pictures ?? []) for (const who of picture.who) if (who.kind === "character") add(who, [picture.block]);
  return [...rows.values()];
}

export function referenceCoverageCounts(chapter: ChapterReferenceCoverage): { unresolved: number; missing: number; review: number; bounded: boolean } {
  return {
    unresolved: chapter.rows.filter(row => row.state === "unlinked" || row.state === "ambiguous").length,
    missing: chapter.rows.filter(row => row.state === "missing-reference").length,
    review: chapter.rows.filter(row => row.state === "needs-review").length,
    bounded: Object.values(chapter.bounds).some(bound => bound.omitted > 0),
  };
}
