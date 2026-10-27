import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { CacheCleanupControl, type CacheCleanupStore } from "../../src/storage/cache-cleanup-control.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

const key = "a".repeat(64), planId = "b".repeat(64);
const entry = { key, evidence: key, rootIdentity: key, fileIdentity: key };
it("flushes one exact intent before authority and retains bounded outcomes independently of incidents", async () => {
  const root = await tempDir("arke-cleanup-control-"), path = join(root, "control.json");
  const control = new CacheCleanupControl(path); await control.open();
  const id = await control.begin(planId, entry, () => true); assert(id);
  const disk = JSON.parse(await readFile(path, "utf8")); assert.equal(disk.pending.id, id); assert.equal(disk.pending.key, key);
  assert.equal(await control.begin(planId, entry, () => true), null);
  assert.equal(await control.settle("c".repeat(64), "removed"), false);
  assert(await control.settle(id, "removed")); assert.equal(control.snapshot().available, true);
  assert.equal(control.snapshot().outcomes[0]?.status, "removed");
  assert.equal((await readFile(path, "utf8")).includes(root), false);
  control.closeAdmission();
});
it("startup and unknown native outcomes retain authority and never authorize replay", async () => {
  const root = await tempDir("arke-cleanup-restart-"), path = join(root, "control.json");
  const first = new CacheCleanupControl(path); await first.open();
  const id = await first.begin(planId, entry, () => true); assert(id); assert(await first.settle(id, "unknown"));
  first.closeAdmission();
  const next = new CacheCleanupControl(path); await next.open();
  assert.equal(next.snapshot().pending, true); assert.equal(next.snapshot().available, false);
  assert.equal(await next.begin(planId, entry, () => true), null);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.phase, "unknown"); next.closeAdmission();
});
it("failed or revoked audit cannot authorize mutation and save uncertainty retains its target", async () => {
  let fail = true, valid = true;
  const store: CacheCleanupStore = { load: async () => ({ version: 1, pending: null, outcomes: [] }), save: async () => {
    valid = false; if (fail) throw Object.assign(Error("PRIVATE_PATH"), { code: "ENOSPC" });
  } };
  const failed = new CacheCleanupControl("unused", { store }); await failed.open();
  assert.equal(await failed.begin(planId, entry, () => true), null); assert.equal(failed.snapshot().pending, true);
  assert(!JSON.stringify(failed.snapshot()).includes("PRIVATE_")); failed.closeAdmission();
  fail = false; valid = true;
  const revoked = new CacheCleanupControl("unused", { store }); await revoked.open();
  assert.equal(await revoked.begin(planId, entry, () => valid), null);
  assert.equal(revoked.snapshot().pending, false); assert.equal(revoked.snapshot().outcomes[0]?.status, "not-started"); revoked.closeAdmission();
});
it("bounds a stalled flush at shutdown and refuses its late execution authority", async () => {
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  let calls = 0;
  const store: CacheCleanupStore = { load: async () => ({ version: 1, pending: null, outcomes: [] }),
    save: async () => { if (calls++ === 0) { entered(); await new Promise<void>(done => { finish = done; }); } } };
  const control = new CacheCleanupControl("unused", { store, stopMs: 10 }); await control.open();
  const work = control.begin(planId, entry, () => true); await started; control.closeAdmission();
  assert.equal(await work, null); assert.equal(control.snapshot().available, false);
  finish();
  await until(() => control.snapshot().outcomes[0]?.status === "not-started", "late flush to settle without granting mutation", 1000);
});
