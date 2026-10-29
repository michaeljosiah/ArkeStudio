import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, FindingSchema, MingCleanupSnapshotSchema, RecoveryMingCleanupPlanSchema,
  isRemoteHostCommand, mingCleanupFindings, type MingCleanupSnapshot } from "../src/index.js";

const at = 2_000_000, scope = "a".repeat(64);
const source: MingCleanupSnapshot = { state: "held", scope, authority: "original-worker", available: true, waiting: 2, measuredAt: at, confirmation: null };
it("derives a retained-worker finding without guessing Python health or inference quality", () => {
  const [finding] = mingCleanupFindings(source, new Date(at).toISOString()); assert(finding);
  FindingSchema.parse({ ...finding, firstSeen: new Date(at).toISOString() });
  assert.equal(finding.occurrence, scope); assert.equal(finding.severity, "degraded");
  assert.deepEqual(finding.remedy, { control: "ming-cleanup-review", target: scope });
  assert.equal(finding.facts.find(row => row.name === "waiting")?.value, 2);
  for (const patch of [{ state: "checking" as const, available: false }, { available: false }, { available: false, authority: "unavailable" as const }]) {
    assert.equal(mingCleanupFindings({ ...source, ...patch }, new Date(at).toISOString())[0]!.remedy, null);
  }
  for (const measuredAt of [at - 60_001, at + 1]) {
    const stale = mingCleanupFindings({ ...source, measuredAt }, new Date(at).toISOString())[0]!;
    assert.equal(stale.severity, "unknown"); assert(stale.facts.every(row => row.value === null));
    assert.deepEqual(stale.remedy, { control: "ming-cleanup-refresh" });
  }
  assert.deepEqual(mingCleanupFindings(undefined, new Date(at).toISOString()), []);
  for (const state of ["unavailable", "idle", "working"] as const) assert.deepEqual(mingCleanupFindings({ ...source, state, scope: null, available: false }, new Date(at).toISOString()), []);
});
it("requires a closed, one-worker plan and host-only commands, with no executable fields", () => {
  const plan = { id: scope, scope, action: "confirm-ming-cleanup", preparedAt: at, expiresAt: at + 300_000,
    authority: "retained-original-worker", startsInference: false, replaysJobs: false, releasesGpuOnlyAfterConfirmedExit: true };
  RecoveryMingCleanupPlanSchema.parse(plan); MingCleanupSnapshotSchema.parse(source);
  for (const patch of [{ pid: 5 }, { path: "private" }, { startsInference: true }, { replaysJobs: true }, { authority: "new-worker" }, { expiresAt: at + 300_001 }]) {
    assert(!RecoveryMingCleanupPlanSchema.safeParse({ ...plan, ...patch }).success);
  }
  for (const patch of [{ state: "idle" }, { scope: null }, { authority: "unavailable" }, { token: "private" },
    { confirmation: { scope, at } }]) assert(!MingCleanupSnapshotSchema.safeParse({ ...source, ...patch }).success);
  for (const command of [{ action: "preview-ming-cleanup", scope }, { action: "approve-ming-cleanup", planId: scope }]) {
    const message = ClientMessageSchema.parse({ kind: "recovery-action", requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", command });
    assert(isRemoteHostCommand(message));
    assert(!ClientMessageSchema.safeParse({ ...message, command: { ...command, pid: 5 } }).success);
  }
});
