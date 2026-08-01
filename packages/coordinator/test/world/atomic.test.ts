import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { rename } from "node:fs/promises";
import { tempDir } from "../tmp.js";
import { atomicWriteFile, renameWithRetry } from "../../src/world/atomic.js";
import { appendChanges, readChanges } from "../../src/world/change-writer.js";
import { writeFile } from "node:fs/promises";

describe("atomic writes (R-13, R-14)", () => {
  it("stages and renames — no partial file ever visible at the target", async () => {
    const dir = await tempDir("arke-atomic-");
    const target = join(dir, "sheet.md");
    await atomicWriteFile(target, "content one");
    assert.equal(await readFile(target, "utf8"), "content one");
    await atomicWriteFile(target, "content two");
    assert.equal(await readFile(target, "utf8"), "content two");
    const leftovers = (await readdir(dir)).filter((f) => f.startsWith(".tmp-"));
    assert.deepEqual(leftovers, [], "no staging debris after success");
  });

  it("retries a transiently failing rename with backoff (R-14, D7)", async () => {
    const dir = await tempDir("arke-atomic-");
    let failures = 2;
    const flaky = async (from: string, to: string) => {
      if (failures-- > 0) {
        const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      await rename(from, to);
    };
    await atomicWriteFile(join(dir, "held.md"), "made it", { rename: flaky });
    assert.equal(await readFile(join(dir, "held.md"), "utf8"), "made it");
    assert.equal(failures, -1, "rename was attempted three times");
  });

  it("gives up after the retry budget on a permanently held target", async () => {
    const always = async () => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    await assert.rejects(() => renameWithRetry("a", "b", { rename: always }), /EPERM/);
  });
});

describe("changes.jsonl tolerance (R-21, R-22)", () => {
  it("discards a truncated final line on read and repairs it on append", async () => {
    const dir = await tempDir("arke-changes-");
    const path = join(dir, "changes.jsonl");
    await writeFile(
      path,
      '{"ts":"2026-08-01T10:00:00Z","entity":"a","source":"x"}\n{"ts":"2026-08-01T10:01:00Z","ent',
      "utf8",
    );
    const before = await readChanges(path);
    assert.equal(before.length, 1, "the crash-truncated tail is tolerated");

    await appendChanges(path, [{ ts: "2026-08-01T10:02:00Z", entity: "b", source: "x" }]);
    const after = await readChanges(path);
    assert.equal(after.length, 2);
    assert.equal(after[1]!["entity"], "b");
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n"));
    // The partial line was terminated, never merged into a valid record.
    assert.ok(!raw.includes('"ent{"'));
  });
});
