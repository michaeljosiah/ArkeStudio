import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyRecoveryHistory, emptyRecoveryTarget, RecoveryHistoryPageSchema, retainRecoveryActions, type RecoveryHistory, type RecoveryControl } from "@arke-studio/contracts";
import { RecoveryHistoryService } from "../../src/recovery/history.js";
import { restartActionHistory, cleanupActionHistory, reviewedActionHistory, partialCleanupHistory } from "../../src/recovery/action-history.js";

const key = "a".repeat(64), intent = "b".repeat(64), component = "c".repeat(64), now = 2_000_000;

it("records a reviewed Ming cleanup outcome without executable scope or a narration-success claim", () => {
  const mingPlan = { id: intent, scope: component, action: "confirm-ming-cleanup" as const, preparedAt: now, expiresAt: now + 300_000,
    authority: "retained-original-worker" as const, startsInference: false as const, replaysJobs: false as const, releasesGpuOnlyAfterConfirmedExit: true as const };
  for (const status of ["preview", "accepted"] as const) assert.deepEqual(reviewedActionHistory({ requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status, mingPlan }, now), []);
  const [row] = reviewedActionHistory({ requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "unknown", mingPlan }, now);
  assert(row); assert.equal(row.action, "confirm-ming-cleanup"); assert.equal(row.outcome, "unknown"); assert.equal(row.evidence, "executor-result");
  assert.equal(row.authorizedAt, null); assert.equal(row.cleanup, undefined);
  assert(!JSON.stringify(row).includes(intent)); assert(!JSON.stringify(row).includes(component));
});
function control(id = intent, outcome: "verified" | "unknown" = "verified"): RecoveryControl {
  return { version: 1, policyRevision: 1, mode: "automatic", targets: [{ ...emptyRecoveryTarget(key, "ollama", now), lastOutcome: {
    intentId: id, action: "restart-managed-runtime", generation: 27, componentDigest: component, automatic: true,
    authorizedAt: now - 1000, settledAt: now, outcome } }] };
}

it("projects closed restart/cache/check evidence with presentation IDs that cannot expose executable target fields", () => {
  const [row] = restartActionHistory(control()); assert(row); assert.equal(row.resourceId, key); assert.notEqual(row.id, intent);
  const serialized = JSON.stringify(row); for (const excluded of [intent, component, "generation", "intentId"]) assert(!serialized.includes(excluded));
  const cleanup = cleanupActionHistory(intent, true, { at: now, status: "cancelled", cleanup: { removedFiles: 1, logicalBytes: 60,
    availableBefore: 4000, availableAfter: 5000, reclaimedBytes: null } });
  assert.equal(cleanup.outcome, "cancelled"); assert.equal(cleanup.authorizedAt, null); assert.equal(cleanup.cleanup?.removedFiles, 1);
  assert(!JSON.stringify(cleanup).includes(intent));
  assert.deepEqual(reviewedActionHistory({ requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "preview" }, now), []);
  const checked = reviewedActionHistory({ requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "verified", reconciliation: { outcome: "retained", availableBytes: null } }, now);
  assert.equal(checked[0]!.action, "check-preview-cleanup"); assert.equal(checked[0]!.outcome, "verified");
  const partial = partialCleanupHistory({ planId: intent, key: "e".repeat(64), at: now }, [{ planId: intent, key, at: now - 1, status: "removed" }]);
  assert.equal(partial[0]!.outcome, "unknown"); assert.equal(partial[0]!.cleanup?.removedFiles, 1); assert.equal(partial[0]!.cleanup?.logicalBytes, null);
  const finished = cleanupActionHistory(intent, false, { at: now, status: "verified", cleanup: { removedFiles: 2, logicalBytes: 120,
    availableBefore: null, availableAfter: null, reclaimedBytes: null } });
  assert.equal(retainRecoveryActions([finished], partial, now).actions[0]!.outcome, "verified");
  assert(!JSON.stringify(partial).includes(intent)); assert(!JSON.stringify(partial).includes(key));
});

it("persists repeated actions, pages by a fixed revision and keeps clear independent of source authority across restart", async () => {
  let disk = emptyRecoveryHistory(), at = now;
  const store = { load: async () => structuredClone(disk), save: async (value: RecoveryHistory) => { disk = structuredClone(value); } };
  const service = new RecoveryHistoryService({ store, now: () => at, saveDelayMs: 10000 }); await service.open();
  try {
    const original = control(), unknown = control("d".repeat(64), "unknown");
    service.observeActions(restartActionHistory(original)); service.observeActions(restartActionHistory(unknown));
    assert.equal(service.snapshot().actionCount, 2); assert.equal(service.snapshot().unconfirmedActionCount, 1);
    const page = RecoveryHistoryPageSchema.parse(service.page({ view: "actions", filter: "all", pageSize: 1 }));
    assert.equal(page.actions?.length, 1); assert(page.nextCursor); assert.equal(page.incidents.length, 0);
    assert.equal(service.page({ view: "actions", filter: "active", pageSize: 1, cursor: page.nextCursor }).status, "stale");
    assert.equal(service.page({ view: "actions", filter: "active", pageSize: 1 }).totalCount, 1);
    assert(await service.clearResolved()); service.observeActions(restartActionHistory(original));
    assert.equal(service.snapshot().actionCount, 1); assert.equal(original.targets[0]!.lastOutcome!.intentId, intent);
    await service.flush(); await service.stop();
    const next = new RecoveryHistoryService({ store, now: () => at, saveDelayMs: 10000 }); await next.open();
    try {
      next.observeActions(restartActionHistory(original), true); assert.equal(next.snapshot().actionCount, 1);
      at++; unknown.targets[0]!.lastOutcome!.settledAt = at; unknown.targets[0]!.lastOutcome!.outcome = "verified";
      next.observeActions(restartActionHistory(unknown)); assert.equal(next.snapshot().settledActionCount, 1);
      assert.equal(next.snapshot().unconfirmedActionCount, 0); assert.equal(next.snapshot().actionCount, 1);
    } finally { await next.stop(); }
  } finally { await service.stop(); }
});

it("labels reconstructed source windows as incomplete and bounds memory after a failed history flush without retry authority", async () => {
  const service = new RecoveryHistoryService({ store: { load: async () => emptyRecoveryHistory(), save: async () => { throw Object.assign(new Error("PRIVATE_FS"), { code: "ENOSPC" }); } }, now: () => now, saveDelayMs: 10000 });
  await service.open(); service.observeActions(restartActionHistory(control()), true);
  assert(service.snapshot().overflow.lostDetail); await service.flush(); assert.equal(service.snapshot().reason, "disk-full");
  service.observeActions(restartActionHistory(control("d".repeat(64), "unknown")));
  assert.equal(service.snapshot().actionCount, 2); assert(!JSON.stringify(service.snapshot()).includes("PRIVATE_FS"));
  service.closeAdmission(); service.observeActions(restartActionHistory(control("e".repeat(64)))); assert.equal(service.snapshot().actionCount, 2);
  await service.stop();
});

it("does not confuse a new same-clock action with cleared receipts and marks legacy action coverage incomplete", async () => {
  const legacy = emptyRecoveryHistory(); delete legacy.actions; let disk = legacy;
  const service = new RecoveryHistoryService({ store: { load: async () => structuredClone(disk), save: async value => { disk = structuredClone(value); } },
    now: () => now, saveDelayMs: 10000 });
  await service.open();
  try {
    assert(service.snapshot().overflow.lostDetail);
    const first = restartActionHistory(control()), second = restartActionHistory(control("e".repeat(64)));
    service.observeActions(first); assert(await service.clearResolved());
    service.observeActions([...first, ...second]); assert.equal(service.snapshot().actionCount, 1); assert.equal(service.snapshot().actions![0]!.id, second[0]!.id);
    assert(await service.clearResolved()); service.observeActions([...first, ...second]); assert.equal(service.snapshot().actionCount, 0);
  } finally { await service.stop(); }
});
