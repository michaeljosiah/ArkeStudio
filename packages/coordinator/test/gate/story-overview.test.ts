import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StoryOverviewSchema } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { mergeJson, applyJsonResolution } from "../../src/gate/merge.js";
import { proposeStoryOverview, overviewSteer, draftSceneSkeleton } from "../../src/productions/ops.js";
import { sha256 } from "../../src/world/text-files.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The structured overview is authored through the gate (issue #385): staged whole, reviewed
 * field by field, rebased in the JSON lane — never through the Markdown merge — and accepted
 * into story.json with a version cut and a history snapshot.
 */

const CLOCK = () => "2026-08-19T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store) };
}

const OVERVIEW = {
  logline: "Four watches, two hundred years apart, written in the same hand.",
  spine: "The ledger answers whoever keeps it.",
  acts: [{ title: "Neap", summary: "The tide lower than ever." }, { title: "Spring" }],
  targetLength: "90k words",
};

describe("the story overview through the gate (issue 385)", () => {
  it("stages, reviews field by field, and accepts into a versioned story.json", async () => {
    const { dir, store, gate } = await open();
    const before = store.getBundle().productions.find((p) => p.meta.id === "the-ledger-of-nights")!.story!;

    const { proposalId } = await proposeStoryOverview(store, gate, {
      productionId: "the-ledger-of-nights",
      source: "form",
      overview: OVERVIEW,
    });

    // Nothing live changed at staging.
    const liveNow = store.getBundle().productions.find((p) => p.meta.id === "the-ledger-of-nights")!.story!;
    assert.deepEqual(liveNow, before, "staging writes nothing live");

    // The review projects every field — a reviewer never accepts a bare path.
    const scan = await scanWorld(dir);
    const staged = scan.bundle.proposals.find((p) => p.proposal.id === proposalId);
    assert.ok(staged?.review, "the proposal carries a review");
    const target = staged.review.targets[0]!;
    assert.equal(target.kind, "story overview");
    const fields = new Map(target.fields.map((f) => [f.field, f.proposed]));
    assert.equal(fields.get("Logline"), OVERVIEW.logline);
    assert.equal(fields.get("Spine"), OVERVIEW.spine);
    assert.equal(fields.get("Act 1 · Neap"), "The tide lower than ever.");
    assert.equal(fields.get("Target length"), OVERVIEW.targetLength);

    const accepted = await gate.accept(proposalId);
    assert.equal(accepted.status, "accepted");
    const after = await scanWorld(dir);
    const story = after.bundle.productions.find((p) => p.meta.id === "the-ledger-of-nights")!.story!;
    assert.equal(story.logline, OVERVIEW.logline);
    assert.equal(story.version, before.version + 1, "acceptance cuts a version");
    const history = await readFile(
      join(dir, ".history", "productions", "the-ledger-of-nights", "story", `v${story.version}.json`),
      "utf8",
    );
    assert.equal(StoryOverviewSchema.parse(JSON.parse(history)).logline, OVERVIEW.logline, "history snapshot exists");
  });

  it("refuses malformed JSON before a proposal exists, and out-of-scope JSON before acceptance", async () => {
    const { dir, store, gate } = await open();
    await assert.rejects(
      () =>
        gate.stage({
          kind: "story-overview",
          summary: "bad",
          source: "form",
          targets: [{ path: "productions/the-ledger-of-nights/story.json", content: '{"version":1,"weather":9}\n' }],
        }),
      /not a story overview/,
      "an unknown key is refused at staging",
    );

    // A proposal whose file went out of scope after staging (agent or hand edit) is refused at
    // accept with the file named — never committed.
    const { proposalId } = await proposeStoryOverview(store, gate, {
      productionId: "the-ledger-of-nights",
      source: "form",
      overview: OVERVIEW,
    });
    await writeFile(
      join(dir, ".proposals", proposalId, "productions", "the-ledger-of-nights", "story.json"),
      '{"version":1,"logline":42}\n',
      "utf8",
    );
    const result = await gate.accept(proposalId);
    assert.equal(result.status, "invalid");
    assert.match(result.problems![0]!.message, /not a story overview/);
  });

  it("a stale overview rebases in the JSON lane: field merge, no frontmatter fences", async () => {
    const { dir, store, gate } = await open();
    const { proposalId } = await proposeStoryOverview(store, gate, {
      productionId: "the-ledger-of-nights",
      source: "form",
      overview: OVERVIEW,
    });

    // The live overview moves underneath the proposal — a disjoint field.
    const livePath = join(dir, "productions", "the-ledger-of-nights", "story.json");
    const live = JSON.parse(await readFile(livePath, "utf8")) as Record<string, unknown>;
    await store.commit({
      kind: "story-overview",
      source: "test",
      files: [
        {
          path: "productions/the-ledger-of-nights/story.json",
          action: "replace",
          content: JSON.stringify({ ...live, targetLength: "60k words" }, null, 2) + "\n",
          baseHash: sha256(await readFile(livePath, "utf8")),
        },
      ],
    });

    const { conflicts } = await gate.rebase(proposalId);
    const proposed = await readFile(
      join(dir, ".proposals", proposalId, "productions", "the-ledger-of-nights", "story.json"),
      "utf8",
    );
    assert.ok(!proposed.startsWith("---"), "the merged file is JSON, not frontmatter-fenced Markdown");
    const merged = StoryOverviewSchema.parse(JSON.parse(proposed));
    assert.equal(merged.logline, OVERVIEW.logline, "mine kept where only mine changed");
    // targetLength conflicts: mine proposed 90k while live moved to 60k from the same base.
    const conflict = conflicts.find((c) => c.field === "targetLength");
    assert.ok(conflict, "the same-field edit is a conflict, not a silent overwrite");

    await gate.resolveConflict(proposalId, "productions/the-ledger-of-nights/story.json", "targetLength", "theirs");
    const resolved = StoryOverviewSchema.parse(
      JSON.parse(
        await readFile(
          join(dir, ".proposals", proposalId, "productions", "the-ledger-of-nights", "story.json"),
          "utf8",
        ),
      ),
    );
    assert.equal(resolved.targetLength, "60k words", "the chosen side lands as valid JSON");
  });

  it("the accepted overview steers scene and chapter drafting", async () => {
    const { store, gate } = await open();
    const production = store.getBundle().productions.find((p) => p.meta.id === "the-ledger-of-nights")!;
    assert.ok(production.story, "the fixture has an accepted overview");
    const steer = overviewSteer(production.story);
    assert.match(steer, /steers this draft/);
    assert.match(steer, new RegExp(`v${production.story.version}`));

    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "the-ledger-of-nights",
      brief: "The ledger is opened at night.",
    });
    assert.match(draft.instruction, /accepted story overview/, "scene drafting carries the overview");
  });

  it("mergeJson keeps the machine version field from the live side", () => {
    const base = JSON.stringify({ version: 3, logline: "a" });
    const mine = JSON.stringify({ version: 3, logline: "b" });
    const theirs = JSON.stringify({ version: 4, logline: "a" });
    const result = mergeJson("p", base, mine, theirs);
    const merged = JSON.parse(result.merged) as { version: number; logline: string };
    assert.equal(merged.version, 4, "the committer's field follows the live document");
    assert.equal(merged.logline, "b", "my edit survives");
    assert.deepEqual(result.conflicts, []);
  });

  it("applyJsonResolution round-trips values that look like numbers", () => {
    const conflict = { path: "p", field: "logline", base: null, mine: '"1747"', theirs: '"one"' };
    const resolved = applyJsonResolution('{"version":1,"logline":"x"}', conflict, "mine");
    assert.equal((JSON.parse(resolved) as { logline: string }).logline, "1747", "a numeric-looking string stays a string");
  });
});
