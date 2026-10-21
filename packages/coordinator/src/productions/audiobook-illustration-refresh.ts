import { illustrationReferencesChanged, audiobookTextHash, chapterLookDisagreement, kitLookLibrary, lookLinesFor, ownLookPicks, pictureLookFor, resolveReferenceCharacter, ridingPicks, type IllustrationProposal, type IllustrationRow, type ManifestModel } from "@arke-studio/contracts";
import { referenceBudgetFor } from "../references/generate.js";
import type { WorldStore } from "../world/store.js";
import { chapterPersonCandidates } from "./audiobook-look.js";
import { resolveChapterPlace } from "./audiobook-location.js";
import { holdBrief, pictureChecks } from "./audiobook-picture-brief.js";
import { ownLooksThatRide, pictureAspect, pictureQuote, pictureWho, type PictureRoom } from "./audiobook-picture-suggest.js";
import { chapterReferenceCoverage } from "./audiobook-reference-coverage.js";

/** Current identities and files for a held brief. Its words and composition are never rewritten. */
export function refreshIllustrationRow(store: WorldStore, room: PictureRoom, model: ManifestModel, row: IllustrationRow): IllustrationRow {
  if (room.plan.record === "unreadable") throw new Error("the chapter record is unreadable");
  const sheets = store.getBundle().sheets;
  const remap = new Map<string, string>();
  const chosen = row.who.map(entry => {
    if (entry.kind === "character") {
      const resolved = resolveReferenceCharacter(entry, sheets, room.look);
      if (resolved.state !== "linked") return { key: entry.key, name: entry.name, kind: entry.kind };
      if (resolved.sheet.neverDepicted === true) throw new Error(`${entry.name} is never depicted · review the picture brief`);
      remap.set(entry.key, resolved.sheet.id);
      return { key: resolved.sheet.id, name: entry.name, kind: entry.kind, sheet: resolved.sheet.id, ...(resolved.sheet.billing === undefined ? {} : { billing: resolved.sheet.billing }) };
    }
    const explicit = entry.sheet === undefined ? undefined : sheets.find(sheet => sheet.id === entry.sheet && sheet.type === "location" && !sheet.retired);
    const place = entry.sheet !== undefined ? explicit === undefined ? undefined : { key: explicit.id, name: explicit.name } : resolveChapterPlace(room.places, entry.name);
    return { key: place?.key ?? entry.key, name: entry.name, kind: entry.kind, ...(place === undefined || place.unlinked === true ? {} : { sheet: place.key }) };
  });
  const unique = [...new Map(chosen.map(entry => [`${entry.kind}:${entry.key}`, entry])).values()];
  const own = ownLooksThatRide(store, room.look, room.own(row.block));
  const who = pictureWho(store, model, unique, { look: room.look, frame: row.shot?.frame, own });
  const needs = who.filter(entry => entry.reference === null).map(entry => entry.name);
  const disagrees = who.filter(entry => entry.kind === "character" && entry.only !== true && chapterLookDisagreement(room.look, entry.key).length > 0).map(entry => entry.key);
  const picks = ridingPicks(who), library = kitLookLibrary(store.getBundle().referenceKits, room.look);
  const stamp = pictureLookFor(room.look, who.filter(entry => entry.kind === "character").map(entry => entry.key), picks, library);
  const { needs: _needs, disagrees: _disagrees, look: _look, shot: _shot, ...rest } = row;
  let shot = row.shot;
  if (shot !== undefined) {
    const key = (value: string) => remap.get(value) ?? value;
    const people = chapterPersonCandidates(store, room.plan).map(person => {
      const sources = row.who.filter(entry => remap.get(entry.key) === person.key).map(entry => entry.name);
      return { ...person, aliases: [...new Set([...(person.aliases ?? []), ...sources])] };
    });
    const held = holdBrief({ frame: shot.frame, inFrame: shot.inFrame.map(key), notInFrame: shot.notInFrame.map(key), expressions: Object.fromEntries(Object.entries(shot.expressions).map(([who, words]) => [key(who), words])), details: shot.details.map(detail => ({ ...detail, of: key(detail.of) })), prompt: row.prompt }, { people, places: room.places, prompt: row.prompt, fallback: () => [] });
    const lines = lookLinesFor(room.look, [...held.inFrame.map(person => person.key), ...held.details.map(detail => detail.of)], { ...ownLookPicks(own), ...picks }, library);
    const block = room.plan.blocks.find(entry => entry.block.key === row.block)?.block.text ?? "";
    shot = { frame: held.frame, inFrame: held.inFrame.map(person => person.key), notInFrame: held.notInFrame, expressions: held.expressions, details: held.details, checks: pictureChecks({ held, who, people, lines, block, mood: room.mood }), checkedPrompt: row.prompt };
  }
  return { ...rest, who, estimatedMicroUsd: pictureQuote(model, who.filter(entry => entry.carried).length), ...(needs.length ? { needs } : {}), ...(disagrees.length ? { disagrees } : {}), ...(stamp === undefined ? {} : { look: stamp }), ...(shot === undefined ? {} : { shot }) };
}

export function refreshIllustrationProposal(store: WorldStore, productionId: string, room: PictureRoom, model: ManifestModel, proposal: IllustrationProposal): IllustrationProposal {
  if (room.plan.chapter.hash !== proposal.hash) throw new Error("the prose moved · illustrate again");
  if (model.id !== proposal.model.id || model.provider !== proposal.model.provider) throw new Error("the picture model changed · illustrate again");
  if (room.plan.record === "unreadable") throw new Error("the chapter record is unreadable");
  const record = room.plan.record;
  const rows = proposal.rows.filter(row => record?.pictures?.[row.block] === undefined).map(row => {
    const block = room.plan.blocks.find(entry => entry.block.key === row.block);
    if (block === undefined || audiobookTextHash(block.block.text) !== row.textHash) throw new Error("the words changed · illustrate again");
    return refreshIllustrationRow(store, room, model, row);
  });
  const { aspect: _aspect, ...previous } = proposal;
  return { ...previous, rows, model: { id: model.id, provider: model.provider, name: model.displayName, references: referenceBudgetFor(model), ...(model.pricing.kind === "included-plan" ? { plan: "included-plan" as const } : {}) }, ...(pictureAspect(model) === undefined ? {} : { aspect: pictureAspect(model) }), coverage: chapterReferenceCoverage(store, productionId, room.plan, rows), refreshed: true, refreshedBlocks: rows.filter(row => illustrationReferencesChanged(proposal.rows.find(before => before.block === row.block)!, row)).map(row => row.block) };
}
