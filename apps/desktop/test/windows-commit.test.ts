import assert from "node:assert/strict";
import { it } from "node:test";
import { createWindowsCommitProbe } from "../src/windows-commit.js";

const AT = "2026-10-21T12:00:00.000Z";
const VALUES = { committedBytes: 50 * 1024 ** 3, limitBytes: 143 * 1024 ** 3, physicalAvailableBytes: 1024 ** 3 };

it("returns no Windows probe on other platforms and never invokes its query", () => {
  for (const platform of ["linux", "darwin"]) {
    const probe = createWindowsCommitProbe({ platform, query: async () => { assert.fail("Windows query on another platform"); } });
    assert.equal(probe, undefined);
  }
});

it("keeps commit separate from physical RAM and timestamps each attempt, including failure", async () => {
  let failed = false;
  const probe = createWindowsCommitProbe({ platform: "win32", now: () => AT,
    query: async () => { if (failed) throw new Error("timed out"); return JSON.stringify(VALUES); } })!;
  assert.deepEqual(await probe(), { source: "windows-performance-memory", measuredAt: AT, values: VALUES });
  failed = true;
  assert.deepEqual(await probe(), { source: "windows-performance-memory", measuredAt: AT, values: null });
});

it("reports malformed or incomplete counters as unknown instead of inventing a capacity", async () => {
  for (const output of ["", "null", "[]", "{}", JSON.stringify({ ...VALUES, limitBytes: null }),
    JSON.stringify({ ...VALUES, committedBytes: -1 }), JSON.stringify({ ...VALUES, limitBytes: Number.MAX_SAFE_INTEGER + 1 })]) {
    const probe = createWindowsCommitProbe({ platform: "win32", now: () => AT, query: async () => output })!;
    assert.equal((await probe()).values, null);
  }
});

it("shares an in-flight Windows read across concurrent readiness readers, then reads again", async () => {
  let calls = 0;
  let complete!: (value: string) => void;
  const probe = createWindowsCommitProbe({ platform: "win32", now: () => AT,
    query: () => { calls++; return new Promise(resolve => { complete = resolve; }); } })!;
  const one = probe(), two = probe();
  assert.equal(calls, 1);
  complete(JSON.stringify(VALUES));
  assert.deepEqual(await one, await two);
  const next = probe();
  assert.equal(calls, 2);
  complete(JSON.stringify(VALUES));
  await next;
});
