import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProposalManager } from "../../src/gate/proposals.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PATH = "productions/the-ledger-of-nights/chapters/01-neap.md";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: () => "2026-09-03T12:00:00.000Z" });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store) };
}

describe("chapter proposals are reviewable before the dormant draft flow converts", () => {
  it("projects prose and semantic frontmatter instead of a file path", async () => {
    const { dir, gate } = await open();
    const live = await readFile(join(dir, ...PATH.split("/")), "utf8");
    const chapter = MarkdownFile.parse(live);
    chapter.setData({
      status: "revised",
      draws: { sheets: ["maren-kest"], canon: ["CANON-001"] },
      synopsis: "The ledger opens.",
      pov: "maren-kest",
      when: "Neap · first night",
      implies: [{ kind: "canon", what: "The bells can ring uncalled." }],
      draftedAgainst: 3,
    });
    chapter.setBody("The ledger opens under a moonless tide.");
    const proposal = await gate.stage({
      kind: "chapter-draft",
      summary: "Draft the opening chapter",
      source: "test",
      targets: [{ path: PATH, content: chapter.serialize() }],
    });

    const staged = (await scanWorld(dir)).bundle.proposals.find((item) => item.proposal.id === proposal.id);
    assert.ok(staged?.review);
    const target = staged.review.targets[0]!;
    assert.match(target.kind, /^chapter/);
    const fields = new Map(target.fields.map((field) => [field.field, field.proposed]));
    assert.equal(fields.get("Status"), "revised");
    assert.equal(fields.get("Draws from sheets"), "maren-kest");
    assert.equal(fields.get("Draws from canon"), "CANON-001");
    assert.equal(fields.get("Prose"), "The ledger opens under a moonless tide.");
    // The plan is reviewed beside the prose (turn 127).
    assert.equal(fields.get("Synopsis"), "The ledger opens.");
    assert.equal(fields.get("Point of view"), "maren-kest");
    assert.equal(fields.get("When"), "Neap · first night");
    assert.equal(fields.get("Implies"), "canon: The bells can ring uncalled.");
    assert.equal(fields.get("Drafted against"), "overview v3");
  });

  it("rejects malformed chapter frontmatter both before staging and before acceptance", async () => {
    const { dir, gate } = await open();
    await assert.rejects(
      () => gate.stage({
        kind: "chapter-draft",
        summary: "Malformed chapter",
        source: "test",
        targets: [{ path: PATH, content: "---\nid: neap\ntitle: Neap\nversion: nope\n---\n\nProse.\n" }],
      }),
      /not a chapter/,
    );

    const proposal = await gate.stage({
      kind: "chapter-draft",
      summary: "Draft the opening chapter",
      source: "test",
      targets: [{ path: PATH }],
    });
    await writeFile(
      join(dir, ".proposals", proposal.id, ...PATH.split("/")),
      "---\nid: neap\ntitle: Neap\nversion: nope\n---\n\nProse.\n",
      "utf8",
    );
    const problems = await gate.recordProblems(proposal.id);
    assert.match(problems[0]?.message ?? "", /not a chapter/);
    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "invalid");
    if (outcome.status === "invalid") assert.match(outcome.problems[0]?.message ?? "", /not a chapter/);
  });
});
