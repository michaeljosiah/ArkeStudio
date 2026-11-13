import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptCharacterLook, attachCharacterLook, readKit, renameCharacterLook } from "../../src/references/kit.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { LOOK_NAMES_SCHEMA_VERSION } from "../../src/world/commit.js";
import { makeTempWorld } from "../world/helpers.js";

const input = { id: "coat", kind: "costume" as const, file: "takes/coat/full.png", prompt: "A charcoal coat. Keep the face unchanged.", takeId: "tk_01J8E0000000000000000000T3" as const, jobId: "jb_01J8E0000000000000000000J3" as const, artDirectionVersion: 3, framing: "full-body" as const, mainFile: "main-photo.png", close: { file: "takes/coat/close.png", takeId: "tk_01J8E0000000000000000000T4" as const } };
it("renames and clears one saved look across reopen, preserving every generation, identity and attachment field", async () => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  try {
    await acceptCharacterLook(store, "maren-kest", input);
    await attachCharacterLook(store, "maren-kest", input.id, { kind: "production", productionId: "saltlight" });
    const before = (await readKit(store, "maren-kest"))!.kit;
    await renameCharacterLook(store, "maren-kest", input.id, "  Charcoal coat  ", null);
    const named = (await readKit(store, "maren-kest"))!.kit;
    assert.deepEqual(named, { ...before, looks: before.looks!.map(look => look.id === input.id ? { ...look, name: "Charcoal coat" } : look) });
    assert.equal((await readWorldMeta(dir)).schemaVersion, LOOK_NAMES_SCHEMA_VERSION);
    await assert.rejects(readWorldMeta(dir, { supports: LOOK_NAMES_SCHEMA_VERSION - 1 }), /newer|schema|version/i);
    await store.close();
    const reopened = await WorldStore.open(dir);
    try {
      assert.equal(reopened.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest")!.looks!.find(look => look.id === input.id)!.name, "Charcoal coat");
      await renameCharacterLook(reopened, "maren-kest", input.id, " ", "Charcoal coat");
      assert.deepEqual((await readKit(reopened, "maren-kest"))!.kit, before);
      assert.equal((await readWorldMeta(dir)).schemaVersion, LOOK_NAMES_SCHEMA_VERSION, "clearing never lowers the write fence");
    } finally { await reopened.close(); }
  } finally { await store.close(); }
});
it("refuses stale, missing and invalid renames without altering the kit, and no-ops an unchanged name", async () => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  try {
    await acceptCharacterLook(store, "maren-kest", { ...input, name: "Charcoal coat" });
    const file = join(dir, "references", "maren-kest", "kit.json");
    const before = await readFile(file, "utf8");
    await assert.rejects(renameCharacterLook(store, "maren-kest", input.id, "My coat", null), /renamed elsewhere/);
    await assert.rejects(renameCharacterLook(store, "maren-kest", "missing", "My coat", null), /no longer available/);
    await assert.rejects(renameCharacterLook(store, "maren-kest", input.id, "x".repeat(61), "Charcoal coat"));
    await renameCharacterLook(store, "maren-kest", input.id, " Charcoal coat ", "Charcoal coat");
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal((await readWorldMeta(dir)).schemaVersion, LOOK_NAMES_SCHEMA_VERSION, "accepting a named look also fences older writers");
  } finally { await store.close(); }
});
