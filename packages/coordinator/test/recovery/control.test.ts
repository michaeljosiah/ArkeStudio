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
