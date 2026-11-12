import assert from "node:assert/strict";
import { it } from "node:test";
import type { RecoveryActionCommand, RecoveryActionResult } from "@arke-studio/contracts";
import { RecoveryActionRegistry } from "../../src/recovery/actions.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";

const scope = "a".repeat(64), requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
function harness() {
  let now = 1000, valid = true, calls = 0, settled = 0;
  const results: RecoveryActionResult[] = [];
  const registry = new RecoveryActionRegistry({ now: () => now, publish: result => results.push(result), ownerSettled: () => { settled++; assert(registry.mingCleanupAvailable()); } });
  const target = { prepare: () => ({ scope, current: () => valid, run: async (signal: AbortSignal, allowed: () => boolean) => {
    assert(!signal.aborted && allowed()); calls++; return "unknown" as const;
  } }) };
  registry.registerMingCleanup(target);
  const handle = (command: RecoveryActionCommand["command"]) => registry.handle({ kind: "recovery-action", requestId, command });
  const preview = async () => { await handle({ action: "preview-ming-cleanup", scope }); const plan = results.at(-1)?.mingPlan; assert(plan); return plan; };
  return { registry, target, results, handle, preview, calls: () => calls, settled: () => settled, invalidate: () => { valid = false; }, advance: (ms: number) => { now += ms; } };
}
it("reviews the exact retained scope, requires separate one-use approval and republishes availability after executor settlement", async () => {
  const h = harness();
  try {
    await h.handle({ action: "preview-ming-cleanup", scope: "b".repeat(64) }); assert.equal(h.results.at(-1)?.status, "refused");
    const plan = await h.preview(); assert.equal(h.calls(), 0);
    await h.handle({ action: "approve-ming-cleanup", planId: plan.id }); assert.equal(h.calls(), 1); assert.equal(h.settled(), 1);
    assert.equal(h.results.at(-1)?.status, "unknown");
    await h.handle({ action: "approve-ming-cleanup", planId: plan.id }); assert.equal(h.calls(), 1); assert.equal(h.results.at(-1)?.reason, "stale");
  } finally { h.registry.closeAdmission(); }
});
it("refuses expired, clock-reversed, replaced, cancelled and revoked original-owner reviews", async () => {
  for (const change of ["expired", "clock", "replaced", "cancelled", "revoked", "closed", "policy"] as const) {
    const h = harness(), plan = await h.preview();
    if (change === "expired") h.advance(300_000); else if (change === "clock") h.advance(-1);
    else if (change === "replaced") h.registry.registerMingCleanup({ ...h.target });
    else if (change === "cancelled") await h.handle({ action: "cancel", planId: plan.id });
    else if (change === "revoked") h.invalidate(); else if (change === "closed") h.registry.closeAdmission();
    else h.registry.invalidateReviews();
    await h.handle({ action: "approve-ming-cleanup", planId: plan.id }); assert.equal(h.calls(), 0, change); h.registry.closeAdmission();
  }
});
it("shares the recovery executor, bounds reviews across action types and cancels observation without replay", async () => {
  const h = harness(); let calls = 0, entered!: () => void;
  h.registry.registerMingCleanup({ prepare: () => ({ scope, current: () => true, run: async signal => {
    calls++; entered(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }); return "unknown";
  } }) });
  try {
    const plan = await h.preview(), started = new Promise<void>(resolve => { entered = resolve; });
    const work = h.handle({ action: "approve-ming-cleanup", planId: plan.id }); await started;
    assert(!h.registry.mingCleanupAvailable());
    await h.handle({ action: "preview-cleanup" }); assert.equal(h.results.at(-1)?.reason, "busy");
    await h.handle({ action: "preview-ming-cleanup", scope }); assert.equal(h.results.at(-1)?.reason, "busy");
    await h.handle({ action: "cancel", planId: plan.id }); await work; assert.equal(calls, 1); assert(h.registry.mingCleanupAvailable());
    for (let i = 0; i < 64; i++) await h.preview();
    await h.handle({ action: "preview-ming-cleanup", scope }); assert.equal(h.results.at(-1)?.status, "refused");
  } finally { h.registry.closeAdmission(); }
});
it("captures one failed batch lease, retains every queued engine on failure, and confirms exit before releasing that lease once", async () => {
  let refuse = true, finish!: () => void, calls = 0, work = 0, admitted = false;
  const gpu = new LocalGpu(async engine => { if (engine !== "Ming") return; calls++; if (refuse) throw new Error("unconfirmed"); if (calls > 3) return; await new Promise<void>(resolve => { finish = resolve; }); }, ["Ming", "ComfyUI"]);
  let observed = 0; const unsubscribe = gpu.subscribeMingCleanup(() => { observed++; }); gpu.subscribeMingCleanup(() => { throw new Error("presentation only"); });
  try {
    await assert.rejects(gpu.runMingBatch(async () => { work++; }, new AbortController().signal), /unconfirmed/);
    assert.equal(gpu.mingCleanupState().state, "held"); const prepared = gpu.prepareMingCleanup(); assert(prepared);
    const wait = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; return release; });
    assert.equal(gpu.mingCleanupState().waiting, 1);
    assert.equal(await prepared.run(new AbortController().signal, () => false), "refused"); assert.equal(calls, 1);
    assert.equal(await prepared.run(new AbortController().signal, () => true), "unknown"); assert(!admitted); assert(prepared.current());
    refuse = false; const confirming = prepared.run(new AbortController().signal, () => true);
    const same = gpu.confirmMingCleanup(new AbortController().signal); assert.equal(gpu.mingCleanupState().state, "checking");
    assert.equal(gpu.prepareMingCleanup(), null); assert(!admitted); finish(); assert.equal(await confirming, "verified"); await same;
    // ComfyUI's normal GPU handover also checks Ming; its no-op cleanup is immediate here.
    (await wait)(); assert(admitted);
    assert(!prepared.current()); assert.equal(gpu.mingCleanupState().confirmed, prepared.revision); assert.equal(work, 1); assert(observed >= 5);
    assert.equal(await prepared.run(new AbortController().signal, () => true), "refused");
  } finally { unsubscribe(); gpu.stop(); finish?.(); }
});
