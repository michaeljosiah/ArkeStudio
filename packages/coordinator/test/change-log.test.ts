import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./tmp.js";
import { ChangeLog } from "../src/change-log.js";

describe("ChangeLog", () => {
  it("appends NDJSON lines with a file-level monotonic seq and reads them back", async () => {
    const dir = await tempDir("arke-log-");
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
    const dir = await tempDir("arke-log-");
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

  // Issue 1845: the log grew for the life of an install, to 2.6 GB on one machine.
  it("rolls to .old past its cap, keeps one generation and reads both in order", async () => {
    const dir = await tempDir("arke-log-");
    const path = join(dir, "changes.jsonl");
    const log = new ChangeLog(path, { rollBytes: 400 });
    for (let n = 1; n <= 30; n++) await log.append({ kind: "event", n });
    await log.drain();

    assert.ok(existsSync(`${path}.old`), "the live file rolled");
    assert.ok(statSync(path).size <= 400 + 120, "the live file stays near its cap");
    assert.ok(statSync(`${path}.old`).size <= 400 + 120, "and only one generation is kept");
    const seqs = (await log.readAll()).map((r) => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), ".old is read before the live file");
    assert.equal(seqs.at(-1), 30, "the newest record is the last one appended");
    assert.equal(new Set(seqs).size, seqs.length, "no seq is repeated across the roll");
  });

  it("resumes the seq from .old when a restart finds the live file just rolled", async () => {
    const dir = await tempDir("arke-log-");
    const path = join(dir, "changes.jsonl");
    await writeFile(`${path}.old`, [1, 2, 3].map((seq) => JSON.stringify({ at: 1, seq, kind: "event" })).join("\n") + "\n");

    const log = new ChangeLog(path);
    await log.append({ kind: "event", n: 4 });
    await log.drain();
    assert.deepEqual((await log.readAll()).map((r) => r.seq), [1, 2, 3, 4], "a roll never restarts the sequence");
  });

  it("finds the last seq behind a line longer than any whole-file read could hold", async () => {
    const dir = await tempDir("arke-log-");
    const path = join(dir, "changes.jsonl");
    // A legacy catalogue record was ~1.5 MB on one line; the seq sits at its start.
    await writeFile(path, JSON.stringify({ at: 1, seq: 41, kind: "event" }) + "\n" +
      JSON.stringify({ at: 2, seq: 42, kind: "event", voices: "x".repeat(2 * 1024 * 1024) }) + "\n");
    const log = new ChangeLog(path);
    await log.append({ kind: "event", n: 43 });
    await log.drain();
    assert.equal((await log.readAll()).at(-1)?.seq, 43);
  });

  it("cuts a legacy log far past the cap down to its tail instead of keeping it all as .old", async () => {
    const dir = await tempDir("arke-log-");
    const path = join(dir, "changes.jsonl");
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ at: 1, seq: i + 1, kind: "event", pad: "y".repeat(40) }));
    await writeFile(path, lines.join("\n") + "\n");
    const log = new ChangeLog(path, { rollBytes: 1000 });

    await log.append({ kind: "event", n: "next" });
    await log.drain();
    assert.ok(statSync(`${path}.old`).size <= 1000, "the gigabytes are freed now, not on the next roll");
    const kept = (await readFile(`${path}.old`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
    assert.equal(kept.at(-1)?.seq, 200, "and what survives is the newest history, whole lines only");
    assert.deepEqual((await log.readAll()).map((r) => r.seq).at(-1), 201);
  });
});
