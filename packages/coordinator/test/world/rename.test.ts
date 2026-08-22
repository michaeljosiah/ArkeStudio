import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "./helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A world's name is a label, and labels change (2026-08-22).
 *
 * It was written once at the door — in the first thirty seconds of an idea, before the story
 * existed — and read everywhere after, so a world could be named for good by a sentence somebody
 * typed to get started. What must not change is the folder: it is this world's address, and
 * media URLs, artifact paths, the lock and every stored reference resolve through it.
 */

const CLOCK = () => "2026-08-22T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

describe("renaming a world", () => {
  it("changes the name and leaves the folder exactly where it was", async () => {
    const { dir, store } = await open();
    const before = store.getBundle().meta;
    const folder = basename(dir);

    await store.renameWorld("The Unasked Question");

    const meta = store.getBundle().meta;
    assert.equal(meta.name, "The Unasked Question");
    assert.equal(meta.slug, before.slug, "the address is not the label");
    assert.equal(basename(dir), folder, "and the directory never moved");
    await stat(join(dir, "world.json"));
    const raw = JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as { name: string; slug?: string };
    assert.equal(raw.name, "The Unasked Question", "it is on disk, not only in the bundle");
  });

  it("trims what it is given, and refuses a name that is only space", async () => {
    const { store } = await open();
    await store.renameWorld("   Third Mainland   ");
    assert.equal(store.getBundle().meta.name, "Third Mainland");
    await assert.rejects(store.renameWorld("   "), /needs a name/);
  });

  it("nothing else about the world moves with it", async () => {
    const { store } = await open();
    const before = store.getBundle();
    const canonBefore = before.meta.canonRevision;
    const sheets = before.sheets.map((s) => s.id).sort();

    await store.renameWorld("A Different Name");

    const after = store.getBundle();
    assert.equal(after.meta.canonRevision, canonBefore, "a rename is not a canon change");
    assert.deepEqual(after.sheets.map((s) => s.id).sort(), sheets, "and the cast is untouched");
  });

  it("identity fields cannot be set through the same door", async () => {
    // The commit primitive takes world fields now; it must refuse the ones that are identity.
    const { store } = await open();
    for (const key of ["id", "slug", "schemaVersion", "canonRevision"]) {
      await assert.rejects(
        store.commit({ kind: "world-rename", source: "form", files: [], worldFields: { [key]: "x" } }),
        /is not a label/,
        `${key} must be refused by name`,
      );
    }
  });
});
