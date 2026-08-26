import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openThread } from "../../src/canon/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { appendChanges, changesForEntity } from "../../src/world/change-writer.js";
import { WorldStore } from "../../src/world/store.js";
import { tempDir } from "../tmp.js";
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

/**
 * The read walks the log backwards and skips lines without the entity's characters rather than
 * parsing them (PR 540 review). These are the properties that shortcut must not cost.
 */
describe("reading one entity's history off the log", () => {
  const ENTITY = "canon/CANON-007";
  const record = (i: number, entity: string): string =>
    JSON.stringify({ ts: `2026-08-0${(i % 9) + 1}T12:00:00.000Z`, entity, source: `form-${i}` });

  async function logOf(lines: string[], { terminated = true } = {}): Promise<string> {
    const dir = await tempDir("arke-history-");
    await writeFile(join(dir, "changes.jsonl"), lines.join("\n") + (terminated ? "\n" : ""));
    return dir;
  }

  it("finds records at the front of a log whose end is all other entities", async () => {
    // The bug this issue is about, one level down: bounding the *read* to a tail of bytes would
    // lose an entry last touched long ago, which is exactly the entry most in need of history.
    const dir = await logOf([
      record(0, ENTITY),
      ...Array.from({ length: 5000 }, (_, i) => record(i, `artifacts/legacy-${i}`)),
    ]);
    const history = await changesForEntity(dir, ENTITY);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.source, "form-0");
  });

  it("hands them back oldest first", async () => {
    const dir = await logOf([record(1, ENTITY), record(2, "canon/CANON-008"), record(3, ENTITY)]);
    assert.deepEqual(
      (await changesForEntity(dir, ENTITY)).map((c) => c.source),
      ["form-1", "form-3"],
    );
  });

  it("keeps the newest when there are more than the bound", async () => {
    const dir = await logOf(Array.from({ length: 260 }, (_, i) => record(i, ENTITY)));
    const history = await changesForEntity(dir, ENTITY);
    assert.equal(history.length, 200);
    assert.equal(history.at(-1)?.source, "form-259", "the newest is kept, and it is still last");
  });

  it("tolerates a truncated final line and a malformed one mid-file (R-22)", async () => {
    const dir = await logOf(
      [record(1, ENTITY), "{not json at all", record(2, ENTITY), '{"ts":"2026-08-01T12:00'],
      { terminated: false },
    );
    assert.deepEqual(
      (await changesForEntity(dir, ENTITY)).map((c) => c.source),
      ["form-1", "form-2"],
    );
  });

  it("finds a record a person reformatted by hand", async () => {
    // The skip tests for the entity's characters, not for the exact bytes this app writes, so a
    // line edited in an editor is still that entity's history rather than silently not it.
    const dir = await logOf([
      `{ "ts": "2026-08-01T12:00:00.000Z", "source": "form-9", "entity": "${ENTITY}" }`,
    ]);
    assert.deepEqual(
      (await changesForEntity(dir, ENTITY)).map((c) => c.source),
      ["form-9"],
    );
  });

  it("reads every line for an entity JSON would spell differently on disk", async () => {
    // No shortcut is available here, and the answer must still be right rather than empty.
    const quoted = 'canon/say "when"';
    const dir = await logOf([record(1, quoted), record(2, "canon/CANON-008")]);
    assert.deepEqual(
      (await changesForEntity(dir, quoted)).map((c) => c.source),
      ["form-1"],
    );
  });

  it("is empty for a world with no log at all", async () => {
    assert.deepEqual(await changesForEntity(await tempDir("arke-history-"), ENTITY), []);
  });
});
