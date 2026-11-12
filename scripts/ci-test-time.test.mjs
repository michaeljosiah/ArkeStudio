import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const reporter = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "ci-test-time.mjs")).href;

test("the reporter separates a file's load from its tests, on the Node that runs CI (issue 2825)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arke-ci-test-time-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "test"));
  // A slow import graph stands in as a top-level wait before the first test is registered.
  writeFileSync(join(dir, "test", "slow.test.mjs"), [
    'import { setTimeout as delay } from "node:timers/promises";',
    "await delay(700);",
    'import { test, describe, it } from "node:test";',
    'test("quick", () => {});',
    'describe("group", () => { it("waits", async () => { await delay(150); }); });',
  ].join("\n"));
  writeFileSync(join(dir, "test", "fast.test.mjs"), 'import { test } from "node:test";\ntest("one", () => {});\n');
  const out = join(dir, "times.jsonl");
  // Without this the inner runner takes itself for one of this runner's children and reports to it.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
    `--test-reporter=${reporter}`, `--test-reporter-destination=${out}`, "test/*.test.mjs"], { cwd: dir, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^TAP version 13/m, "the log is still TAP");
  const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const slow = rows.find((row) => row.file.endsWith("slow.test.mjs")), fast = rows.find((row) => row.file.endsWith("fast.test.mjs"));
  assert.ok(slow && fast, JSON.stringify(rows));
  assert.ok(slow.testsMs >= 140 && slow.testsMs < 600, `its tests, the suite counted once: ${slow.testsMs}`);
  assert.ok(slow.wallMs - slow.testsMs >= 650, `the wait before its first test is outside them: ${JSON.stringify(slow)}`);
  assert.ok(fast.wallMs > 0 && fast.testsMs < fast.wallMs);
});
