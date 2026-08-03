import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import { WorldLockedError } from "../../src/world/lock.js";
import { WorldOpenError, readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { FIXTURE_WORLD, makeTempWorld } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

describe("WorldStore (R-3, R-20, R-23, R-26, R-28)", () => {
  it("resolves a missing art-direction file as a visible, non-blank derived v1", async () => {
    const dir = await makeTempWorld();
    await rm(join(dir, "art-direction"), { recursive: true, force: true });
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const direction = store.getBundle().artDirection;
    assert.equal(direction.version, 1);
    assert.equal(direction.derived, true);
    assert.match(direction.description, /quiet dread/);
    assert.equal(direction.masterLook, undefined);
    await store.close();
  });

  it("enforces single-process ownership and reclaims stale locks (R-3)", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await assert.rejects(() => WorldStore.open(dir, { clock: CLOCK }), WorldLockedError);
    await first.close();

    // A lock naming a dead pid is stale and reclaimed.
    await writeFile(join(dir, "world.lock"), JSON.stringify({ pid: 999999901, startedAt: CLOCK() }), "utf8");
    const second = await WorldStore.open(dir, { clock: CLOCK });
    assert.equal(second.worldId, "01J8F3K2QW9VZX4N7M0RTYB6HC");
    await second.close();
  });

  it("opens a world with one malformed sheet, listing the failure (R-2)", async () => {
    const dir = await makeTempWorld();
    await writeFile(join(dir, "characters", "broken.md"), "no frontmatter at all", "utf8");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const bundle = store.getBundle();
    assert.equal(bundle.problems.length, 1);
    assert.equal(bundle.problems[0]!.path, "characters/broken.md");
    assert.equal(bundle.sheets.length, 6, "the valid entities are usable");
    await store.close();
  });

  it("retires an entity in place — still on disk, still resolvable (R-26)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.retire("characters/the-chorister.md", "test");
    const bundle = store.getBundle();
    const sheet = bundle.sheets.find((s) => s.id === "the-chorister");
    assert.ok(sheet, "retired entity still resolves");
    assert.equal(sheet.retired, true);
    assert.equal(sheet.version, 2, "retirement is a versioned change");
    await store.close();
  });

  it("restores a historical version as a new version (R-20)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const path = "characters/maren-kest.md";

    // Make v5 so v4 is historical.
    const live = await readFile(join(dir, path), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body.replace("Salt-crusted braids", "Iron-grey braids"));
    await store.commit({
      kind: "sheet-edit",
      source: "test",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });

    await store.restoreVersion(path, 4, "test");
    const after = MarkdownFile.parse(await readFile(join(dir, path), "utf8"));
    assert.equal(after.data["version"], 6, "restore produced v6, not a rewrite of v4");
    assert.ok(after.body.includes("Salt-crusted braids"), "content is v4's");
    const v5 = await readFile(join(dir, ".history/characters/maren-kest/v5.md"), "utf8");
    assert.ok(v5.includes("Iron-grey braids"), "v5 remains in history (R-20)");
    await store.close();
  });

  it("reports closed-world edits and adopts them explicitly (R-28, D16)", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();

    // Hand-edit while closed.
    const path = join(dir, "characters", "bray-half-hitch.md");
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("three belts", "four belts"), "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    const edits = second.getBundle().externalEdits;
    assert.deepEqual(
      edits.map((e) => e.path),
      ["characters/bray-half-hitch.md"],
    );

    await second.reconcileExternalEdit("characters/bray-half-hitch.md");
    const bundle = second.getBundle();
    assert.equal(bundle.externalEdits.length, 0);
    const sheet = bundle.sheets.find((s) => s.id === "bray-half-hitch");
    assert.equal(sheet?.version, 3, "adoption bumped the version");
    const changeLine = bundle.changes.findLast((c) => c.entity === "characters/bray-half-hitch");
    assert.equal(changeLine?.source, "external-edit");
    await second.close();
  });

  it("adopts a world with no history or scan-state as-is (R-28)", async () => {
    const dir = await makeTempWorld();
    const { rm } = await import("node:fs/promises");
    await rm(join(dir, ".index"), { recursive: true, force: true });
    const store = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(store.getBundle().externalEdits, [], "no scan-state → adopted, not reported");
    await store.close();
  });

  it("survives being moved to a different path (R-24 portability)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.close();

    const newParent = await tempDir("arke-moved-");
    const newDir = join(newParent, "the-undersong-moved");
    await rename(dir, newDir);
    const reopened = await WorldStore.open(newDir, { clock: CLOCK });
    const bundle = reopened.getBundle();
    assert.equal(bundle.sheets.length, 6);
    assert.deepEqual(bundle.problems, []);
    await reopened.close();
  });

  it("refuses a newer schema version without modifying the world (R-25)", async () => {
    const dir = await tempDir("arke-newer-");
    const worldDir = join(dir, "future-world");
    await cp(FIXTURE_WORLD, worldDir, { recursive: true });
    const metaPath = join(worldDir, "world.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    meta["schemaVersion"] = 99;
    const raw = JSON.stringify(meta, null, 2);
    await writeFile(metaPath, raw, "utf8");

    await assert.rejects(() => readWorldMeta(worldDir), WorldOpenError);
    await assert.rejects(() => WorldStore.open(worldDir, { clock: CLOCK }), WorldOpenError);
    assert.equal(await readFile(metaPath, "utf8"), raw, "the world was not modified");
  });

  it("contains no absolute path in any world file (R-24)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.retire("characters/the-chorister.md", "test");
    await store.close();
    const { readdir } = await import("node:fs/promises");
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(p)));
        else if (/\.(md|json|jsonl)$/.test(entry.name)) out.push(p);
      }
      return out;
    };
    for (const file of await walk(dir)) {
      const text = await readFile(file, "utf8");
      assert.ok(!/[A-Za-z]:\\/.test(text), `${file} must not contain a Windows absolute path`);
      assert.ok(!text.includes(tmpdir().replaceAll("\\", "/")), `${file} must not contain the temp root`);
    }
  });
});
