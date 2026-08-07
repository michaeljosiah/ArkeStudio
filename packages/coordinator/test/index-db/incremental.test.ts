import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import { WorldIndex } from "../../src/index-db/world-index.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile, JsonFile, sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";
import { dumpIndex } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

/**
 * The incremental-equals-cold suite (SPEC-003 §3.2, DoD): after every commit in a sequence,
 * the incrementally-updated index must match a cold rebuild exactly. This is the test that
 * catches an update path forgetting a relation.
 */

async function assertMatchesColdRebuild(store: WorldStore, label: string): Promise<void> {
  const live = store.getIndex();
  assert.ok(live, "index available");
  const liveDump = dumpIndex(live.db);

  const coldDir = await tempDir("arke-cold-");
  const cold = WorldIndex.open(coldDir, store.getBundle());
  const coldDump = dumpIndex(cold.db);
  cold.close();

  assert.deepEqual(liveDump, coldDump, `incremental index diverged from cold rebuild after: ${label}`);
}

describe("incremental update equals cold rebuild (R-20, D6)", () => {
  it("holds through a sequence of sheet, canon, mixed, retire and scene commits", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });

    // 1 — sheet edit (the accept-gate hot path).
    {
      const path = "characters/maren-kest.md";
      const live = await readFile(join(dir, path), "utf8");
      const doc = MarkdownFile.parse(live);
      doc.setBody(doc.body.replace("Salt-crusted", "Salt-white"));
      await store.commit({
        kind: "sheet-edit",
        source: "test",
        files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
      });
      await assertMatchesColdRebuild(store, "sheet edit");
    }

    // 2 — canon amend.
    {
      const path = "canon/CANON-002.md";
      const live = await readFile(join(dir, path), "utf8");
      const doc = MarkdownFile.parse(live);
      doc.setBody(doc.body + "\nAmended in test.");
      await store.commit({
        kind: "canon-edit",
        source: "test",
        files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
      });
      await assertMatchesColdRebuild(store, "canon amend");
    }

    // 3 — mixed commit: new canon entry + the sheet citing it.
    {
      const sheetPath = "characters/bray-half-hitch.md";
      const sheetLive = await readFile(join(dir, sheetPath), "utf8");
      const sheetDoc = MarkdownFile.parse(sheetLive);
      sheetDoc.setData({ canonRules: ["CANON-072"] });
      const canonNew =
        "---\nid: CANON-072\ntype: rule\ntitle: Debts are knots\nstatus: settled\nintroducedAt: 0\nlinks: [bray-half-hitch]\n---\n\nA debt to the Council is tied, not counted.\n";
      await store.commit({
        kind: "canon-and-sheet",
        source: "test",
        files: [
          { path: "canon/CANON-072.md", action: "create", content: canonNew, baseHash: null },
          { path: sheetPath, action: "replace", content: sheetDoc.serialize(), baseHash: sha256(sheetLive) },
        ],
      });
      await assertMatchesColdRebuild(store, "mixed canon+sheet");
    }

    // 4 — retire.
    {
      await store.retire("characters/the-chorister.md", "test");
      await assertMatchesColdRebuild(store, "retire");
    }

    // 5 — scene edit (production slice).
    {
      const path = "productions/saltlight/scenes/04-the-verse-rises.json";
      const live = await readFile(join(dir, path), "utf8");
      const doc = JsonFile.parse(live);
      const shots = doc.value["shots"] as Array<Record<string, unknown>>;
      shots[0]!["description"] = "@maren-kest and @bray-half-hitch at the rail of @the-vigil.";
      doc.set({ shots });
      await store.commit({
        kind: "scene-edit",
        source: "test",
        files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
      });
      await assertMatchesColdRebuild(store, "scene edit");
    }

    await store.close();
  });
});
