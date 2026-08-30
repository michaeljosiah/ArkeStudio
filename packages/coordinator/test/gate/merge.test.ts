import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SheetSchema } from "@arke-studio/contracts";
import { applyResolution, mergeJson, mergeMarkdown } from "../../src/gate/merge.js";
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

describe("a scene's structure is ONE field, however it is spelled (SPEC-029 R-1, issue 601)", () => {
  /*
   * The failure this closes: Arke stages a shot amendment against a legacy scene, somebody
   * saves the same scene in the storyboard (which migrates it), and the rebase merges the
   * proposal's `shots` beside the live `flow`. The union then refuses the target, and no
   * resolution of the `shots` conflict can save it — the proposal is stranded.
   */
  const shot = (id: string, number: number, description: string) => ({
    id,
    number,
    title: `Shot ${number}`,
    description,
  });
  const legacy = (shots: ReturnType<typeof shot>[], version = 3) =>
    JSON.stringify({
      id: "sc_01",
      slug: "the-verse",
      number: 1,
      title: "The verse",
      status: "draft",
      version,
      shots,
    });
  const migrated = (raw: string, version = 4): string => {
    const scene = JSON.parse(raw) as { shots: ReturnType<typeof shot>[] };
    const { shots, ...base } = scene;
    const nodes = [
      { id: "sfn_sc-01-entry", kind: "entry" },
      ...shots.map((s) => ({ id: `sfn_${s.id.replace("_", "-")}`, kind: "shot", shot: s })),
      { id: "sfn_sc-01-exit", kind: "exit" },
    ];
    const edges = nodes.slice(1).map((to, index) => {
      const from = nodes[index]!;
      const token = (n: (typeof nodes)[number]) =>
        n.kind === "shot" ? (n as { shot: { id: string } }).shot.id.replace("_", "-") : n.kind;
      return {
        id: `sfe_${token(from)}-${token(to)}`,
        kind: "sequence",
        from: { nodeId: from.id, port: "out" },
        to: { nodeId: to.id, port: "in" },
      };
    });
    return JSON.stringify({
      ...base,
      version,
      flow: {
        schemaVersion: 1,
        entryNodeId: "sfn_sc-01-entry",
        exitNodeId: "sfn_sc-01-exit",
        nodes,
        edges,
        storyboardGroups: [],
      },
    });
  };

  const A = shot("sh_1", 1, "The tide turns.");
  const B = shot("sh_2", 2, "The verse rises.");

  it("carries a legacy amendment across a live migration without producing both fields", () => {
    const base = legacy([A, B]);
    const mine = legacy([A, { ...B, description: "The verse rises, and the room answers." }]);
    const theirs = migrated(base);

    const merged = JSON.parse(mergeJson("productions/p/scenes/01.json", base, mine, theirs).merged) as Record<
      string,
      unknown
    >;
    assert.equal("flow" in merged && "shots" in merged, false, "one structural field, never both");
    assert.ok("shots" in merged, "the proposal's answer is the array the gate re-derives at accept");
    const shots = merged["shots"] as ReturnType<typeof shot>[];
    assert.equal(shots[1]?.description, "The verse rises, and the room answers.");
  });

  it("keeps the live migration when the proposal changed nothing structural", () => {
    const base = legacy([A, B]);
    const theirs = migrated(base);
    const merged = JSON.parse(mergeJson("productions/p/scenes/01.json", base, base, theirs).merged) as Record<
      string,
      unknown
    >;
    assert.ok("flow" in merged, "a migration nobody contradicted stands");
    assert.equal("shots" in merged, false);
  });

  it("raises ONE conflict when both sides changed the shots, not two half-answers", () => {
    const base = legacy([A, B]);
    const mine = legacy([A, { ...B, description: "mine" }]);
    const theirs = migrated(legacy([A, { ...B, description: "theirs" }]));

    const result = mergeJson("productions/p/scenes/01.json", base, mine, theirs);
    const structural = result.conflicts.filter((c) => c.field === "shots" || c.field === "flow");
    assert.equal(structural.length, 1, "one field, one conflict");
    const merged = JSON.parse(result.merged) as Record<string, unknown>;
    assert.equal("flow" in merged && "shots" in merged, false);
  });
});

describe("a change that lives only in the graph survives a rebase (codex round 2 on #653)", () => {
  /*
   * The mirror of the case above, and the one comparing ordered shots alone gets wrong: a
   * proposal can change nothing but the graph — an authored beat, a node identity — and shot
   * payloads then say "mine is the base", so the merge takes the live flow and the approved
   * edit is discarded with no conflict to show for it.
   */
  const shot = (id: string, number: number) => ({
    id,
    number,
    title: `Shot ${number}`,
    description: `Beat ${number}.`,
  });
  const nodeId = (id: string) => `sfn_${id.replace("_", "-")}`;
  const graphScene = (over: Record<string, unknown> = {}, version = 4) => {
    const shots = [shot("sh_1", 1), shot("sh_2", 2)];
    const nodes = [
      { id: "sfn_sc-01-entry", kind: "entry" },
      ...shots.map((s) => ({ id: nodeId(s.id), kind: "shot", shot: s })),
      { id: "sfn_sc-01-exit", kind: "exit" },
    ];
    const token = (n: { kind: string; shot?: { id: string } }) =>
      n.kind === "shot" ? n.shot!.id.replace("_", "-") : n.kind;
    const edges = nodes.slice(1).map((to, index) => ({
      id: `sfe_${token(nodes[index]!)}-${token(to)}`,
      kind: "sequence",
      from: { nodeId: nodes[index]!.id, port: "out" },
      to: { nodeId: to.id, port: "in" },
    }));
    return JSON.stringify({
      id: "sc_01",
      slug: "the-verse",
      number: 1,
      title: "The verse",
      status: "draft",
      version,
      flow: {
        schemaVersion: 1,
        entryNodeId: "sfn_sc-01-entry",
        exitNodeId: "sfn_sc-01-exit",
        nodes,
        edges,
        storyboardGroups: [],
        ...over,
      },
    });
  };

  it("keeps an authored beat the proposal added, when the live scene only moved elsewhere", () => {
    const base = graphScene();
    const beat = { id: "sbg_the-rail", title: "At the rail", shotNodeIds: [nodeId("sh_1")] };
    const mine = graphScene({ storyboardGroups: [beat] });
    // Something unrelated moved live, which is what triggers a rebase at all.
    const theirs = JSON.stringify({ ...(JSON.parse(base) as object), title: "The verse, again", version: 5 });

    const merged = JSON.parse(mergeJson("productions/p/scenes/01.json", base, mine, theirs).merged) as {
      flow?: { storyboardGroups?: unknown[] };
      title?: string;
    };
    assert.deepEqual(merged.flow?.storyboardGroups, [beat], "the authored beat is not discarded");
    assert.equal(merged.title, "The verse, again", "and the live edit it rebased onto still lands");
  });

  it("treats a permutation of the live arrays as no change at all (R-18)", () => {
    const base = graphScene();
    const parsed = JSON.parse(base) as { flow: { nodes: unknown[]; edges: unknown[] } };
    const theirs = JSON.stringify({
      ...parsed,
      version: 5,
      flow: { ...parsed.flow, nodes: [...parsed.flow.nodes].reverse(), edges: [...parsed.flow.edges].reverse() },
    });
    const beat = { id: "sbg_the-rail", title: "At the rail", shotNodeIds: [nodeId("sh_1")] };
    const mine = graphScene({ storyboardGroups: [beat] });

    const result = mergeJson("productions/p/scenes/01.json", base, mine, theirs);
    assert.deepEqual(
      result.conflicts.filter((c) => c.field === "shots"),
      [],
      "a reordering is not a competing structural change",
    );
    const merged = JSON.parse(result.merged) as { flow?: { storyboardGroups?: unknown[] } };
    assert.deepEqual(merged.flow?.storyboardGroups, [beat]);
  });
});
