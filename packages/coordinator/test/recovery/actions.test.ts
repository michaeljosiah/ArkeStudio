import assert from "node:assert/strict";
import { it } from "node:test";
import type { RecoveryActionCommand, RecoveryActionResult } from "@arke-studio/contracts";
import { CACHE_CLEANUP_POLICY } from "@arke-studio/contracts";
import { RecoveryActionRegistry } from "../../src/recovery/actions.js";
const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV", key = "a".repeat(64);
function fixture() {
  let now = 1000, calls = 0, current = true; const results: RecoveryActionResult[] = [];
  const registry = new RecoveryActionRegistry({ now: () => now, publish: result => results.push(result) });
  const target = { service: "ollama" as const, prepare: () => ({ offer: { key, service: "ollama", generation: 2, componentDigest: "PRIVATE_DIGEST", policyRevision: 1, evidence: "b".repeat(64) },
    current: () => current, run: async () => { calls++; return "ready" as const; } }) };
  registry.register(key, target);
  const handle = (command: RecoveryActionCommand["command"]) => registry.handle({ kind: "recovery-action", requestId, command });
  const preview = async () => { await handle({ action: "preview-retry", resourceKey: key }); const result = results.at(-1)!; assert(result.status === "preview" && result.plan); return result.plan; };
  return { registry, target, results, handle, preview, calls: () => calls, setCurrent(value: boolean) { current = value; }, advance(ms: number) { now += ms; } };
}
it("preview starts nothing and exact one-use approval never exposes native execution identity", async () => {
  const h = fixture(); const plan = await h.preview(); assert.equal(h.calls(), 0); assert(!JSON.stringify(plan).includes("PRIVATE_"));
  await h.handle({ action: "approve-retry", planId: plan.id }); assert.equal(h.calls(), 1); assert.equal(h.results.at(-1)?.status, "verified");
  await h.handle({ action: "approve-retry", planId: plan.id }); assert.equal(h.calls(), 1); assert.equal(h.results.at(-1)?.reason, "stale"); h.registry.closeAdmission();
});
it("expiry, clock reversal, changed owners and withdrawn evidence refuse old approvals", async () => {
  for (const change of ["expiry", "clock", "owner", "evidence", "policy"] as const) {
    const h = fixture(), plan = await h.preview();
    if (change === "expiry") h.advance(300000); else if (change === "clock") h.advance(-1);
    else if (change === "owner") h.registry.register(key, { ...h.target }); else if (change === "policy") h.registry.invalidateReviews(); else h.setCurrent(false);
    await h.handle({ action: "approve-retry", planId: plan.id }); assert.equal(h.calls(), 0); assert.equal(h.results.at(-1)?.reason, "stale"); h.registry.closeAdmission();
  }
});
it("bounds volatile previews and respects cancellation/shutdown without retrying or publishing late", async () => {
  const h = fixture(); for (let n = 0; n < 64; n++) await h.preview();
  await h.handle({ action: "preview-retry", resourceKey: key }); assert.equal(h.results.at(-1)?.reason, "busy");
  h.advance(300000); const plan = await h.preview(); await h.handle({ action: "cancel", planId: plan.id });
  await h.handle({ action: "approve-retry", planId: plan.id }); assert.equal(h.calls(), 0);
  let finish!: () => void, signal: AbortSignal | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  h.registry.register(key, { service: "ollama", prepare: () => ({ ...h.target.prepare(), run: async current => { signal = current; await pending; return "unknown"; } }) });
  const held = await h.preview(), work = h.handle({ action: "approve-retry", planId: held.id });
  assert(signal); await h.handle({ action: "preview-retry", resourceKey: key }); assert.equal(h.results.at(-1)?.reason, "busy");
  const count = h.results.length; h.registry.closeAdmission(); assert(signal.aborted); finish(); await work; assert.equal(h.results.length, count);
});

it("cleanup shares the review executor, consumes one exact approval and never accepts retry approval for deletion", async () => {
  const h = fixture(); let calls = 0, finish!: () => void;
  h.advance(CACHE_CLEANUP_POLICY.minAgeMs);
  const wait = new Promise<void>(done => { finish = done; });
  h.registry.registerCleanup({ available: () => ({ available: true, pending: false }), prepare: async () => ({
    evidence: key, files: 1, logicalBytes: 4, allocatedBytes: 4096, stopAtAvailableBytes: null,
    targets: [{ resourceKey: key, createdAt: 0, logicalBytes: 4, allocatedBytes: 4096 }],
    run: async (_plan, _signal, valid) => { assert(valid()); calls++; await wait; return { status: "verified", cleanup: {
      removedFiles: 1, logicalBytes: 4, availableBefore: 100, availableAfter: 200, reclaimedBytes: null,
    } }; },
  }) });
  await h.handle({ action: "preview-cleanup" }); const plan = h.results.at(-1)?.cleanupPlan; assert(plan); assert.equal(calls, 0);
  await h.handle({ action: "approve-retry", planId: plan.id }); assert.equal(calls, 0);
  const running = h.handle({ action: "approve-cleanup", planId: plan.id }); assert.equal(calls, 1);
  await h.handle({ action: "preview-retry", resourceKey: key }); assert.equal(h.results.at(-1)?.reason, "busy");
  finish(); await running; assert.equal(h.results.at(-1)?.cleanup?.removedFiles, 1);
  await h.handle({ action: "approve-cleanup", planId: plan.id }); assert.equal(calls, 1); assert.equal(h.results.at(-1)?.reason, "stale"); h.registry.closeAdmission();
});

it("cleanup expiry, invalidation and cancellation consume reviews before any deletion", async () => {
  for (const change of ["expiry", "clock", "policy", "cancel"] as const) {
    const h = fixture(); let calls = 0;
    h.advance(CACHE_CLEANUP_POLICY.minAgeMs);
    h.registry.registerCleanup({ available: () => ({ available: true, pending: false }), prepare: async () => ({ evidence: key,
      files: 1, logicalBytes: 1, allocatedBytes: 4096, stopAtAvailableBytes: null, targets: [{ resourceKey: key, createdAt: 0, logicalBytes: 1, allocatedBytes: 4096 }], run: async () => { calls++; return {
        status: "verified", cleanup: { removedFiles: 1, logicalBytes: 1, availableBefore: null, availableAfter: null, reclaimedBytes: null },
      }; } }) });
    await h.handle({ action: "preview-cleanup" }); const plan = h.results.at(-1)?.cleanupPlan; assert(plan);
    if (change === "expiry") h.advance(300000); else if (change === "clock") h.advance(-1);
    else if (change === "policy") h.registry.invalidateReviews(); else await h.handle({ action: "cancel", planId: plan.id });
    await h.handle({ action: "approve-cleanup", planId: plan.id }); assert.equal(calls, 0); assert.equal(h.results.at(-1)?.reason, "stale"); h.registry.closeAdmission();
  }
});
