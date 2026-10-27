import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import type { RecoveryControl } from "@arke-studio/contracts";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { FileRecoveryControlStore, type RecoveryControlStore } from "../../src/recovery/control-file.js";
import { tempDir } from "../tmp.js";

const key = "a".repeat(64), componentDigest = "b".repeat(64), identity = { key, service: "comfyui" as const };
const context = { ownership: "managed" as const, idle: true, exitConfirmed: true, generation: 4, componentDigest };
const request = { ...identity, context, automatic: true };
const fresh = (): RecoveryControl => ({ version: 1, policyRevision: 1, mode: "automatic", targets: [] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it("revalidates a reviewed offer after earlier control writes and before recording new authority", async () => {
  const entered = deferred(), finish = deferred(); let valid = true, disk = fresh();
  const service = new RecoveryControlService({ store: { load: async () => disk, save: async value => { entered.resolve(); await finish.promise; disk = structuredClone(value); } } });
  await service.open(); const mode = service.setMode("suggest-only"); await entered.promise;
  const requested = service.authorize({ ...request, automatic: false, revalidate: () => valid });
  valid = false; finish.resolve(); await mode;
  assert.deepEqual(await requested, { status: "held", reason: "target-changed" }); assert.equal(disk.targets.length, 0); await service.stop();
});

it("atomically retains exact owner outcome receipts across restart without refunding attempts or exposing authority", async () => {
  const h = harness(); await h.service.open();
  try {
    const automatic = await h.service.authorize(request); assert(automatic.status === "authorized");
    h.advance(1000); assert(await h.service.settleFromOwner(key, automatic.intent.id, "failed"));
    for (const outcome of ["failed", "not-started", "unknown", "verified"] as const) {
      const grant = await h.service.authorize({ ...request, automatic: false }); assert(grant.status === "authorized");
      h.advance(1);
      assert(await h.service.settleFromOwner(key, grant.intent.id, outcome));
      const target = h.disk().targets[0]!; assert.equal(target.lastOutcome?.intentId, grant.intent.id); assert.equal(target.lastOutcome?.generation, context.generation);
      assert.equal(target.attempts.length, 1, "receipt replacement does not refund rolling attempts");
      assert.equal(target.lastOutcome?.componentDigest, context.componentDigest); assert.equal(target.lastOutcome?.outcome, outcome);
      assert.equal(target.intent !== null, outcome === "unknown");
      const summary = h.service.policySnapshot().targets[0]!.lastOutcome!; assert.equal(summary.outcome, outcome);
      assert(!JSON.stringify(summary).includes(grant.intent.id)); assert(!JSON.stringify(summary).includes(context.componentDigest));
      assert.equal(await h.service.settleFromOwner(key, "c".repeat(64), "verified"), false);
      if (outcome === "unknown") assert(await h.service.settleFromOwner(key, grant.intent.id, "not-started"));
    }
    const restarted = new RecoveryControlService({ store: h.store, now: h.now }); await restarted.open();
    assert.equal(restarted.policySnapshot().targets[0]!.lastOutcome?.outcome, "verified"); await restarted.stop();
  } finally { await h.service.stop(); }
});

it("reconstructs interrupted outcomes as unknown and downgrades an uncertain receipt write", async () => {
  const h = harness(); await h.service.open(); const grant = await h.service.authorize(request); assert(grant.status === "authorized");
  await h.service.stop(); const restarted = new RecoveryControlService({ store: h.store, now: h.now }); await restarted.open();
  assert.equal(restarted.policySnapshot().targets[0]!.lastOutcome?.outcome, "unknown");
  assert.equal(restarted.snapshot().control.targets[0]!.intent?.id, grant.intent.id);
  await restarted.stop();
  const failing = new RecoveryControlService({ now: h.now, store: { load: () => h.store.load(), save: async () => { throw Object.assign(Error("PRIVATE_DISK_ERROR"), { code: "ENOSPC" }); } } });
  await failing.open(); assert.equal(await failing.settleFromOwner(key, grant.intent.id, "verified"), false);
  assert.equal(failing.policySnapshot().targets[0]!.lastOutcome?.outcome, "unknown");
  assert.equal(failing.snapshot().control.targets[0]!.intent?.phase, "unknown"); assert.equal(failing.snapshot().reason, "disk-full");
  assert(!JSON.stringify(failing.policySnapshot()).includes("PRIVATE_DISK_ERROR")); await failing.stop();
});

for (const phase of ["read", "authorize", "begin"] as const) it(`bounds an in-flight ${phase} during shutdown without granting late authority`, { timeout: 5000 }, async () => {
  const entered = deferred(), finish = deferred(); let disk = fresh(), blocked = phase === "read", now = 2_000_000;
  const service = new RecoveryControlService({ now: () => now, stopTimeoutMs: 20, store: {
    load: async () => { if (blocked) { entered.resolve(); await finish.promise; } return disk; },
    save: async value => { if (blocked) { entered.resolve(); await finish.promise; } disk = structuredClone(value); },
  } });
  let pending: Promise<unknown>;
  if (phase === "read") pending = service.open();
  else {
    await service.open();
    if (phase === "begin") {
      const grant = await service.authorize(request); assert.equal(grant.status, "authorized"); if (grant.status !== "authorized") return;
      now += 1000; blocked = true; pending = service.begin(key, grant.intent.id, () => context);
    } else { blocked = true; pending = service.authorize(request); }
  }
  await entered.promise; service.closeAdmission();
  assert.deepEqual(await pending, phase === "read" ? undefined : { status: "held", reason: "stopped" });
  await service.stop(); assert.equal(service.snapshot().audit, "unavailable");
  assert.equal(service.snapshot().reason, phase === "read" ? "read-failed" : "write-failed");
  finish.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.snapshot().accepting, false);
  if (phase !== "read") {
    const restarted = new RecoveryControlService({ store: { load: async () => disk, save: async () => {} } });
    await restarted.open(); assert.equal(restarted.snapshot().control.targets[0]!.intent!.phase, "unknown");
    assert.equal(restarted.snapshot().control.targets[0]!.attempts.length, 1); await restarted.stop();
  }
});

it("cancels a mode receipt on admission close and bounds blocked control drain without granting late authority", { timeout: 5000 }, async () => {
  const entered = deferred(), finish = deferred(); let disk = fresh(), saves = 0;
  const service = new RecoveryControlService({ stopTimeoutMs: 20, store: { load: async () => disk, save: async value => {
    saves++; if (value.mode === "suggest-only") { entered.resolve(); await finish.promise; } disk = structuredClone(value);
  } } });
  await service.open();
  const mode = service.setMode("suggest-only"); await entered.promise;
  const pending = service.authorize(request);
  service.closeAdmission();
  assert.equal(await mode, false, "an unconfirmed save cannot produce a saved receipt");
  assert.deepEqual(await pending, { status: "held", reason: "stopped" });
  await service.stop(); assert.equal(service.snapshot().audit, "unavailable"); assert.equal(service.snapshot().accepting, false);
  finish.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves, 1, "no queued authority write may follow the late mode replacement");
  assert.equal(disk.mode, "suggest-only"); assert.equal(disk.targets.length, 0);
});

it("retains unknown intent and spent attempts when a blocked mode write prevents confirmed-stop settlement", { timeout: 5000 }, async () => {
  const entered = deferred(), finish = deferred(); let disk = fresh(), block = false, now = 2_000_000;
  const service = new RecoveryControlService({ now: () => now, stopTimeoutMs: 20, store: { load: async () => disk, save: async value => {
    if (block) { entered.resolve(); await finish.promise; } disk = structuredClone(value);
  } } });
  await service.open(); const grant = await service.authorize(request); assert.equal(grant.status, "authorized"); if (grant.status !== "authorized") return;
  now += 1000; assert.deepEqual(await service.begin(key, grant.intent.id, () => context), { status: "begin" });
  block = true; const mode = service.setMode("suggest-only"); await entered.promise; service.closeAdmission();
  assert.equal(await mode, false); assert.equal(await service.settleFromOwner(key, grant.intent.id, "failed"), false);
  assert.equal(service.policySnapshot().targets[0]!.lastOutcome?.outcome, "unknown");
  await service.stop(); assert.equal(service.snapshot().control.targets[0]!.intent!.phase, "unknown");
  assert.equal(service.snapshot().control.targets[0]!.attempts.length, 1);
  finish.resolve(); await new Promise(resolve => setImmediate(resolve));
  const restarted = new RecoveryControlService({ now: () => now, store: { load: async () => disk, save: async value => { disk = structuredClone(value); } } });
  await restarted.open();
  assert.equal(restarted.snapshot().control.targets[0]!.intent!.phase, "unknown");
  assert.deepEqual(await restarted.authorize(request), { status: "held", reason: "pending-outcome" }); await restarted.stop();
});
function harness(options: { disk?: RecoveryControl; save?: (value: RecoveryControl) => Promise<void> } = {}) {
  let disk = structuredClone(options.disk ?? fresh()), now = 2_000_000;
  const store: RecoveryControlStore = { load: async () => structuredClone(disk), save: async value => { await options.save?.(value); disk = structuredClone(value); } };
  const service = new RecoveryControlService({ store, now: () => now });
  return { service, store, disk: () => structuredClone(disk), now: () => now, advance: (ms: number) => { now += ms; } };
}

it("flushes a single-use intent before authorizing, and never admits two executors", async () => {
  const entered = deferred(), finish = deferred(); let returned = false;
  const h = harness({ save: async () => { entered.resolve(); await finish.promise; } }); await h.service.open();
  const first = h.service.authorize(request).then(value => { returned = true; return value; });
  await entered.promise; assert.equal(returned, false); assert.equal(h.disk().targets.length, 0);
  const second = h.service.authorize(request); finish.resolve();
  const grant = await first; assert.equal(grant.status, "authorized");
  assert.deepEqual(await second, { status: "held", reason: "pending-outcome" });
  if (grant.status !== "authorized") return;
  assert.deepEqual(await h.service.begin(key, grant.intent.id, () => context), { status: "held", reason: "too-early" });
  h.advance(1_000);
  assert.deepEqual(await h.service.begin(key, grant.intent.id, () => context), { status: "begin" });
  assert.equal(h.disk().targets[0]!.intent!.phase, "executing");
  assert.deepEqual(await h.service.begin(key, grant.intent.id, () => context), { status: "held", reason: "pending-outcome" });
  await h.service.stop();
});

it("shares three rolling attempts and 1/5/30-second delays across restarts; exhaustion stays open", async () => {
  const h = harness(); await h.service.open();
  for (const delay of [1_000, 5_000, 30_000]) {
    const grant = await h.service.authorize(request); assert.equal(grant.status, "authorized"); if (grant.status !== "authorized") return;
    assert.equal(grant.intent.notBefore - grant.intent.authorizedAt, delay);
    h.advance(delay); assert.deepEqual(await h.service.begin(key, grant.intent.id, () => context), { status: "begin" });
    assert(await h.service.settleFromOwner(key, grant.intent.id, "failed"));
  }
  await h.service.stop();
  const restarted = new RecoveryControlService({ store: h.store, now: h.now }); await restarted.open();
  assert.deepEqual(await restarted.authorize(request), { status: "held", reason: "circuit-open" });
  h.advance(16 * 60_000);
  assert.deepEqual(await restarted.authorize(request), { status: "held", reason: "circuit-open" });
  assert(await restarted.noteHealth(key, true)); h.advance(5 * 60_000); assert(await restarted.noteHealth(key, true));
  assert(restarted.snapshot().control.targets[0]!.circuitOpen, "healthy observations do not close an exhausted circuit");
  const explicit = await restarted.authorize({ ...request, automatic: false }); assert.equal(explicit.status, "authorized");
  if (explicit.status === "authorized") assert(await restarted.settleFromOwner(key, explicit.intent.id, "verified"));
  assert.equal(restarted.snapshot().control.targets[0]!.circuitOpen, false);
  await restarted.stop();
});

it("retains an interrupted intent as unknown on startup until its owner reconciles it", async () => {
  const h = harness(); await h.service.open(); const grant = await h.service.authorize(request);
  assert.equal(grant.status, "authorized"); if (grant.status !== "authorized") return;
  await h.service.stop();
  const restarted = new RecoveryControlService({ store: h.store, now: h.now }); await restarted.open();
  assert.equal(restarted.snapshot().control.targets[0]!.intent!.phase, "unknown");
  assert.deepEqual(await restarted.authorize(request), { status: "held", reason: "pending-outcome" });
  assert.deepEqual(await restarted.begin(key, grant.intent.id, () => context), { status: "held", reason: "pending-outcome" });
  assert.equal(await restarted.settleFromOwner(key, "c".repeat(64), "not-started"), false);
  assert(await restarted.settleFromOwner(key, grant.intent.id, "not-started"));
  assert.equal(restarted.snapshot().control.targets[0]!.attempts.length, 1);
  await restarted.stop();
});

it("persists Suggest only and an early user Stop without spending a restart attempt", async () => {
  const h = harness(); await h.service.open();
  assert(await h.service.setStoppedByUser(identity, true));
  assert.deepEqual(await h.service.authorize(request), { status: "held", reason: "user-stopped" });
  assert(await h.service.setMode("suggest-only")); await h.service.stop();
  const restarted = new RecoveryControlService({ store: h.store, now: h.now }); await restarted.open();
  assert.equal(restarted.snapshot().control.mode, "suggest-only"); assert(restarted.snapshot().control.targets[0]!.stoppedByUser);
  assert(await restarted.setStoppedByUser(identity, false));
  assert.deepEqual(await restarted.authorize(request), { status: "held", reason: "suggest-only" });
  assert.equal(restarted.snapshot().control.targets[0]!.attempts.length, 0); await restarted.stop();
});

it("rechecks target, work, cleanup and policy immediately before the owner can begin", async () => {
  const h = harness(); await h.service.open(); const grant = await h.service.authorize(request);
  assert.equal(grant.status, "authorized"); if (grant.status !== "authorized") return; h.advance(1_000);
  for (const [patch, reason] of [[{ generation: 5 }, "target-changed"], [{ componentDigest: "c".repeat(64) }, "target-changed"],
    [{ ownership: "external" }, "external"], [{ idle: false }, "busy"], [{ exitConfirmed: false }, "cleanup-unconfirmed"]] as const) {
    assert.deepEqual(await h.service.begin(key, grant.intent.id, () => ({ ...context, ...patch })), { status: "held", reason });
  }
  await h.service.setMode("suggest-only");
  assert.deepEqual(await h.service.begin(key, grant.intent.id, () => context), { status: "held", reason: "suggest-only" });
  await h.service.setMode("automatic"); await h.service.setStoppedByUser(identity, true);
  assert.deepEqual(await h.service.begin(key, grant.intent.id, () => context), { status: "held", reason: "user-stopped" });
  await h.service.stop();
});

it("cannot begin after a target changes or shutdown lands during the flushed begin write", async () => {
  for (const stop of [false, true]) {
    const entered = deferred(), finish = deferred(); let writes = 0, generation = 4;
    const h = harness({ save: async () => { if (++writes === 2) { entered.resolve(); await finish.promise; } } });
    await h.service.open(); const grant = await h.service.authorize(request); if (grant.status !== "authorized") throw new Error("fixture admission");
    h.advance(1_000); const starting = h.service.begin(key, grant.intent.id, () => ({ ...context, generation }));
    await entered.promise; if (stop) h.service.closeAdmission(); else generation++;
    finish.resolve(); assert.deepEqual(await starting, { status: "held", reason: stop ? "stopped" : "target-changed" });
    assert(h.service.snapshot().control.targets[0]!.intent, "unknown execution remains held for the owner"); await h.service.stop();
  }
});

it("degrades on corrupt or failed audit persistence without dropping an uncertain intent", async () => {
  const corrupt = new RecoveryControlService({ store: { load: async () => ({ version: 99 }), save: async () => { throw new Error("must not write"); } } });
  await corrupt.open(); assert.deepEqual(await corrupt.authorize(request), { status: "held", reason: "audit-unavailable" }); assert.equal(corrupt.snapshot().reason, "invalid"); await corrupt.stop();
  const h = harness({ save: async () => { throw Object.assign(new Error("private path"), { code: "ENOSPC" }); } }); await h.service.open();
  assert.deepEqual(await h.service.authorize(request), { status: "held", reason: "audit-unavailable" });
  assert.equal(h.service.snapshot().audit, "unavailable"); assert.equal(h.service.snapshot().reason, "disk-full"); assert.equal(h.service.snapshot().control.targets[0]!.intent!.phase, "unknown");
  assert.deepEqual(await h.service.authorize(request), { status: "held", reason: "audit-unavailable" }); await h.service.stop();
});

it("resets only a non-exhausted consecutive count after measured continuous health", async () => {
  const h = harness(); await h.service.open(); const grant = await h.service.authorize(request); if (grant.status !== "authorized") throw new Error("fixture admission");
  await h.service.settleFromOwner(key, grant.intent.id, "verified"); h.advance(4 * 60_000); await h.service.noteHealth(key, true);
  await h.service.noteHealth(key, false); h.advance(2 * 60_000); await h.service.noteHealth(key, true);
  assert.equal(h.service.snapshot().control.targets[0]!.consecutiveFailures, 1);
  h.advance(5 * 60_000); await h.service.noteHealth(key, true);
  assert.equal(h.service.snapshot().control.targets[0]!.consecutiveFailures, 0); assert.equal(h.service.snapshot().control.targets[0]!.attempts.length, 1);
  await h.service.stop();
});

it("does not count application downtime as continuous measured health", async () => {
  const h = harness(); await h.service.open(); const grant = await h.service.authorize(request); if (grant.status !== "authorized") throw new Error("fixture admission");
  await h.service.settleFromOwner(key, grant.intent.id, "verified"); await h.service.stop(); h.advance(6 * 60_000);
  const restarted = new RecoveryControlService({ store: h.store, now: h.now }); await restarted.open(); await restarted.noteHealth(key, true);
  assert.equal(restarted.snapshot().control.targets[0]!.consecutiveFailures, 1); await restarted.stop();
});

it("cannot refill the automatic budget by moving the clock backwards or clearing unknown work", async () => {
  const h = harness(); await h.service.open(); const grant = await h.service.authorize(request); if (grant.status !== "authorized") throw new Error("fixture admission");
  await h.service.settleFromOwner(key, grant.intent.id, "failed"); h.advance(-1);
  assert.deepEqual(await h.service.authorize(request), { status: "held", reason: "clock-reversed" }); await h.service.stop();
});

it("allows owner settlement during drain, then refuses late writes or publication after stop", async () => {
  let changes = 0, writes = 0; const disk = fresh();
  const service = new RecoveryControlService({ store: { load: async () => disk, save: async () => { writes++; } }, onChange: () => { changes++; } });
  await service.open(); const grant = await service.authorize(request); if (grant.status !== "authorized") throw new Error("fixture admission");
  service.closeAdmission(); const before = changes;
  assert(await service.settleFromOwner(key, grant.intent.id, "unknown"));
  assert.equal(changes, before); await service.stop(); const done = writes;
  assert.equal(await service.settleFromOwner(key, grant.intent.id, "not-started"), false);
  assert.deepEqual(await service.authorize(request), { status: "held", reason: "stopped" });
  assert.equal(writes, done); assert.equal(changes, before);
});

it("bounds target registrations without evicting active budgets", async () => {
  const h = harness(); await h.service.open();
  for (let n = 0; n < 128; n++) assert(await h.service.setStoppedByUser({ ...identity, key: n.toString(16).padStart(64, "0") }, true));
  assert.equal(await h.service.setStoppedByUser(identity, true), false);
  assert.deepEqual(await h.service.authorize(request), { status: "held", reason: "target-limit" });
  assert.equal(h.service.snapshot().control.targets.length, 128); await h.service.stop();
});

it("persists bounded control separately from history and refuses torn/oversized files", async () => {
  const path = join(await tempDir("arke-recovery-control-"), "control.json"), store = new FileRecoveryControlStore(path);
  const first = new RecoveryControlService({ store }); await first.open(); assert(await first.setStoppedByUser(identity, true)); await first.stop();
  assert(!JSON.stringify(await store.load()).includes("private"));
  const second = new RecoveryControlService({ store }); await second.open();
  assert(second.snapshot().control.targets[0]!.stoppedByUser); await second.stop();
  for (const raw of ["{", " ".repeat(256 * 1024 + 1)]) {
    await writeFile(path, raw); const failed = new RecoveryControlService({ store }); await failed.open();
    assert.equal(failed.snapshot().audit, "unavailable"); assert.equal(await readFile(path, "utf8"), raw); await failed.stop();
  }
});

it("keeps maximum per-target receipts and pending intents inside the existing control-file cap", async () => {
  const path = join(await tempDir("arke-recovery-receipts-"), "control.json"), store = new FileRecoveryControlStore(path), at = Number.MAX_SAFE_INTEGER - 1;
  const disk = fresh();
  disk.targets = Array.from({ length: 128 }, (_, index) => ({
    key: index.toString(16).padStart(64, "0"), service: "comfyui" as const, stoppedByUser: true, circuitOpen: true,
    lastObservedAt: at, consecutiveFailures: 3, attempts: [at - 2, at - 1, at], healthySince: null,
    intent: { id: "d".repeat(64), action: "restart-managed-runtime" as const, generation: at, componentDigest,
      authorizedAt: at, notBefore: at, automatic: true, phase: "unknown" as const },
    lastOutcome: { intentId: "d".repeat(64), action: "restart-managed-runtime" as const, generation: at, componentDigest,
      automatic: true, authorizedAt: at, settledAt: at, outcome: "unknown" as const },
  }));
  await store.save(disk); assert(Buffer.byteLength(await readFile(path, "utf8")) < 256 * 1024);
  assert.deepEqual(await store.load(), disk);
});
