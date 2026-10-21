import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chapterPlaces, resolveChapterPlace } from "../../src/productions/audiobook-location.js";
import { briefRiders, holdBrief } from "../../src/productions/audiobook-picture-brief.js";
import type { WorldStore } from "../../src/world/store.js";

describe("location candidates and unresolved briefs (#1948)", () => {
  it("bounds exact candidates in prose order and clips authored Look context", () => {
    const sheets = Array.from({ length: 10 }, (_, i) => ({
      id: "place-" + i, name: "Place " + i, type: "location",
      sections: [{ heading: "Look", body: "Weathered stone and narrow windows. ".repeat(20) }],
    }));
    const store = { getBundle: () => ({ sheets }) } as unknown as Pick<WorldStore, "getBundle">;
    const places = chapterPlaces(store, { body: [...sheets].reverse().map(sheet => sheet.name).join(". ") });
    assert.deepEqual(places.map(place => place.key), ["place-9", "place-8", "place-7", "place-6", "place-5", "place-4", "place-3", "place-2"]);
    assert.ok(places.every(place => place.look !== undefined && place.look.length <= 200));
    assert.deepEqual(chapterPlaces(store, { body: "They found a place near the house." }), []);
  });

  it("uses an exact key or unambiguous full name, never an ambiguous or unknown guess", () => {
    const known = [{ key: "the-vigil", name: "The Vigil" }];
    assert.equal(resolveChapterPlace(known, "the-vigil"), known[0]);
    assert.equal(resolveChapterPlace(known, "Vigil"), known[0]);
    assert.deepEqual(resolveChapterPlace(known, " North Salt "), { key: "north salt", name: "North Salt", unlinked: true });
    assert.equal(resolveChapterPlace(known, null), undefined);
    assert.equal(resolveChapterPlace(known, "   "), undefined);
    assert.deepEqual(resolveChapterPlace([...known, { key: "other-vigil", name: "Vigil" }], "Vigil"), {
      key: "vigil", name: "Vigil", unlinked: true,
    });
  });

  it("keeps the unknown place visible without inventing a sheet or leaking it into detail references", () => {
    const prompt = "Wide shot of the shelter's trestle tables.";
    const ctx = { people: [], places: [], prompt, fallback: () => [] };
    const held = holdBrief({ frame: "Wide", inFrame: [], place: "North Salt", prompt }, ctx);
    assert.deepEqual(briefRiders(held), [{ key: "north salt", name: "North Salt", kind: "place" }]);
    assert.deepEqual(briefRiders({ ...held, frame: "Detail" }), []);
    assert.equal(held.place?.unlinked, true);
  });

  it("keeps canonical references for a full location name returned instead of its key", () => {
    const prompt = "Wide shot of the Vigil.";
    const held = holdBrief({ frame: "Wide", place: "Vigil", prompt }, {
      people: [], places: [{ key: "the-vigil", name: "The Vigil" }], prompt, fallback: () => [],
    });
    assert.deepEqual(briefRiders(held), [{ key: "the-vigil", name: "The Vigil", sheet: "the-vigil", kind: "place" }]);
  });
});
