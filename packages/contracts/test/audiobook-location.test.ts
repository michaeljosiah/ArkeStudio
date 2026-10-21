import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chapterLocationCoverage, locationNameAt, namedChapterLocations, sameLocationName } from "../src/audiobook-location.js";
import { ReferenceKitSchema } from "../src/reference.js";
import type { PictureWho } from "../src/audiobook-illustrate.js";

const locations = [
  { id: "the-vigil", name: "The Vigil", type: "location" },
  { id: "the-weigh-house", name: "The Weigh House", type: "location" },
  { id: "north-salt", name: "North Salt", type: "location" },
];
const kit = (sheetId: string, status: "active" | "superseded" = "active") => ReferenceKitSchema.parse({
  sheetId, tiles: [], locationViews: [{
    id: "view", name: "Establishing", file: "views/view.png", sourceTakeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2K3",
    sheetVersion: 1, artDirectionVersion: 1, acceptedAt: "2026-10-21T10:00:00.000Z", status,
  }], ...(status === "active" ? { establishingViewId: "view" } : {}),
});
const placeWho = (name: string, sheet?: string): PictureWho => ({
  key: name.toLowerCase(), name, kind: "place", reference: null, carried: false, ...(sheet ? { sheet } : {}),
});

describe("named location candidates (#1948)", () => {
  it("matches whole saved names, optional The, normalized hyphens and apostrophes", () => {
    assert.ok(locationNameAt("They entered the Vigil's watch room.", "The Vigil") >= 0);
    assert.ok(locationNameAt("They waited at the Weigh-House.", "The Weigh House") >= 0);
    assert.ok(locationNameAt("Widow’s Walk was empty.", "Widow's Walk") >= 0);
    assert.ok(locationNameAt("Gate [A] was open.", "Gate [A]") >= 0, "name punctuation is literal");
    assert.ok(sameLocationName(" The   Weigh-House ", "weigh house"));
    assert.equal(locationNameAt("the vigilante", "The Vigil"), -1);
    assert.equal(locationNameAt("North Saltworks", "North Salt"), -1);
    assert.equal(locationNameAt("The house by the market.", "The Weigh House"), -1);
    assert.equal(locationNameAt("Gate A was open.", "Gate [A]"), -1);
    assert.equal(locationNameAt("anywhere", " "), -1);
  });

  it("keeps source order and excludes retired locations and character names", () => {
    assert.deepEqual(namedChapterLocations("North Salt, then the Vigil, then the Weigh House.", [
      ...locations, { id: "salt-person", name: "North Salt", type: "character" },
      { id: "old-salt", name: "North Salt", type: "location", retired: true },
    ]).map(row => row.id), ["north-salt", "the-vigil", "the-weigh-house"]);
  });
});

describe("location coverage is review evidence (#1948)", () => {
  it("keeps the raw place description visible even when every recognized location has a view", () => {
    const input = {
      body: "They leave the Vigil.", sheets: locations, kits: [kit("the-vigil")],
      place: { text: "The Vigil and an unnamed municipal shelter.", blocks: ["p0", "p1", "p1"] },
      blocks: [{ key: "p0", text: "They leave the Vigil." }, { key: "p1", text: "The shelter opens." }],
    };
    const before = structuredClone(input);
    const result = chapterLocationCoverage(input);
    assert.deepEqual(result.rows, [
      { key: "the-vigil", name: "The Vigil", blocks: ["p0"], sheet: "the-vigil", state: "ready", reference: "references/the-vigil/views/view.png" },
      { key: "description:place", name: input.place.text, blocks: ["p0", "p1"], state: "needs-review" },
    ]);
    assert.deepEqual(input, before, "coverage never writes author decisions or picture state");
  });

  it("requires accepted active location views, not a main photo or a character portrait", () => {
    const photo = ReferenceKitSchema.parse({ sheetId: "the-weigh-house", tiles: [], mainPhoto: { file: "portrait.png", source: "legacy" } });
    const result = chapterLocationCoverage({
      body: "The Vigil, the Weigh House and North Salt.", sheets: locations,
      kits: [kit("the-vigil"), photo, kit("north-salt", "superseded"), kit("maren-kest")],
    });
    assert.deepEqual(result.rows.map(row => [row.key, row.state, row.reference]), [
      ["the-vigil", "ready", "references/the-vigil/views/view.png"],
      ["the-weigh-house", "missing-reference", undefined],
      ["north-salt", "missing-reference", undefined],
    ]);
  });

  it("retains unresolved prepared places and their block evidence without silently linking a name", () => {
    const result = chapterLocationCoverage({
      body: "", sheets: locations, kits: [kit("north-salt")],
      pictures: [
        { block: "p1", who: [placeWho("North Salt")] },
        { block: "p2", who: [placeWho("North Salt")] },
        { block: "p2", who: [placeWho("North Salt")] },
        { block: "p3", who: [placeWho("North Salt", "north-salt")] },
      ],
    });
    assert.deepEqual(result.rows, [
      { key: "unlinked-place:north salt", name: "North Salt", blocks: ["p1", "p2"], state: "unlinked" },
      { key: "north-salt", name: "North Salt", blocks: ["p3"], sheet: "north-salt", state: "ready", reference: "references/north-salt/views/view.png" },
    ]);
  });

  it("shows competing names as ambiguous and does not accept a retired link", () => {
    const result = chapterLocationCoverage({
      body: "", sheets: [...locations, { id: "north-salt-other", name: "The North Salt", type: "location" },
        { id: "old-house", name: "Old House", type: "location", retired: true }], kits: [kit("old-house")],
      pictures: [{ block: "p0", who: [placeWho("North Salt"), placeWho("Old House", "old-house")] }],
    });
    assert.deepEqual(result.rows.map(row => [row.name, row.state, row.sheet]), [
      ["North Salt", "ambiguous", undefined], ["Old House", "unlinked", undefined],
    ]);
  });

  it("discloses the eight-place prompt bound without hiding further known settings", () => {
    const sheets = Array.from({ length: 10 }, (_, i) => ({ id: "place-" + i, name: "Place " + i, type: "location" }));
    const result = chapterLocationCoverage({ body: sheets.map(sheet => sheet.name).join(". "), sheets, kits: [] });
    assert.equal(result.limit, 8);
    assert.equal(result.omitted, 2);
    assert.equal(result.rows.length, 10);
    assert.ok(result.rows.every(row => row.state === "missing-reference"));
  });
});
