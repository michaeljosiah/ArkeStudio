import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, closeOnCleanup } from "../tmp.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta, scanWorld, SUPPORTED_SCHEMA_VERSION, WorldOpenError } from "../../src/world/scan.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { exportWorld } from "../../src/takes/export.js";
import { makeTempWorld } from "./helpers.js";

/**
 * The world schema-version boundary (SPEC-023 R-23, issue #403): worlds are born at 1, the
 * first write that needs the newer boundary raises it durably, and a build older than the
 * boundary refuses by name instead of silently mis-reading.
 */

const CLOCK = () => "2026-08-19T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

describe("the world schema-version boundary (issue 403)", () => {
  it("a new world is born at schema 1, not at the newest this build knows", async () => {
    const root = await tempDir("arke-schema-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    await provider.ensureAppRoot();
    const { slug } = await provider.createWorld({ name: "Born Yesterday" });
    const meta = JSON.parse(await readFile(join(root, "worlds", slug, "world.json"), "utf8"));
    assert.equal(meta.schemaVersion, 1, "no conversations, no new-model entities — old builds may open it");
  });

  it("raising the version is durable, audited, and loses nothing", async () => {
    const { dir, store } = await open();
    const before = await scanWorld(dir);
    assert.equal(before.meta.schemaVersion, 1, "the fixture world ships at schema 1");

    await store.ensureSchemaVersion(2, "test");

    const after = await scanWorld(dir);
    assert.equal(after.meta.schemaVersion, 2);
    assert.deepEqual(after.problems, [], "the raise introduces no problems");
    assert.equal(after.bundle.sheets.length, before.bundle.sheets.length, "no sheet lost");
    assert.equal(after.bundle.canon.length, before.bundle.canon.length, "no canon lost");
    assert.equal(after.bundle.productions.length, before.bundle.productions.length, "no production lost");

    const changes = (await readFile(join(dir, "changes.jsonl"), "utf8")).trim().split("\n");
    const upgrade = changes.map((l) => JSON.parse(l)).find((c) => c.entity === "world");
    assert.ok(upgrade, "the boundary crossing is in the audit trail");
    assert.deepEqual(upgrade.fieldsChanged, ["schemaVersion"]);
    assert.equal(upgrade.toVersion, 2);
  });

  it("the raise is idempotent: a second ask changes nothing", async () => {
    const { dir, store } = await open();
    await store.ensureSchemaVersion(2, "test");
    const raw = await readFile(join(dir, "world.json"), "utf8");
    const lines = (await readFile(join(dir, "changes.jsonl"), "utf8")).trim().split("\n").length;

    await store.ensureSchemaVersion(2, "test");

    assert.equal(await readFile(join(dir, "world.json"), "utf8"), raw, "world.json is byte-identical");
    assert.equal(
      (await readFile(join(dir, "changes.jsonl"), "utf8")).trim().split("\n").length,
      lines,
      "no second audit line",
    );
  });

  it("a version-2 world opens; a newer world refuses by name and is not modified", async () => {
    const { dir, store } = await open();
    await store.ensureSchemaVersion(2, "test");
    assert.equal((await readWorldMeta(dir)).schemaVersion, 2, "this build understands 2");

    await store.close();
    const meta = JSON.parse(await readFile(join(dir, "world.json"), "utf8"));
    meta.schemaVersion = SUPPORTED_SCHEMA_VERSION + 1;
    await writeFile(join(dir, "world.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

    const raw = await readFile(join(dir, "world.json"), "utf8");
    await assert.rejects(
      () => readWorldMeta(dir),
      (err: unknown) => err instanceof WorldOpenError && err.reason === "schema-newer",
      "an older build refuses rather than treating private state as understood content",
    );
    assert.equal(await readFile(join(dir, "world.json"), "utf8"), raw, "refusal modifies nothing");
  });

  it("a conversation-bearing world exports at schema 2 with .conversations excluded", async () => {
    const { dir, store } = await open();
    // The handler's sequence: raise first, then create — the boundary is durable before the
    // conversation directory exists.
    await store.ensureSchemaVersion(2, "world-chat");
    await new WorldChatService(dir, CLOCK).create({ title: "First thread" });

    const target = join(await tempDir("arke-export-"), "copy");
    await exportWorld(dir, target);

    const exported = JSON.parse(await readFile(join(target, "world.json"), "utf8"));
    assert.equal(exported.schemaVersion, 2, "the export carries the boundary, so old builds refuse it too");
    await assert.rejects(
      () => readFile(join(target, ".conversations", "cv_x", "events.jsonl"), "utf8"),
      "no conversation state crosses into the export",
    );
    const { readdir } = await import("node:fs/promises");
    assert.ok(!(await readdir(target)).includes(".conversations"), "the directory itself is excluded");
  });
});
