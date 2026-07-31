import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeLog } from "../src/change-log.js";

describe("ChangeLog", () => {
  it("appends NDJSON lines with a file-level monotonic seq and reads them back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-log-"));
    const path = join(dir, "changes.jsonl");
    const log = new ChangeLog(path);

    await Promise.all([
      log.append({ kind: "event", n: 1 }),
      log.append({ kind: "event", n: 2 }),
      log.append({ kind: "event", n: 3 }),
    ]);
    await log.drain();

    const records = await log.readAll();
    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((r) => r.seq),
      [1, 2, 3],
    );

    const raw = await readFile(path, "utf8");
    assert.equal(raw.trim().split("\n").length, 3, "one line per record, never interleaved");
  });

  it("resumes the seq from the tail of an existing file on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-log-"));
    const path = join(dir, "changes.jsonl");

    const first = new ChangeLog(path);
    await first.append({ kind: "event", n: 1 });
    await first.append({ kind: "event", n: 2 });
    await first.drain();

    const second = new ChangeLog(path);
    await second.append({ kind: "event", n: 3 });
    await second.drain();

    const records = await second.readAll();
    assert.deepEqual(
      records.map((r) => r.seq),
      [1, 2, 3],
      "a restart continues the sequence, never reuses it",
    );
  });
});
