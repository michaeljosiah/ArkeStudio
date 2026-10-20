import assert from "node:assert/strict";
import { it } from "node:test";
import { referenceKitCounts, ReferenceKitSchema } from "../src/reference.js";

const kit = (extra = {}) => ReferenceKitSchema.parse({ sheetId: "bray", tiles: [], compilations: [], ...extra });
const compilation = (accepted: boolean, file = "sheet.png") => ({ file, accepted, format: "character-sheet", sheetVersion: 1, tiles: [], compiledAt: "2026-10-20T00:00:00Z", source: "local" });

it("counts accepted modern identity, the designated sheet and looks without needing index citations", () => {
  const modern = kit({ mainPhoto: { file: "photo.png", source: "upload" },
    compilations: [compilation(true), compilation(false, "candidate.png")],
    looks: [{ id: "ward", file: "ward.png", kind: "costume", prompt: "Ward visit", acceptedAt: "2026-10-20T00:00:00Z" }] });
  assert.deepEqual(referenceKitCounts(modern), { photos: 1, sheets: 1, looks: 1, views: 0, tiles: 0, total: 3 });
});
it("counts a legacy anchor once and excludes unaccepted, missing and superseded tiles", () => {
  const legacy = kit({ anchor: "front.png", tiles: [
    { angle: "head-front", file: "front.png", status: "locked" },
    { angle: "body-full", file: "body.png", status: "locked" },
    { angle: "body-back", status: "locked" },
    { angle: "expression", file: "candidate.png", status: "generated" },
    { angle: "expression", file: "old.png", status: "superseded" },
  ], compilations: [compilation(false)] });
  assert.deepEqual(referenceKitCounts(legacy), { photos: 1, sheets: 0, looks: 0, views: 0, tiles: 1, total: 2 });
  assert.equal(referenceKitCounts(kit()).total, 0);
  assert.equal(referenceKitCounts(null).total, 0);
});
it("counts only active location views and one designated accepted sheet", () => {
  const view = { id: "day", name: "Day", file: "day.png", sourceTakeId: "tk_01J8P0000000000000000000P0", sheetVersion: 1, artDirectionVersion: 1, acceptedAt: "2026-10-20T00:00:00Z" };
  const location = kit({ establishingViewId: "day", locationViews: [view, { ...view, id: "old", file: "old.png", status: "superseded" }], compilations: [compilation(true), compilation(true, "older-sheet.png")], designatedCompilation: "sheet.png" });
  assert.deepEqual(referenceKitCounts(location), { photos: 0, sheets: 1, looks: 0, views: 1, tiles: 0, total: 2 });
});
