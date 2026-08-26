import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { openThread } from "../../src/canon/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { appendChanges, changesForEntity } from "../../src/world/change-writer.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

/**
 * A bulk write's change lines — a migration measuring legacy media, an import filing a folder.
 * No `path`, so replaying them cannot disturb the derived scan state; the point here is only
 * that there are more of them than the snapshot's window holds.
 */
function bulkLines(count: number): object[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: "2026-08-01T12:30:00.000Z",
    entity: `artifacts/legacy-${String(i).padStart(3, "0")}`,
    source: "system:migration",
  }));
}

describe("an entry's history survives a bulk write (issue 289)", () => {
  it("reads the entry's own change lines, not a filtered tail of the whole log", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const { entryId } = await openThread(store, new ProposalManager(store), {
      title: "Who pays the Vigil watch?",
      question: "The watch is a civic office — but who actually pays the wages?",
      candidates: [],
    });
    const entity = `canon/${entryId}`;
    assert.ok(
      store.getBundle().changes.some((c) => c.entity === entity),
      "the snapshot carries it while nothing else has happened",
    );
    await store.close();

    // Sixty records for files nobody edited — more than the snapshot's window holds.
    await appendChanges(join(dir, "changes.jsonl"), bulkLines(60));

    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    t.after(async () => {
      await reopened.close();
    });
    assert.ok(
      !reopened.getBundle().changes.some((c) => c.entity === entity),
      "the window is a recent-activity tail and the bulk write has filled it",
    );
    const history = await changesForEntity(dir, entity);
    assert.equal(history.length, 1, "the entry's record is still on disk and still readable");
    assert.equal(history[0]?.entity, entity);
  });

  it("returns nothing for an entry that genuinely has no records", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    t.after(async () => {
      await store.close();
    });
    assert.deepEqual(await changesForEntity(dir, "canon/CANON-999"), []);
  });
});
