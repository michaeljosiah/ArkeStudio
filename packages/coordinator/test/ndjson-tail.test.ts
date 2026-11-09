import assert from "node:assert/strict";
import { it } from "node:test";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job, LedgerEntry } from "@arke-studio/contracts";
import { NdjsonTail } from "../src/ndjson-tail.js";
import { LedgerFile } from "../src/spend/ledger.js";
import { JobQueue } from "../src/queue/dispatcher.js";
import { tempDir } from "./tmp.js";

/**
 * Append-only journals read by what they gained (issue 2792): every finished job reread and parsed
 * the ledger, the job journal and the Bench logs whole.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const row = (n: number) => JSON.stringify({ n }) + "\n";

function counted() {
  let parsed = 0;
  return { parse: (value: unknown) => { parsed++; if (typeof (value as { n?: unknown }).n !== "number") throw new Error("not a row"); return value as { n: number }; }, parsed: () => parsed };
}

it("parses only what was appended, and holds back a torn row until it is whole", async () => {
  const path = join(await tempDir("arke-tail-"), "log.jsonl");
  await writeFile(path, row(1) + row(2));
  const count = counted(), tail = new NdjsonTail(path, count.parse);
  const first = await tail.read();
  assert.deepEqual(first.entries.map(r => r.n), [1, 2]);
  assert.equal(count.parsed(), 2);

  await appendFile(path, row(3) + '{"n":4');
  const grown = await tail.read();
  assert.deepEqual(grown.entries.map(r => r.n), [1, 2, 3]);
  assert.equal(grown.torn, true, "the unfinished row is reported, not consumed");
  assert.equal(grown.generation, first.generation, "a continuation");
  assert.equal(count.parsed(), 3, "only the appended row");
  assert.deepEqual(first.entries.map(r => r.n), [1, 2], "an earlier read's entries never change under its caller");

  await appendFile(path, "}\nnot json\n");
  const finished = await tail.read();
  assert.deepEqual(finished.entries.map(r => r.n), [1, 2, 3, 4]);
  assert.equal(finished.torn, false);
  assert.equal(finished.rejected, 1, "a line that does not parse is counted, never fatal");
});

it("rereads from the start after a replacement or a shrink", async () => {
  const dir = await tempDir("arke-tail-");
  const path = join(dir, "log.jsonl");
  await writeFile(path, row(1) + row(2) + row(3));
  const count = counted(), tail = new NdjsonTail(path, count.parse);
  const first = await tail.read();

  // A repair or compaction lands by rename: a new file under the same name.
  await writeFile(join(dir, "next.tmp"), row(1) + row(2) + row(3) + row(9));
  await rename(join(dir, "next.tmp"), path);
  const replaced = await tail.read();
  assert.deepEqual(replaced.entries.map(r => r.n), [1, 2, 3, 9]);
  assert.notEqual(replaced.generation, first.generation);
  assert.equal(count.parsed(), 3 + 4);

  await writeFile(path, row(5));
  const shrunk = await tail.read();
  assert.deepEqual(shrunk.entries.map(r => r.n), [5]);
  assert.notEqual(shrunk.generation, replaced.generation);
});

it("throws what readFile threw, a directory included, and starts again once the file is back", async () => {
  const dir = await tempDir("arke-tail-");
  const path = join(dir, "log.jsonl");
  const tail = new NdjsonTail(path, counted().parse);
  await assert.rejects(tail.read(), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await mkdir(path);
  await assert.rejects(tail.read(), (error: NodeJS.ErrnoException) => error.code === "EISDIR", "a directory is unreadable, not empty");
  await rm(path, { recursive: true });
  await writeFile(path, row(7));
  assert.deepEqual((await tail.read()).entries.map(r => r.n), [7]);
});

it("answers one job's ledger entry from an index, strict where it appends and tolerant where it decorates", async () => {
  const [template] = (await readFile(join(FIXTURES, "ledger.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as LedgerEntry);
  const dir = await tempDir("arke-ledger-");
  const ledger = new LedgerFile(join(dir, "ledger.jsonl"));
  assert.equal(await ledger.has("jb_01J8E0000000000000000000A1"), false, "no file yet is an empty ledger");
  await ledger.append({ ...template!, jobId: "jb_01J8E0000000000000000000A1", actualMicroUsd: 11 });
  await ledger.append({ ...template!, jobId: "jb_01J8E0000000000000000000A2", actualMicroUsd: 22 });
  // A second entry for one job is a duplicate the reconciliation must see; lookups keep the first.
  await ledger.append({ ...template!, jobId: "jb_01J8E0000000000000000000A1", actualMicroUsd: 99 });
  assert.equal(await ledger.has("jb_01J8E0000000000000000000A2"), true);
  assert.equal((await ledger.entryFor("jb_01J8E0000000000000000000A1"))?.actualMicroUsd, 11);
  assert.deepEqual([...(await ledger.readJobIds())].sort(), ["jb_01J8E0000000000000000000A1", "jb_01J8E0000000000000000000A2"]);
  assert.equal((await ledger.readAllStrict()).length, 3);

  const unreadable = new LedgerFile(join(dir, "unreadable"));
  await mkdir(join(dir, "unreadable"));
  await assert.rejects(unreadable.has("jb_01J8E0000000000000000000A1"), "an unreadable ledger never answers 'not billed'");
  assert.equal(await unreadable.entryFor("jb_01J8E0000000000000000000A1"), undefined);
  assert.deepEqual(await unreadable.readAllChecked(), { entries: [], unavailable: true });
});

it("looks a job up by id, by test and by state without copying the history", async () => {
  const [template] = (await readFile(join(FIXTURES, "queue", "jobs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Job);
  const dir = await tempDir("arke-queue-");
  const journalPath = join(dir, "jobs.jsonl");
  const ids = ["jb_01J8E0000000000000000000B1", "jb_01J8E0000000000000000000B2", "jb_01J8E0000000000000000000B3"];
  await writeFile(journalPath, [
    { ...template!, id: ids[0], idempotencyKey: "01J8E1000000000000000000B1", status: "succeeded" },
    { ...template!, id: ids[1], idempotencyKey: "01J8E1000000000000000000B2", status: "failed", error: "refused" },
    { ...template!, id: ids[2], idempotencyKey: "01J8E1000000000000000000B3", status: "cancelled" },
  ].map(job => JSON.stringify(job)).join("\n") + "\n");
  const queue = new JobQueue({ journalPath, clients: {}, getKey: async () => "test", emit: () => {},
    ledger: { readJobIds: async () => new Set(ids), has: async () => true, append: async () => {} },
    landInWorld: async () => false, baseIntervalMs: 1, pollIntervalMs: 1, maxAttempts: 1 });
  await queue.start();
  try {
    assert.equal(queue.get(ids[1]!)?.status, "failed");
    assert.equal(queue.get("jb_01J8E0000000000000000000ZZ"), undefined);
    assert.equal(queue.find(job => job.status === "cancelled")?.id, ids[2]);
    assert.deepEqual(queue.active(), [], "terminal jobs are history, not active");
    assert.deepEqual(queue.listJobs().map(job => job.id), ids);
  } finally {
    await queue.dispose();
  }
});
