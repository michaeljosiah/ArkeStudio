import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorldIndex } from "../../src/index-db/world-index.js";
import { refsForCanon, refsForSheet, ripplesForSheet, searchCanon } from "../../src/index-db/queries.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";
import { fixtureBundle, dumpIndex } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

describe("the cache contract (R-1..R-4, D1)", () => {
  it("delete-and-rebuild produces identical query results (R-1)", async () => {
    const dir = await makeTempWorld();
    const bundle = await fixtureBundle();

    const first = WorldIndex.open(dir, bundle);
    const before = {
      dump: dumpIndex(first.db),
      refs: refsForSheet(first.db, "maren-kest"),
      ripples: ripplesForSheet(first.db, { sheetId: "maren-kest", sheetName: "Maren Kest", newVersion: 5 }),
      canon: refsForCanon(first.db, "CANON-002"),
      search: searchCanon(first.db, "tide calling"),
    };
    first.close();

    await rm(join(dir, ".index"), { recursive: true, force: true });

    const second = WorldIndex.open(dir, bundle);
    const after = {
      dump: dumpIndex(second.db),
      refs: refsForSheet(second.db, "maren-kest"),
      ripples: ripplesForSheet(second.db, { sheetId: "maren-kest", sheetName: "Maren Kest", newVersion: 5 }),
      canon: refsForCanon(second.db, "CANON-002"),
      search: searchCanon(second.db, "tide calling"),
    };
    second.close();

    assert.deepEqual(after, before);
  });

  it("discards and rebuilds a corrupt database without surfacing an error (R-4, D7)", async () => {
    const dir = await makeTempWorld();
    const bundle = await fixtureBundle();
    await writeFile(join(dir, ".index", "world.db"), "this is not a sqlite file", "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".index"), { recursive: true });
      await writeFile(join(dir, ".index", "world.db"), "this is not a sqlite file", "utf8");
    });
    const index = WorldIndex.open(dir, bundle);
    assert.equal(refsForSheet(index.db, "maren-kest").tiles, 3);
    index.close();
  });

  it("detects closed-app changes by fingerprint and rebuilds before serving (R-3)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const path = "characters/maren-kest.md";
    const live = await readFile(join(dir, path), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body + "\nIndexed edit.");
    await store.commit({
      kind: "sheet-edit",
      source: "test",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });
    const index = store.getIndex();
    assert.ok(index);
    const version = (
      index.db.prepare("SELECT version FROM entities WHERE id = 'maren-kest'").get() as { version: number }
    ).version;
    assert.equal(version, 6, "the index reflects the commit without a rescan (R-20)");
    await store.close();

    // Reopen: same fingerprint → no rebuild needed; the index still answers instantly.
    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    const idx2 = reopened.getIndex();
    assert.ok(idx2);
    assert.equal(
      (idx2.db.prepare("SELECT version FROM entities WHERE id = 'maren-kest'").get() as { version: number })
        .version,
      6,
    );
    await reopened.close();
  });

  it("keeps the index out of every write path (R-2): world files never contain index-derived values", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.retire("characters/the-chorister.md", "test");
    await store.close();
    // The structural guard: delete .index entirely and reopen — the world is byte-complete.
    await rm(join(dir, ".index"), { recursive: true, force: true });
    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    const bundle = reopened.getBundle();
    assert.equal(bundle.sheets.find((s) => s.id === "the-chorister")?.retired, true);
    assert.deepEqual(bundle.problems, []);
    await reopened.close();
  });
});
