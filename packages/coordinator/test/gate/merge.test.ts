import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SheetSchema } from "@arke-studio/contracts";
import { applyResolution, mergeMarkdown } from "../../src/gate/merge.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { splitSections } from "../../src/frontmatter.js";

const BASE = `---
id: maren-kest
type: character
name: Maren Kest
role: Tide-caller
version: 4
status: locked
canonRules: [CANON-002]
links: [bray-half-hitch]
created: "2026-05-02"
updated: "2026-07-14"
---

## Essence
She hears the verse.

## Appearance
Salt-crusted braids.

## Voice · written
Low and even.
`;

function edit(raw: string, fn: (doc: MarkdownFile) => void): string {
  const doc = MarkdownFile.parse(raw);
  fn(doc);
  return doc.serialize();
}

function sectionsOf(raw: string): Map<string, string> {
  return new Map(splitSections(MarkdownFile.parse(raw).body).map((s) => [s.heading, s.body]));
}

/** Every merge output must parse as a valid sheet (SPEC-004 D3, DoD). */
function assertValidSheet(raw: string): void {
  const doc = MarkdownFile.parse(raw);
  SheetSchema.parse({ ...doc.data, type: "character", sections: splitSections(doc.body) });
}

describe("field-level three-way merge (R-6, D3, D4)", () => {
  it("merges disjoint section edits silently — the common two-session case", () => {
    const mine = edit(BASE, (d) => d.setBody(d.body.replace("Salt-crusted braids.", "Iron-grey braids.")));
    const theirs = edit(BASE, (d) => d.setBody(d.body.replace("Low and even.", "Lower than the tide.")));
    const { merged, conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.deepEqual(conflicts, []);
    const sections = sectionsOf(merged);
    assert.equal(sections.get("Appearance"), "Iron-grey braids.");
    assert.equal(sections.get("Voice · written"), "Lower than the tide.");
    assert.equal(sections.get("Essence"), "She hears the verse.");
    assertValidSheet(merged);
  });

  it("reports a same-field edit as a conflict and never auto-resolves (D4)", () => {
    const mine = edit(BASE, (d) => d.setBody(d.body.replace("Salt-crusted braids.", "Iron-grey braids.")));
    const theirs = edit(BASE, (d) => d.setBody(d.body.replace("Salt-crusted braids.", "White braids.")));
    const { conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.field, "Appearance");
    assert.equal(conflicts[0]!.mine, "Iron-grey braids.");
    assert.equal(conflicts[0]!.theirs, "White braids.");
  });

  it("merges a section added on one side and one removed on the other", () => {
    const mine = edit(BASE, (d) => d.setBody(d.body + "\n\n## Relationships\nTrusts Bray."));
    const theirs = edit(BASE, (d) =>
      d.setBody(d.body.replace("## Voice · written\nLow and even.\n", "").trim()),
    );
    const { merged, conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.deepEqual(conflicts, []);
    const sections = sectionsOf(merged);
    assert.equal(sections.get("Relationships"), "Trusts Bray.");
    assert.equal(sections.has("Voice · written"), false, "their removal survives");
    assertValidSheet(merged);
  });

  it("conflicts when one side removed a section the other edited", () => {
    const mine = edit(BASE, (d) => d.setBody(d.body.replace("Low and even.", "Sharpened.")));
    const theirs = edit(BASE, (d) =>
      d.setBody(d.body.replace("## Voice · written\nLow and even.\n", "").trim()),
    );
    const { conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.field, "Voice · written");
    assert.equal(conflicts[0]!.theirs, null);
  });

  it("merges list frontmatter as sets — both additions survive, removals hold (§3.2)", () => {
    const mine = edit(BASE, (d) => d.setData({ links: ["bray-half-hitch", "the-chorister"] }));
    const theirs = edit(BASE, (d) => d.setData({ links: ["the-vigil"], canonRules: ["CANON-002", "CANON-007"] }));
    const { merged, conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.deepEqual(conflicts, []);
    const doc = MarkdownFile.parse(merged);
    // mine added the-chorister; theirs removed bray-half-hitch and added the-vigil.
    assert.deepEqual(doc.data["links"], ["the-chorister", "the-vigil"]);
    assert.deepEqual(doc.data["canonRules"], ["CANON-002", "CANON-007"]);
    assertValidSheet(merged);
  });

  it("conflicts scalar frontmatter edited on both sides", () => {
    const mine = edit(BASE, (d) => d.setData({ role: "Tide-caller of the Vigil" }));
    const theirs = edit(BASE, (d) => d.setData({ role: "Last tide-caller" }));
    const { conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.field, "role");
  });

  it("carries machine fields from the live side so the committer's stamps are not fought", () => {
    const theirs = edit(BASE, (d) => {
      d.setData({ version: 5, updated: "2026-08-01" });
      d.setBody(d.body.replace("Low and even.", "Quieter."));
    });
    const mine = edit(BASE, (d) => d.setBody(d.body.replace("Salt-crusted braids.", "Iron-grey braids.")));
    const { merged, conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    assert.deepEqual(conflicts, []);
    assert.equal(MarkdownFile.parse(merged).data["version"], 5);
  });

  it("merges plain-prose bodies (canon entries) as one field", () => {
    const base = '---\nid: CANON-002\ntype: rule\ntitle: Tide-calling\nstatus: settled\nintroducedAt: 1\nlinks: []\n---\n\nA caller cannot move a tide she has not stood in.\n';
    const mine = base.replace("stood in.", "stood in, ever.");
    const theirs = base; // untouched live
    const { merged, conflicts } = mergeMarkdown("canon/CANON-002.md", base, mine, theirs);
    assert.deepEqual(conflicts, []);
    assert.ok(merged.includes("stood in, ever."));
  });

  it("applyResolution honours the human's choice per field", () => {
    const mine = edit(BASE, (d) => d.setBody(d.body.replace("Salt-crusted braids.", "Iron-grey braids.")));
    const theirs = edit(BASE, (d) => d.setBody(d.body.replace("Salt-crusted braids.", "White braids.")));
    const { merged, conflicts } = mergeMarkdown("characters/maren-kest.md", BASE, mine, theirs);
    const resolved = applyResolution("characters/maren-kest.md", merged, conflicts[0]!, "theirs");
    assert.equal(sectionsOf(resolved).get("Appearance"), "White braids.");
    assertValidSheet(resolved);
  });
});
