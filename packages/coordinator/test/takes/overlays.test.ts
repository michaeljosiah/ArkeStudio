import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CutFileSchema } from "@arke-studio/contracts";
import { moveOverlay, placeOverlay, removeOverlay } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Overlays (82a): the one stored position on the cut. Everything else about the picture is
 * derived, so these tests are as much about what an overlay is *not* — not a take, not coverage,
 * and not a reason for cut.json to stop holding audio.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  const artifactId = store.getBundle().artifacts[0]?.id;
  assert.ok(artifactId, "the fixture world files at least one artifact");
  return { dir, store, artifactId };
}

const cutOf = async (dir: string) =>
  CutFileSchema.parse(JSON.parse(await readFile(join(dir, "productions/saltlight/cut.json"), "utf8")));

describe("overlays on the cut (82a)", () => {
  it("places an artifact over a window and files it in cut.json", async () => {
    const { dir, store, artifactId } = await open();
    const overlay = await placeOverlay(store, "saltlight", { artifactId, startSec: 48, endSec: 62 });
    assert.match(overlay.id, /^ov_[0-9A-HJKMNP-TV-Z]{26}$/);
    const cut = await cutOf(dir);
    assert.deepEqual(cut.overlays, [{ id: overlay.id, artifactId, startSec: 48, endSec: 62 }]);
    await store.close();
  });

  it("keeps the audio cut.json already held", async () => {
    // The file is read through its schema and written whole; a placement that dropped the audio
    // would take a production's dialogue and score with it.
    const { dir, store, artifactId } = await open();
    const path = join(dir, "productions/saltlight/cut.json");
    await writeFile(
      path,
      JSON.stringify({ audio: [{ kind: "score", label: "the verse, low", entries: [{ offsetSec: 0 }] }] }, null, 2),
      "utf8",
    );
    await store.reload();
    await placeOverlay(store, "saltlight", { artifactId, startSec: 1, endSec: 2 });
    const cut = await cutOf(dir);
    assert.equal(cut.audio.length, 1, "the score is still there");
    assert.equal(cut.audio[0]?.label, "the verse, low");
    assert.equal(cut.overlays.length, 1);
    await store.close();
  });

  it("refuses an artifact this world does not have", async () => {
    // A placement citing nothing is one the cut would have to render as an absence it cannot name.
    const { store } = await open();
    await assert.rejects(
      () => placeOverlay(store, "saltlight", { artifactId: "ar_01J8G0000000000000000000ZZ", startSec: 0, endSec: 5 }),
      /is not in this world/,
    );
    await store.close();
  });

  it("refuses a window that ends before it starts, or does not last", async () => {
    const { store, artifactId } = await open();
    await assert.rejects(() => placeOverlay(store, "saltlight", { artifactId, startSec: 10, endSec: 4 }), /cannot start/);
    await assert.rejects(() => placeOverlay(store, "saltlight", { artifactId, startSec: 10, endSec: 10 }), /cannot start/);
    await store.close();
  });

  it("moves one that is already placed, and refuses one that is not", async () => {
    const { dir, store, artifactId } = await open();
    const overlay = await placeOverlay(store, "saltlight", { artifactId, startSec: 48, endSec: 62 });
    const moved = await moveOverlay(store, "saltlight", { overlayId: overlay.id, startSec: 90, endSec: 104 });
    assert.deepEqual([moved.startSec, moved.endSec], [90, 104]);
    assert.equal(moved.artifactId, artifactId, "moving changes when, never what");
    assert.deepEqual((await cutOf(dir)).overlays, [{ id: overlay.id, artifactId, startSec: 90, endSec: 104 }]);
    await assert.rejects(
      () => moveOverlay(store, "saltlight", { overlayId: "ov_01J8G0000000000000000000ZZ", startSec: 0, endSec: 1 }),
      /is not on this cut/,
    );
    await store.close();
  });

  it("removes the placement and leaves the artifact filed", async () => {
    const { dir, store, artifactId } = await open();
    const overlay = await placeOverlay(store, "saltlight", { artifactId, startSec: 3, endSec: 9 });
    await removeOverlay(store, "saltlight", overlay.id);
    assert.deepEqual((await cutOf(dir)).overlays, []);
    assert.ok(
      store.getBundle().artifacts.some((a) => a.id === artifactId),
      "an overlay only ever cited the artifact — deleting it deletes a placement",
    );
    await store.close();
  });

  it("writes nothing when a placement is refused", async () => {
    const { dir, store, artifactId } = await open();
    await placeOverlay(store, "saltlight", { artifactId, startSec: 1, endSec: 2 });
    const before = await readFile(join(dir, "productions/saltlight/cut.json"), "utf8");
    await assert.rejects(() => placeOverlay(store, "saltlight", { artifactId, startSec: 5, endSec: 5 }), /cannot start/);
    assert.equal(await readFile(join(dir, "productions/saltlight/cut.json"), "utf8"), before);
    await store.close();
  });

  it("creates no take, no review and no selection — an overlay is none of those", async () => {
    const { dir, store, artifactId } = await open();
    const selectionsBefore = await readFile(join(dir, "productions/saltlight/selections.json"), "utf8").catch(() => "");
    await placeOverlay(store, "saltlight", { artifactId, startSec: 20, endSec: 30 });
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    assert.equal(
      production.takes.filter((t) => t.provider === "user").length,
      0,
      "nothing was dispatched, so nothing is a take",
    );
    assert.equal(
      await readFile(join(dir, "productions/saltlight/selections.json"), "utf8").catch(() => ""),
      selectionsBefore,
      "and no shot's selection changed: an overlay is never coverage",
    );
    await store.close();
  });
});
