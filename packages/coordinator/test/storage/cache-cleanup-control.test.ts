import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { CacheCleanupControl, type CacheCleanupStore } from "../../src/storage/cache-cleanup-control.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { CACHE_MAINTENANCE_POLICY } from "@arke-studio/contracts";

const key = "a".repeat(64), planId = "b".repeat(64);
const entry = { key, evidence: key, rootIdentity: key, fileIdentity: key };
const proven = { ...entry, proof: { rootIdentity: key, fileIdentity: key, contentHash: key, nodeRootIdentity: key,
  nodeFileIdentity: key, modifiedNs: "1", bytes: 1, allocatedBytes: 1, writeTicks: "1", observedAt: 1 } };
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
  assert.equal(control.quiescent(), false, "bounded shutdown retains the original write chain");
  finish();
  await until(() => control.snapshot().outcomes[0]?.status === "not-started", "late flush to settle without granting mutation", 1000);
  await until(() => control.quiescent(), "original control write chain to finish", 1000);
});

it("flushes the exact worker before admission, rechecks revocation and refuses another worker", async () => {
  const root = await tempDir("arke-cleanup-worker-"), path = join(root, "control.json");
  const control = new CacheCleanupControl(path); await control.open();
  const id = await control.begin(planId, proven, () => true); assert(id);
  assert.equal(await control.admitWorker(id, 42, () => false), false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.workerPid, undefined);
  assert(await control.admitWorker(id, 42, () => true));
  const disk = JSON.parse(await readFile(path, "utf8")); assert.equal(disk.pending.workerPid, 42);
  assert.equal(disk.pending.owner.pid, process.pid); assert.equal(disk.pending.owner.gate, "native-input-v1");
  assert.equal(await control.admitWorker(id, 43, () => true), false);
  assert.equal(await control.resolve(id, "retained", () => false), false);
  assert(await control.resolve(id, "retained", () => true)); assert.equal(control.snapshot().pending, false); control.closeAdmission();
});

it("restores a rejected outcome write only from the same saved intent and preserves prior records", async () => {
  let disk: unknown = { version: 1, pending: null, outcomes: [] }, fail = false;
  const store: CacheCleanupStore = { load: async () => structuredClone(disk), save: async state => {
    if (fail) throw Object.assign(Error("private write failed"), { code: "ENOSPC" }); disk = structuredClone(state);
  } };
  const control = new CacheCleanupControl("unused", { store }); await control.open();
  const id = await control.begin(planId, proven, () => true); assert(id);
  fail = true; assert.equal(await control.settle(id, "removed"), false); assert.equal(control.snapshot().audit, "unavailable");
  fail = false; assert(await control.resolve(id, "removed", () => true)); assert.equal(control.snapshot().audit, "available");
  assert.equal(control.snapshot().outcomes.at(-1)?.status, "removed");
  const next = await control.begin(planId, proven, () => true); assert(next);
  const changed = structuredClone(disk) as { pending: { id: string } }; changed.pending.id = "c".repeat(64); disk = changed;
  assert.equal(await control.resolve(next, "retained", () => true), false); assert.equal(control.snapshot().pending, true);
  control.closeAdmission();
});

it("can settle a positively verified intent after startup audit failure, but never clears a legacy unknown", async () => {
  let disk: unknown = { version: 1, pending: null, outcomes: [] }, fail = false;
  const store: CacheCleanupStore = { load: async () => structuredClone(disk), save: async state => {
    if (fail) throw Object.assign(Error("audit unavailable"), { code: "ENOSPC" }); disk = structuredClone(state);
  } };
  const first = new CacheCleanupControl("unused", { store }); await first.open();
  const id = await first.begin(planId, proven, () => true); assert(id); first.closeAdmission();
  fail = true; const restarted = new CacheCleanupControl("unused", { store }); await restarted.open();
  assert.equal(restarted.snapshot().audit, "unavailable"); assert.equal(restarted.snapshot().available, false);
  assert.equal(restarted.pendingForReconciliation()?.id, id);
  fail = false; assert(await restarted.resolve(id, "retained", () => true)); assert.equal(restarted.snapshot().available, true);
  const legacyId = await restarted.begin(planId, entry, () => true); assert(legacyId);
  assert.equal(await restarted.resolve(legacyId, "retained", () => true), false); assert.equal(restarted.snapshot().pending, true);
  restarted.closeAdmission();
});

it("requires saved opt-in, binds the exact root and attempt, and retains cooldown and withdrawal across restart", async () => {
  const root = await tempDir("arke-maintenance-policy-"), path = join(root, "control.json"); let now = 1000;
  const first = new CacheCleanupControl(path, { now: () => now }); await first.open();
  assert.equal(await first.reserveMaintenance(planId, key, () => true), null);
  assert(await first.setMaintenance(true, key, () => true));
  assert.equal(await first.reserveMaintenance(planId, "c".repeat(64), () => true), null);
  const token = await first.reserveMaintenance(planId, key, () => true); assert(token);
  assert(first.maintenanceCurrent(planId, token, key)); assert.equal(first.quiescent(), false);
  const run = { status: "verified" as const, cleanup: { removedFiles: 0, logicalBytes: 0, availableBefore: 1, availableAfter: 2, reclaimedBytes: null } };
  await first.finishMaintenance("c".repeat(64), run); assert(first.maintenanceCurrent(planId, token, key));
  await first.finishMaintenance(planId, run); assert.equal(first.maintenanceCurrent(planId, token, key), false); first.closeAdmission();
  const next = new CacheCleanupControl(path, { now: () => now }); await next.open();
  assert.equal(next.maintenancePolicy()?.enabled, true); assert.equal(next.maintenancePolicy()?.lastRun?.cleanup.reclaimedBytes, null);
  assert.equal(await next.reserveMaintenance(planId, key, () => true), null);
  now += CACHE_MAINTENANCE_POLICY.intervalMs;
  const renewed = await next.reserveMaintenance(planId, key, () => true); assert(renewed);
  next.revokeMaintenance(); assert.equal(next.maintenanceCurrent(planId, renewed, key), false);
  assert(await next.setMaintenance(false, null, () => true)); await next.finishMaintenance(planId, { ...run, status: "cancelled" }); next.closeAdmission();
  const stopped = new CacheCleanupControl(path, { now: () => now }); await stopped.open();
  assert.equal(stopped.maintenancePolicy()?.enabled, false); assert.equal(await stopped.reserveMaintenance(planId, key, () => true), null); stopped.closeAdmission();
});

it("withdrawal during a worker-record flush revokes its late native input grant", async () => {
  let disk: unknown = { version: 1, pending: null, outcomes: [] }, hold = false, finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const store: CacheCleanupStore = { load: async () => structuredClone(disk), save: async state => {
    if (hold) { entered(); await new Promise<void>(resolve => { finish = resolve; }); hold = false; } disk = structuredClone(state);
  } };
  const control = new CacheCleanupControl("unused-maintenance-gate", { store }); await control.open(); assert(await control.setMaintenance(true, key, () => true));
  const token = await control.reserveMaintenance(planId, key, () => true); assert(token);
  const valid = () => control.maintenanceCurrent(planId, token, key);
  const id = await control.begin(planId, { ...proven, automatic: true }, valid); assert(id);
  hold = true; const admitted = control.admitWorker(id, 42, valid); await started;
  control.revokeMaintenance(); finish(); assert.equal(await admitted, false);
  assert(await control.settle(id, "not-started"));
  await control.finishMaintenance(planId, { status: "cancelled", cleanup: { removedFiles: 0, logicalBytes: 0, availableBefore: null, availableAfter: null, reclaimedBytes: null } });
  assert.equal(control.snapshot().outcomes.at(-1)?.automatic, true); control.closeAdmission();
});

it("retains the original file-control owner through an abandoned shutdown write", async () => {
  const root = await tempDir("arke-maintenance-owner-"), path = join(root, "control.json");
  let disk: unknown = { version: 1, pending: null, outcomes: [] }, finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); let hold = true;
  const store: CacheCleanupStore = { load: async () => structuredClone(disk), save: async state => {
    if (hold) { entered(); await new Promise<void>(resolve => { finish = resolve; }); hold = false; } disk = structuredClone(state);
  } };
  const first = new CacheCleanupControl(path, { store, stopMs: 10 }); await first.open();
  const saving = first.setMaintenance(true, key, () => true); await started; first.closeAdmission(); assert.equal(await saving, false);
  const blocked = new CacheCleanupControl(path, { store }); await blocked.open(); assert.equal(blocked.snapshot().audit, "unavailable");
  assert.equal(await blocked.setMaintenance(true, key, () => true), false); blocked.closeAdmission();
  finish(); await until(() => first.quiescent(), "original policy writer to settle", 1000);
  const next = new CacheCleanupControl(path, { store }); await next.open();
  assert(await next.setMaintenance(false, null, () => true)); assert.equal(next.maintenancePolicy()?.enabled, false); next.closeAdmission();
});
