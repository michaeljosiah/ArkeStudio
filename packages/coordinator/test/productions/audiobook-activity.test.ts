import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudiobookActivity } from "@arke-studio/contracts";
import { AudiobookActivityJournal } from "../../src/productions/audiobook-activity.js";

const at = "2026-10-10T12:00:00.000Z";
const initial = { id: "01J8F3K2QW9VZX4N7M0RTYB6HD", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", productionId: "bell-watch", chapterId: "crossing", chapterFile: "01-crossing", chapterTitle: "The crossing", productionTitle: "Bell Watch", worldName: "The Undersong", scope: "chapter" as const, startedAt: at };

it("records only accepted reads, publishes persisted progress, and interrupts unfinished work on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-read-activity-"));
  const path = join(dir, "queue", "reads.jsonl");
  const seen: AudiobookActivity[] = [];
  try {
    const journal = new AudiobookActivityJournal(path, run => seen.push(run), () => at);
    await journal.update(initial.id, { phase: "interrupted" }, initial);
    assert.equal(seen.length, 0, "a quote or consent refusal never became a running read");
    await journal.update(initial.id, { phase: "queued", toMake: 20, requests: 3 }, initial);
    await Promise.all([
      journal.update(initial.id, { phase: "reading", request: 1, job: { id: "request-a", index: 1, reused: false } }),
      journal.update(initial.id, { phase: "aligning" }),
      journal.update(initial.id, { made: 6 }),
    ]);
    await journal.drain();
    const rows = (await readFile(path, "utf8")).trim().split("\n").map(row => JSON.parse(row));
    assert.deepEqual(rows.at(-1), seen.at(-1));
    assert.equal(rows.at(-1).phase, "aligning", "job success did not finish the operation");
    await appendFile(path, '{"id":"torn');
    const restored = new AudiobookActivityJournal(path, () => {}, () => at);
    const [read] = await restored.load();
    assert.equal(read?.phase, "interrupted");
    assert.equal(read?.made, 6);
    assert.deepEqual(read?.jobs, [{ id: "request-a", index: 1, reused: false }]);
    assert.match(read?.reason ?? "", /restarted/);
    assert.ok((await readFile(path, "utf8")).endsWith("\n"), "repaired and durably recorded interruption");
    await restored.update(initial.id, { phase: "stopping" });
    assert.equal(restored.all()[0]?.phase, "interrupted", "late abort cannot revive a finished row");
    const stopped = new AudiobookActivityJournal(undefined, () => {}, () => at);
    await stopped.update(initial.id, { phase: "queued", toMake: 20 }, initial);
    await stopped.update(initial.id, { phase: "stopping" });
    await stopped.update(initial.id, { phase: "aligning", made: 6 });
    assert.equal(stopped.all()[0]?.phase, "stopping", "in-flight progress cannot undo Stop");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("refuses corrupt complete records without truncating or publishing partial recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-read-corrupt-"));
  const path = join(dir, "reads.jsonl");
  try {
    for (const complete of ['not-json\n', '{"id":"foreign"}\n']) {
      const bytes = complete + '{"unfinished';
      await writeFile(path, bytes);
      const seen: AudiobookActivity[] = [];
      const journal = new AudiobookActivityJournal(path, row => seen.push(row));
      await assert.rejects(journal.load(), /unreadable complete record at line 1/);
      assert.equal(await readFile(path, "utf8"), bytes);
      assert.deepEqual(seen, []);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
