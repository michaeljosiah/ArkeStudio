import assert from "node:assert/strict";
import { it } from "node:test";
import { CACHE_CLEANUP_POLICY, ClientMessageSchema, RecoveryActionCommandSchema, RecoveryRetryPlanSchema, RecoveryCachePlanSchema, isRemoteHostCommand } from "../src/index.js";
const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV", key = "a".repeat(64);
it("requires separate host-only preview, approval and cancellation with no launch arguments", () => {
  for (const command of [{ action: "preview-retry", resourceKey: key }, { action: "approve-retry", planId: key }, { action: "cancel", planId: key }, { action: "preview-cleanup" }, { action: "approve-cleanup", planId: key }, { action: "reconcile-cleanup" }]) {
    const request = { kind: "recovery-action", requestId, command };
    assert(isRemoteHostCommand(ClientMessageSchema.parse(request)));
    assert(!RecoveryActionCommandSchema.safeParse({ ...request, command: { ...command, path: "PRIVATE_PATH" } }).success);
  }
  assert(!RecoveryActionCommandSchema.safeParse({ kind: "recovery-action", requestId, command: { action: "restart", command: "PRIVATE_SHELL" } }).success);
});
it("bounds cleanup scope and age without arbitrary targets or promises of reclaimed space", () => {
  const plan = { id: key, action: "cleanup-local-preset-previews", evidence: key, policyRevision: 1,
    preparedAt: CACHE_CLEANUP_POLICY.minAgeMs + 1000, expiresAt: CACHE_CLEANUP_POLICY.minAgeMs + 301000, category: "fixed-local-preset-previews", files: 8, logicalBytes: 800,
    targets: Array.from({ length: 8 }, (_, i) => ({ resourceKey: i.toString(16).repeat(64), createdAt: 0, logicalBytes: 100, allocatedBytes: null })),
    allocatedBytes: null, minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs, stopAtAvailableBytes: null,
    replaysJobs: false, interruptsWork: false, undoable: false };
  assert(RecoveryCachePlanSchema.safeParse(plan).success);
  for (const patch of [{ files: 9 }, { minAgeMs: 0 }, { logicalBytes: CACHE_CLEANUP_POLICY.maxBytes + 1 }, { undoable: true },
    { path: "PRIVATE_PATH" }, { category: "artifacts" }, { expiresAt: plan.expiresAt + 1 },
    { targets: plan.targets.map(row => ({ ...row, createdAt: plan.preparedAt })) }]) assert(!RecoveryCachePlanSchema.safeParse({ ...plan, ...patch }).success);
});
it("bounds the exact retry review without pretending startup uses zero disk space", () => {
  const plan = { id: key, resourceKey: key, action: "retry-managed-runtime", service: "ollama", evidence: key, policyRevision: 1,
    preparedAt: 1000, expiresAt: 301000, downloadBytes: 0, diskBytes: null, interruptsWork: false, replaysJobs: false };
  assert(RecoveryRetryPlanSchema.safeParse(plan).success);
  for (const patch of [{ expiresAt: 301001 }, { diskBytes: 0 }, { replaysJobs: true }, { command: "PRIVATE_SHELL" }]) assert(!RecoveryRetryPlanSchema.safeParse({ ...plan, ...patch }).success);
});
