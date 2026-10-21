import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Proposal } from "@arke-studio/contracts";
import { buildSheetContent } from "../../src/sheets/authoring.js";
import { projectReview } from "../../src/gate/review.js";
import { MarkdownFile } from "../../src/world/text-files.js";

describe("sheet review presentation (#1982)", () => {
  for (const [type, folder] of [["character", "characters"], ["location", "locations"], ["faction", "factions"]] as const) {
    it(`distinguishes ${type} prose from metadata without losing changes or removals`, () => {
      const path = `${folder}/review.md`;
      const proposal: Proposal = { id: "pr_01J8H0000000000000000000Z9", kind: "new-sheet", summary: "Review", source: "test",
        targets: [{ path, baseVersion: null, baseHash: null }], baseCanonRevision: 1, reservedCanonIds: [], created: "2026-10-20T00:00:00Z", draftRevision: 1 };
      const doc = MarkdownFile.parse(buildSheetContent({ id: "review", type, name: "Review", status: "sketch", date: "2026-10-20", sections: {} }));
      doc.setBody("## Custom prose\n\nThe public passage stays clear.\n\n## Removed section\n\nOld words.");
      doc.setData({ role: "Keeper" });
      const base = doc.serialize();
      const creation = projectReview({ proposal, proposed: () => base, base: () => null }).targets[0]!;
      assert.equal(creation.fields.find(f => f.field === "Role")?.metadata, true);
      assert.equal(creation.fields.find(f => f.field === "Region")?.proposed, "None", "empty fields remain editable");
      assert.equal(creation.fields.find(f => f.field === "Custom prose")?.metadata, undefined);
      doc.setData({ role: "" });
      doc.setBody("## Custom prose\n\nThe public passage stays clear.\n\n## Name\n\nA custom section sharing a metadata label.");
      const amended = projectReview({ proposal, proposed: () => doc.serialize(), base: () => base }).targets[0]!;
      assert.equal(amended.action, "amend");
      assert.equal(amended.fields.find(f => f.field === "Role")?.before, "Keeper");
      assert.equal(amended.fields.find(f => f.field === "Role")?.proposed, "");
      assert.equal(amended.fields.find(f => f.field === "Role")?.metadata, true);
      assert.equal(amended.fields.find(f => f.field === "Removed section")?.proposed, null);
      assert.equal(amended.fields.find(f => f.field === "Name")?.metadata, undefined, "a section remains prose even with a metadata heading");
      assert.equal(amended.fields.some(f => f.field === "Custom prose"), false, "unchanged prose remains omitted");
    });
  }
});


it("shows the exact character identity names added and removed in a review", () => {
  const path = "characters/review.md";
  const proposal: Proposal = { id: "pr_01J8H0000000000000000000Z9", kind: "sheet-edit", summary: "Other names", source: "form",
    targets: [{ path, baseVersion: 1, baseHash: "base" }], baseCanonRevision: 1, reservedCanonIds: [], created: "2026-10-21T00:00:00Z", draftRevision: 1 };
  const doc = MarkdownFile.parse(buildSheetContent({ id: "review", type: "character", name: "Review", status: "sketch", date: "2026-10-21", sections: {} }));
  const base = doc.serialize(); doc.setData({ aliases: ["Rena", "Harbour witness"] }); const written = doc.serialize();
  const added = projectReview({ proposal, proposed: () => written, base: () => base }).targets[0]!;
  assert.deepEqual(added.fields, [{ field: "Other names", before: "None", proposed: "Rena\nHarbour witness", metadata: true }]);
  const cleared = projectReview({ proposal, proposed: () => base, base: () => written }).targets[0]!;
  assert.deepEqual(cleared.fields, [{ field: "Other names", before: "Rena\nHarbour witness", proposed: "None", metadata: true }]);
});
