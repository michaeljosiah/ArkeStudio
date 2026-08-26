import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openThread } from "../../src/canon/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { appendChanges, changesForEntity, readChanges } from "../../src/world/change-writer.js";
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
    assert.equal(history.records.length, 1, "the entry's record is still on disk and still readable");
    assert.equal(history.records[0]?.entity, entity);
    assert.equal(history.truncated, false);
  });

  it("returns nothing for an entry that genuinely has no records", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    t.after(async () => {
      await store.close();
    });
    assert.deepEqual(await changesForEntity(dir, "canon/CANON-999"), { records: [], truncated: false });
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
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0]?.source, "form-0");
  });

  it("hands them back oldest first", async () => {
    const dir = await logOf([record(1, ENTITY), record(2, "canon/CANON-008"), record(3, ENTITY)]);
    assert.deepEqual(
      (await changesForEntity(dir, ENTITY)).records.map((c) => c.source),
      ["form-1", "form-3"],
    );
  });

  it("keeps the newest when there are more than the bound", async () => {
    const dir = await logOf(Array.from({ length: 260 }, (_, i) => record(i, ENTITY)));
    const history = await changesForEntity(dir, ENTITY);
    assert.equal(history.records.length, 200);
    assert.equal(history.records.at(-1)?.source, "form-259", "the newest is kept, and it is still last");
    assert.equal(history.truncated, true, "and the caller is told there are older ones");
  });

  it("tolerates a truncated final line and a malformed one mid-file (R-22)", async () => {
    const dir = await logOf(
      [record(1, ENTITY), "{not json at all", record(2, ENTITY), '{"ts":"2026-08-01T12:00'],
      { terminated: false },
    );
    assert.deepEqual(
      (await changesForEntity(dir, ENTITY)).records.map((c) => c.source),
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
      (await changesForEntity(dir, ENTITY)).records.map((c) => c.source),
      ["form-9"],
    );
  });

  it("reads every line for an entity JSON would spell differently on disk", async () => {
    // No shortcut is available here, and the answer must still be right rather than empty.
    const quoted = 'canon/say "when"';
    const dir = await logOf([record(1, quoted), record(2, "canon/CANON-008")]);
    assert.deepEqual(
      (await changesForEntity(dir, quoted)).records.map((c) => c.source),
      ["form-1"],
    );
  });

  it("is empty for a world with no log at all", async () => {
    assert.deepEqual(await changesForEntity(await tempDir("arke-history-"), ENTITY), {
      records: [],
      truncated: false,
    });
  });
});

/**
 * The read walks the file backwards a block at a time, so every line in a log worth chunking
 * meets a block boundary sooner or later, and a character can straddle one. These compare it
 * against the obvious implementation — read the file, parse every line, filter — over a log big
 * enough that the boundaries land in many different places.
 */
describe("the blockwise read agrees with reading the whole file", () => {
  const TARGET = "canon/CANON-042";

  /** Deterministic, so a failure is reproducible: line lengths and content vary by index alone. */
  function variedLog(count: number): string {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const wide = "—ᚦ✶".repeat(i % 7); // multibyte, so boundaries fall inside characters too
      lines.push(
        JSON.stringify({
          ts: "2026-08-01T12:00:00.000Z",
          entity: i % 23 === 0 ? TARGET : `artifacts/legacy-${i}`,
          source: `form-${i}`,
          note: `${wide}${"x".repeat(i % 97)}`,
        }),
      );
    }
    return lines.join("\n") + "\n";
  }

  async function reference(dir: string, entity: string): Promise<string[]> {
    const lines = await readChanges(join(dir, "changes.jsonl"));
    return lines
      .filter((l) => l.entity === entity)
      .map((l) => String(l["source"]))
      .slice(-200);
  }

  it("finds the same records, in the same order, across many block boundaries", async () => {
    const dir = await tempDir("arke-history-");
    await writeFile(join(dir, "changes.jsonl"), variedLog(4000));
    const expected = await reference(dir, TARGET);
    assert.ok(expected.length > 100, "the fixture has to be big enough to be worth comparing");
    assert.deepEqual(
      (await changesForEntity(dir, TARGET)).records.map((c) => c.source),
      expected,
    );
  });

  it("finds a record however the boundary falls across it", async () => {
    // The last block ends at the file's end, so padding the tail to a chosen length puts the
    // boundary at a chosen byte of the record before it — including inside a multibyte character.
    const record = JSON.stringify({
      ts: "2026-08-01T12:00:00.000Z",
      entity: TARGET,
      source: "on-the-boundary",
      note: "ᚦ".repeat(40),
    });
    const width = Buffer.byteLength(record);
    for (const offset of [1, 2, 3, 17, Math.floor(width / 2), width - 1, width, width + 1]) {
      const dir = await tempDir("arke-history-");
      const padLength = 64 * 1024 - offset;
      const pad = JSON.stringify({
        ts: "2026-08-01T12:00:00.000Z",
        entity: "artifacts/pad",
        source: "x",
        note: "",
      });
      const filler = pad.slice(0, -1) + `,"pad":"${"y".repeat(padLength - pad.length - 8)}"}`;
      await writeFile(join(dir, "changes.jsonl"), `${record}\n${filler}\n`);
      assert.deepEqual(
        (await changesForEntity(dir, TARGET)).records.map((c) => c.source),
        ["on-the-boundary"],
        `boundary ${offset} bytes into the record`,
      );
    }
  });
});
