import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { castRefs, extract } from "../../src/index-db/citations.js";
import { WorldIndex } from "../../src/index-db/world-index.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";
import { fixtureBundle } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

describe("citation extraction (§2.4, R-8..R-10)", () => {
  it("parses @tokens as live cast references", () => {
    assert.deepEqual(castRefs("@maren-kest grips the rail of @the-vigil, twice @maren-kest"), [
      "maren-kest",
      "the-vigil",
    ]);
    assert.deepEqual(castRefs("no refs here"), []);
  });

  it("covers every relation in the model over the fixture (R-9)", async () => {
    const { citations } = extract(await fixtureBundle());
    const byRelation = new Map<string, number>();
    for (const c of citations) byRelation.set(c.relation, (byRelation.get(c.relation) ?? 0) + 1);
    for (const relation of [
      "shot-cast",
      "dispatch",
      "canon-rule",
      "entry-link",
      "artifact-link",
      "tile-source",
      "scene-location",
      "voice-assignment",
    ]) {
      assert.ok((byRelation.get(relation) ?? 0) > 0, `expected at least one ${relation} citation`);
    }
  });

  it("records dispatch provenance at the cited version, and it never moves (R-8)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });

    const before = store.getIndex()!;
    const cited = before.db
      .prepare("SELECT sheet_version AS v FROM take_sheets WHERE take_id = ? AND sheet_id = 'maren-kest'")
      .get("tk_01J8F0000000000000000000B2") as { v: number };
    assert.equal(cited.v, 4);

    // Maren advances to v5; the dispatch citation must still say v4.
    const path = "characters/maren-kest.md";
    const live = await readFile(join(dir, path), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body + "\nAdvanced.");
    await store.commit({
      kind: "sheet-edit",
      source: "test",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });

    const after = store.getIndex()!;
    const still = after.db
      .prepare("SELECT sheet_version AS v FROM take_sheets WHERE take_id = ? AND sheet_id = 'maren-kest'")
      .get("tk_01J8F0000000000000000000B2") as { v: number };
    assert.equal(still.v, 4, "recorded truth does not follow the sheet");
    const dispatchRow = after.db
      .prepare(
        "SELECT target_version AS v FROM citations WHERE source_id = ? AND target_id = 'maren-kest' AND relation = 'dispatch'",
      )
      .get("tk_01J8F0000000000000000000B2") as { v: number };
    assert.equal(dispatchRow.v, 4);

    // Live references, by contrast, follow: the sheet's canon-rule citation now carries v5.
    const rule = after.db
      .prepare("SELECT source_version AS v FROM citations WHERE source_id = 'maren-kest' AND relation = 'canon-rule'")
      .get() as { v: number };
    assert.equal(rule.v, 5);
    await store.close();
  });

  it("keeps citations to retired entities resolving (R-10)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    // the-chorister is linked from maren-kest and cited by CANON-044.
    await store.retire("characters/the-chorister.md", "test");
    const index = store.getIndex()!;
    const entity = index.db.prepare("SELECT retired FROM entities WHERE id = 'the-chorister'").get() as {
      retired: number;
    };
    assert.equal(entity.retired, 1, "the retired entity is still in the index");
    const citing = index.db
      .prepare("SELECT COUNT(*) AS n FROM citations WHERE target_id = 'the-chorister'")
      .get() as { n: number };
    assert.ok(citing.n > 0, "citations to the retired entity still resolve");
    await store.close();
  });

  it("captures tile-source versions per tile — what 'predates v5' is computed from", async () => {
    const bundle = await fixtureBundle();
    const { citations } = extract(bundle);
    const tiles = citations.filter((c) => c.relation === "tile-source");
    assert.equal(tiles.length, 3, "empty slots produce no citation");
    const versions = tiles.map((t) => t.targetVersion).sort();
    assert.deepEqual(versions, [3, 4, 4]);
  });

  it("indexes a sheet referenced only through a shot description (§3.2 awkward case)", async () => {
    const dir = await makeTempWorld();
    const bundle = await fixtureBundle();
    const index = WorldIndex.open(dir, bundle);
    // bray-half-hitch appears in sh_14's description and nowhere else structural.
    const rows = index.db
      .prepare("SELECT source_id AS id FROM citations WHERE target_id = 'bray-half-hitch' AND relation = 'shot-cast'")
      .all() as Array<{ id: string }>;
    assert.ok(rows.some((r) => r.id === "sh_14"));
    index.close();
  });
});
