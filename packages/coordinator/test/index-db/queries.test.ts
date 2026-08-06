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
  searchSheets,
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
    assert.equal(searchCanon(index.db, "anything at all").searched, 5);
    index.close();
  });

  it("refuses below the floor with closest entries as receipts, and no model in the path (R-17, D8)", async () => {
    const { index } = await openFixtureIndex();
    const result = searchCanon(index.db, "bicycle warranty paperwork");
    assert.equal(result.floorCleared, false);
    assert.ok(result.candidates.length <= 3);
    // Structural: this module has no model dependency to call — the refusal renders from
    // retrieval alone. The assertion is that the result is complete in itself.
    assert.equal(result.searched, 5);
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
        capability: "voice-tts",
        provider: "elevenlabs",
        model: "eleven-v3",
        params: {},
        estimatedMicroUsd: 6000,
        status: "failed",
        providerJobId: null,
        attempt: 1,
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

describe("sheet search (#70 §9.2)", () => {
  it("finds a character by name", async () => {
    const { index } = await openFixtureIndex();
    const result = searchSheets(index.db, "Maren Kest");
    assert.equal(result.floorCleared, true);
    assert.equal(result.candidates[0]!.sheetId, "maren-kest");
    index.close();
  });

  it("ranks the sheet named for a term above one that merely mentions it", async () => {
    const { index } = await openFixtureIndex();
    // "Bray" is Bray Half-Hitch's name and also appears in Maren's Relationships prose.
    const result = searchSheets(index.db, "Bray");
    const ids = result.candidates.map((c) => c.sheetId);
    assert.ok(ids.includes("bray-half-hitch"));
    assert.ok(ids.includes("maren-kest"), "the passing mention is still found");
    assert.equal(
      ids[0],
      "bray-half-hitch",
      "asking about Bray must surface Bray, not the sheet that talks about him",
    );
    index.close();
  });

  it("finds an entity by the role that distinguishes it", async () => {
    const { index } = await openFixtureIndex();
    const ids = searchSheets(index.db, "tide-caller").candidates.map((c) => c.sheetId);
    assert.ok(ids.includes("maren-kest"));
    index.close();
  });

  it("finds an entity by its authored prose", async () => {
    const { index } = await openFixtureIndex();
    const ids = searchSheets(index.db, "oilskin").candidates.map((c) => c.sheetId);
    assert.deepEqual(ids, ["maren-kest"]);
    index.close();
  });

  it("narrows to one kind and counts only that kind as searched", async () => {
    const { index } = await openFixtureIndex();
    const result = searchSheets(index.db, "harbour", { kind: "character" });
    assert.equal(result.searched, 3, "three character sheets in the fixture");
    for (const c of result.candidates) assert.equal(c.kind, "character");
    index.close();
  });

  it("does not index operational metadata", async () => {
    const { index } = await openFixtureIndex();
    // Maren carries an ElevenLabs assignment with voiceId v_8Kq2. Neither is world knowledge,
    // and a search that hit them would let the Studio cite a voice ID as though it were prose.
    assert.deepEqual(searchSheets(index.db, "elevenlabs").candidates, []);
    assert.deepEqual(searchSheets(index.db, "v_8Kq2").candidates, []);
    index.close();
  });

  it("leaves retired sheets out of the searchable set", async () => {
    const dir = await makeTempWorld();
    const bundle = await fixtureBundle();
    const index = WorldIndex.open(dir, {
      ...bundle,
      sheets: bundle.sheets.map((s) => (s.id === "the-chorister" ? { ...s, retired: true } : s)),
    });

    const ids = searchSheets(index.db, "chorister").candidates.map((c) => c.sheetId);
    assert.ok(!ids.includes("the-chorister"), "a retired sheet must not answer a new question");
    assert.equal(
      searchSheets(index.db, "chorister", { kind: "character" }).searched,
      2,
      "and the searched count says so honestly",
    );
    index.close();
  });

  it("reports an empty result rather than guessing when the query has no usable terms", async () => {
    const { index } = await openFixtureIndex();
    const result = searchSheets(index.db, "?! -");
    assert.equal(result.floorCleared, false);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.searched, 6, "and still says how many sheets it would have searched");
    index.close();
  });

  it("honours the result limit", async () => {
    const { index } = await openFixtureIndex();
    assert.ok(searchSheets(index.db, "the harbour water", { limit: 1 }).candidates.length <= 1);
    index.close();
  });
});
