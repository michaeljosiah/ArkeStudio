import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BIBLE_PATH, BibleEditRecordSchema, ClientMessageSchema } from "@arke-studio/contracts";
import { applyTurnBibleEdits, readBible, restoreBible, saveBible } from "../../src/world/bible.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "./helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Starting a bible is an edit like any other (2026-08-22).
 *
 * Every version-shaped thing here counts from a document that already exists: an edit moves it
 * from vN to vN+1, and the record the turn stores says so. A bible that did not exist has no vN,
 * so the first write landed at v1 and reported "1 → 1" — which the stored-event schema refuses,
 * because a record that does not move is not an edit. The turn then failed AFTER writing the
 * file: the bible was on disk, the reply that described it was thrown away, and there was no
 * undo card for work that had already happened.
 *
 * Nothing surfaced it while only authors who already knew about the bible ever started one from
 * inside a conversation. Telling the Studio it may offer made this the common first edit.
 */

const CLOCK = () => "2026-08-22T10:00:00.000Z";

async function worldWithNoBible() {
  const dir = await makeTempWorld();
  await rm(join(dir, BIBLE_PATH), { force: true });
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  assert.equal((await readBible(dir)).present, false, "the world starts without one");
  return { dir, store };
}

describe("the first bible a world ever has", () => {
  it("gives a turn a record the stored event accepts", async () => {
    const { dir, store } = await worldWithNoBible();
    const record = await applyTurnBibleEdits(
      store,
      [{ op: "set-section", heading: "What this is", text: "A Cinderella told in Lagos." }],
      { source: "world-chat:c1", baseVersion: 1 },
    );
    assert.ok(record, "an edit happened, so there is a record of it");

    const parsed = BibleEditRecordSchema.safeParse(record);
    assert.ok(
      parsed.success,
      `the turn can be stored: ${JSON.stringify(parsed.error?.issues ?? [])}`,
    );
    assert.deepEqual(record.headings, ["What this is"]);
    assert.match((await readBible(dir)).text, /Cinderella told in Lagos/);
  });

  it("can be undone, back to the world having none", async () => {
    const { dir, store } = await worldWithNoBible();
    const record = await applyTurnBibleEdits(
      store,
      [{ op: "replace-document", text: "## What this is\n\nA Cinderella told in Lagos." }],
      { source: "world-chat:c1", baseVersion: 1 },
    );
    assert.ok(record);
    // The undo card names fromVersion. Whatever that number is, restoring it has to be a thing
    // the store can actually do — an undo offered over a version that never existed is a lie.
    await restoreBible(store, record.fromVersion, "undo");
    assert.equal(
      (await readBible(dir)).text.trim(),
      "",
      "undoing the first bible leaves an empty one, not the text it just wrote",
    );
  });

  it("is the same story from the editor as from a turn", async () => {
    const { dir, store } = await worldWithNoBible();
    // The author opening the Bible screen on a world that has none and typing into it.
    const record = await saveBible(store, "Typed by hand, before any conversation.", {
      source: "editor",
      baseVersion: 1,
    });
    const parsed = BibleEditRecordSchema.safeParse(record);
    assert.ok(parsed.success, `${JSON.stringify(parsed.error?.issues ?? [])}`);
    assert.match((await readBible(dir)).text, /Typed by hand/);
  });

  it("survives the wire, so the undo card's button is not dropped in transit", async () => {
    // The card sends back the fromVersion it was shown. A bound that refuses 0 makes the button
    // on the first bible edit a no-op with nothing on screen to say why.
    const parsed = ClientMessageSchema.safeParse({
      kind: "restore-bible",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      version: 0,
    });
    assert.ok(parsed.success, `${JSON.stringify(parsed.error?.issues ?? [])}`);
  });

  it("reports the day it was written, not the epoch", async () => {
    const { dir, store } = await worldWithNoBible();
    await applyTurnBibleEdits(store, [{ op: "replace-document", text: "First." }], {
      source: "world-chat:c1",
      baseVersion: 1,
    });
    assert.equal(
      (await readBible(dir)).updated,
      "2026-08-22",
      "a bible written today does not claim to be from 1970",
    );
  });
});
