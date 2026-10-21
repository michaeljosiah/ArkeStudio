import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chapterCharacterCoverage, resolveReferenceCharacter, referenceCoverageCounts, type ChapterReferenceCoverage } from "../src/audiobook-reference-coverage.js";
import { ReferenceKitSchema } from "../src/reference.js";
import type { AudiobookLook } from "../src/audiobook-look.js";
const sheets = [{ id: "maren", name: "Maren Kest", type: "character" as const, aliases: ["Rena"], billing: "lead" as const }, { id: "els", name: "Els Tern", type: "character" as const, aliases: ["Els"], billing: "supporting" as const }];
const look: AudiobookLook = { chapterHash: "h", at: "2026-10-21T00:00:00Z", characters: { maren: { name: "Rena", sheet: "maren", text: "Her coat.", blocks: ["p1"] }, stranger: { name: "Stranger", text: "A cap." } } };
const kit = ReferenceKitSchema.parse({ sheetId: "maren", tiles: [], mainPhoto: { file: "face.png", source: "legacy" } });
describe("current reference identities", () => {
  it("uses exact authored aliases, never display-only partial names", () => {
    assert.equal(resolveReferenceCharacter({ key: "unknown", name: " RENA " }, sheets).state, "linked");
    assert.equal(resolveReferenceCharacter({ key: "unknown", name: "Kest" }, sheets).state, "unlinked");
    assert.equal(resolveReferenceCharacter({ key: "unknown", name: "Renata" }, sheets).state, "unlinked");
  });
  it("keeps collisions visible unless an explicit chapter choice resolves that source name", () => {
    const competing = [...sheets, { id: "other", name: "Rena", type: "character" as const }];
    assert.equal(resolveReferenceCharacter({ key: "rena", name: "Rena" }, competing).state, "ambiguous");
    assert.deepEqual(resolveReferenceCharacter({ key: "rena", name: "Rena" }, competing, look), { state: "linked", sheet: sheets[0] });
  });
  it("never rebounds a retired explicit identity by matching a different name", () => {
    const competing = [{ ...sheets[0]!, retired: true }, { id: "other", name: "Rena", type: "character" as const }];
    assert.equal(resolveReferenceCharacter({ key: "rena", name: "Rena" }, competing, look).state, "unlinked");
    assert.equal(resolveReferenceCharacter({ key: "rena", name: "Rena", sheet: "maren" }, competing).state, "unlinked");
  });
  it("keeps historical explicit sheet IDs stable when aliases change", () => {
    const renamed = [{ ...sheets[0]!, aliases: [] }];
    assert.deepEqual(resolveReferenceCharacter({ key: "rena", name: "Rena", sheet: "maren" }, renamed), { state: "linked", sheet: renamed[0] });
    assert.equal(resolveReferenceCharacter({ key: "rena", name: "Rena" }, renamed).state, "unlinked");
  });
});
describe("chapter reference evidence", () => {
  it("combines authored, exact named and prepared evidence without mutating the inputs", () => {
    const input = { body: "Rena meets Els. The stranger watches.", sheets, kits: [kit], look, blocks: [{ key: "p1", text: "Rena meets Els." }], pictures: [{ block: "p2", who: [{ key: "rena", name: "Rena", kind: "character" as const, reference: null, carried: false }] }] };
    const before = structuredClone(input); const rows = chapterCharacterCoverage(input);
    assert.deepEqual(rows.map(row => [row.name, row.state, row.blocks]), [["Maren Kest", "ready", ["p1", "p2"]], ["Stranger", "unlinked", []], ["Els Tern", "missing-reference", ["p1"]]]);
    assert.equal(rows[0]!.reference, "references/maren/face.png"); assert.deepEqual(input, before);
  });
  it("respects literal punctuation and never-depicted identities without claiming a reference", () => {
    const rows = chapterCharacterCoverage({ body: "Maren Kest meets [A].", sheets: [{ ...sheets[0]!, neverDepicted: true }, { id: "a", name: "[A]", type: "character" }], kits: [kit] });
    assert.equal(rows[0]!.state, "not-depicted"); assert.equal(rows[0]!.reference, undefined); assert.equal(rows[1]!.name, "[A]");
  });
  it("reports unresolved identities, missing references and bounded preparation separately", () => {
    const chapter: ChapterReferenceCoverage = { chapterId: "c", file: "c", title: "Chapter", order: 1, preparation: "stale", rows: [
      { kind: "character", key: "a", name: "A", blocks: [], state: "ambiguous" }, { kind: "character", key: "b", name: "B", blocks: [], state: "missing-reference" }, { kind: "place", key: "p", name: "a room", blocks: [], state: "needs-review" },
    ], bounds: { people: { limit: 24, omitted: 1 }, places: { limit: 8, omitted: 0 }, text: { limit: 60000, omitted: 0 } } };
    assert.deepEqual(referenceCoverageCounts(chapter), { unresolved: 1, missing: 1, review: 1, bounded: true });
  });
});
