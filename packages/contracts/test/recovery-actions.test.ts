import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, RecoveryActionCommandSchema, RecoveryRetryPlanSchema, isRemoteHostCommand } from "../src/index.js";
const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV", key = "a".repeat(64);
it("requires separate host-only preview, approval and cancellation with no launch arguments", () => {
  for (const command of [{ action: "preview-retry", resourceKey: key }, { action: "approve-retry", planId: key }, { action: "cancel", planId: key }]) {
    const request = { kind: "recovery-action", requestId, command };
    assert(isRemoteHostCommand(ClientMessageSchema.parse(request)));
    assert(!RecoveryActionCommandSchema.safeParse({ ...request, command: { ...command, path: "PRIVATE_PATH" } }).success);
  }
  assert(!RecoveryActionCommandSchema.safeParse({ kind: "recovery-action", requestId, command: { action: "restart", command: "PRIVATE_SHELL" } }).success);
});
it("bounds the exact retry review without pretending startup uses zero disk space", () => {
  const plan = { id: key, resourceKey: key, action: "retry-managed-runtime", service: "ollama", evidence: key, policyRevision: 1,
    preparedAt: 1000, expiresAt: 301000, downloadBytes: 0, diskBytes: null, interruptsWork: false, replaysJobs: false };
  assert(RecoveryRetryPlanSchema.safeParse(plan).success);
  for (const patch of [{ expiresAt: 301001 }, { diskBytes: 0 }, { replaysJobs: true }, { command: "PRIVATE_SHELL" }]) assert(!RecoveryRetryPlanSchema.safeParse({ ...plan, ...patch }).success);
});
