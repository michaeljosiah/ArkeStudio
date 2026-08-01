import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorldIndex } from "../../src/index-db/world-index.js";
import {
  contradictionCandidates,
  ftsQuery,
  needsYou,
  refsForCanon,
  refsForSheet,
  ripplesForCanonEntry,
  ripplesForSheet,
  searchCanon,
} from "../../src/index-db/queries.js";
import { makeTempWorld } from "../world/helpers.js";
import { fixtureBundle } from "./helpers.js";

async function openFixtureIndex() {
  const dir = await makeTempWorld();
  const bundle = await fixtureBundle();
  return { index: WorldIndex.open(dir, bundle), bundle };
}

describe("reference queries (R-11, R-12)", () => {
  it("answers the sheet card's numbers from the index alone", async () => {
    const { index } = await openFixtureIndex();
    const refs = refsForSheet(index.db, "maren-kest");
    assert.equal(refs.tiles, 3);
    assert.deepEqual(refs.productions, ["saltlight"]);
    assert.deepEqual(refs.scenes, ["sh_12"]);
    assert.deepEqual(refs.takesByVersion, { 3: 1, 4: 2 });
    index.close();
  });

  it("answers a canon entry's cited-by from the index alone", async () => {
    const { index } = await openFixtureIndex();
    const refs = refsForCanon(index.db, "CANON-002");
    assert.deepEqual(refs.sheets, [{ id: "maren-kest", atVersion: 4 }]);
    assert.ok(refs.takesByRevision[41]! >= 1 && refs.takesByRevision[42]! >= 1);
    index.close();
  });
});

describe("ripple queries (R-13) — from the index, never a model", () => {
  it("produces the sheet ripple set with honest counts", async () => {
    const { index } = await openFixtureIndex();
    const ripples = ripplesForSheet(index.db, { sheetId: "maren-kest", sheetName: "Maren Kest", newVersion: 5 });
    const byKind = new Map(ripples.map((r) => [r.kind, r]));

    assert.match(byKind.get("stale-reference-tiles")!.summary, /^3 reference tiles predate v5/);
    assert.deepEqual(byKind.get("productions-pick-up")!.targets, ["saltlight"]);
    assert.deepEqual(byKind.get("scene-briefs-rerender")!.targets, ["sc_04"]);
    assert.deepEqual(byKind.get("owning-canon-rules")!.targets, ["CANON-002"]);
    assert.deepEqual(byKind.get("takes-pinned-to-old-version")!.targets, ["tk_01J8F0000000000000000000B2"]);
    index.close();
  });

  it("produces canon ripples: contradiction candidates, cross-references, productions", async () => {
    const { index } = await openFixtureIndex();
    const ripples = ripplesForCanonEntry(index.db, {
      entryId: "CANON-002",
      title: "Tide-calling",
      statement: "A caller cannot move a tide she has not stood in.",
    });
    const kinds = ripples.map((r) => r.kind);
    assert.ok(kinds.includes("contradiction-candidates"));
    assert.ok(kinds.includes("productions-see-new-revision"));
    const contradiction = ripples.find((r) => r.kind === "contradiction-candidates")!;
    assert.ok(!contradiction.targets.includes("CANON-002"), "the entry never contradicts itself");
    assert.match(contradiction.summary, /judgement is yours, nothing blocks/);
    index.close();
  });
});

describe("search and the refusal floor (R-16..R-19, R-23, D8)", () => {
  it("ranks the on-topic entry first", async () => {
    const { index } = await openFixtureIndex();
    const result = searchCanon(index.db, "tide calling");
    assert.equal(result.floorCleared, true);
    assert.equal(result.candidates[0]!.entryId, "CANON-002");
    assert.ok(result.candidates[0]!.statement.includes("stood in"), "full statement text returned (R-23)");
    index.close();
  });

  it("reports the searched count truthfully (R-18)", async () => {
    const { index } = await openFixtureIndex();
    assert.equal(searchCanon(index.db, "anything at all").searched, 6);
    index.close();
  });

  it("refuses below the floor with closest entries as receipts, and no model in the path (R-17, D8)", async () => {
    const { index } = await openFixtureIndex();
    const result = searchCanon(index.db, "bicycle warranty paperwork");
    assert.equal(result.floorCleared, false);
    assert.ok(result.candidates.length <= 3);
    // Structural: this module has no model dependency to call — the refusal renders from
    // retrieval alone. The assertion is that the result is complete in itself.
    assert.equal(result.searched, 6);
    index.close();
  });

  it("sanitises hostile FTS syntax rather than throwing", async () => {
    const { index } = await openFixtureIndex();
    assert.doesNotThrow(() => searchCanon(index.db, 'tide-calling: "cost"? (hearing) AND OR NOT *'));
    assert.equal(ftsQuery("!!! ???"), null);
    assert.doesNotThrow(() => searchCanon(index.db, "!!!"));
    index.close();
  });

  it("surfaces contradiction candidates as an aid, never a block (R-19)", async () => {
    const { index } = await openFixtureIndex();
    const candidates = contradictionCandidates(index.db, {
      title: "Tide debts",
      statement: "Every verse the caller spends is hearing the harbour keeps.",
    });
    assert.ok(candidates.length > 0, "shared vocabulary is surfaced");
    assert.ok(candidates.some((c) => c.entryId === "CANON-002"));
    index.close();
  });
});

describe("needs-you (R-14) — computed, never stored", () => {
  it("derives the queue from world and job state", async () => {
    const { bundle } = await openFixtureIndex().then(async (x) => {
      x.index.close();
      return x;
    });
    const items = needsYou(bundle, [
      {
        id: "jb_01J8E0000000000000000000J6",
        idempotencyKey: "01J8E1000000000000000000K6",
        worldId: bundle.meta.worldId,
        target: { kind: "voice-line" },
        provider: "elevenlabs",
        model: "eleven-v3",
        params: {},
        estimatedMicroUsd: 6000,
        status: "failed",
        providerJobId: null,
        error: "timeout",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ]);
    const kinds = items.map((i) => i.kind);
    assert.ok(kinds.includes("proposal"), "the staged fixture proposal is surfaced");
    assert.ok(kinds.includes("review"), "takes without a decision are surfaced");
    assert.ok(kinds.includes("failed-job"));
    const review = items.find((i) => i.kind === "review")!;
    assert.equal(review.count, 2, "tk_A1 (frame) and tk_D4 await review");
  });
});
