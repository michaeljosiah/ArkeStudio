import assert from "node:assert/strict";
import { it } from "node:test";
import { RECOVERY_ACTION_HISTORY_LIMITS, RECOVERY_HISTORY_LIMITS, RecoveryActionSummarySchema, RecoveryHistoryPageSchema, RecoveryHistorySchema,
  emptyRecoveryHistory, observeRecoveryIncidents, retainRecoveryActions, type RecoveryActionSummary } from "../src/index.js";

const id = (n: number) => n.toString(16).padStart(64, "0"), now = 2_000_000;
const action = (n: number, patch: Partial<RecoveryActionSummary> = {}): RecoveryActionSummary => ({ id: id(n), resourceId: id(9999),
  action: "restart-managed-runtime", service: "ollama", automatic: true, authorizedAt: 1000, outcomeAt: 2000 + n,
  outcome: "failed", evidence: "owner-receipt", ...patch });

it("retains chronological outcomes for repeated repairs and settles the same unconfirmed action without duplicating it", () => {
  const first = retainRecoveryActions([], [action(1), action(2, { outcome: "unknown" })], now);
  const next = retainRecoveryActions(first.actions, [action(2, { outcome: "verified", outcomeAt: 3000 }), action(1)], now);
  assert.equal(next.actions.length, 2); assert.equal(next.actions[0]!.id, id(2)); assert.equal(next.actions[0]!.outcome, "verified");
  assert.equal(first.actions[0]!.outcome, "unknown");
  assert.equal(retainRecoveryActions(next.actions, [action(2, { outcomeAt: 2999 })], now).actions[0]!.outcome, "verified");
  assert.equal(retainRecoveryActions(next.actions, [action(2, { resourceId: id(123), outcomeAt: 4000 })], now).actions[0]!.outcome, "verified");
});

it("prefers a flushed owner receipt to a later uncertain executor reply and refuses future or malformed observations", () => {
  const pending = action(1, { outcome: "unknown", outcomeAt: 5000, evidence: "executor-result" });
  const row = retainRecoveryActions([pending], [action(1, { outcome: "verified", outcomeAt: 4000 })], now).actions[0]!;
  assert.equal(row.outcome, "verified");
  assert.equal(retainRecoveryActions([row], [pending], now).actions[0]!.outcome, "verified");
  assert.equal(retainRecoveryActions([], [action(1, { outcomeAt: now + 1 })], now).actions.length, 0);
  for (const patch of [{ planId: id(4) }, { path: "PRIVATE_PATH" }, { action: "shell" }, { outcomeAt: 999 }]) assert(!RecoveryActionSummarySchema.safeParse({ ...action(1), ...patch }).success);
  assert.throws(() => retainRecoveryActions([], [action(1)], NaN));
});

it("clears and expires settled presentation rows without resurrecting source receipts or evicting unconfirmed outcomes", () => {
  const rows = [action(1), action(2, { outcome: "unknown" })];
  const cleared = retainRecoveryActions(rows, rows, now, now);
  assert.deepEqual(cleared.actions.map(row => row.id), [id(2)]);
  const later = retainRecoveryActions(cleared.actions, [action(2, { outcomeAt: now + 1, outcome: "verified" })], now + 1, now);
  assert.equal(later.actions[0]!.outcome, "verified");
  assert.equal(retainRecoveryActions(rows, [], now + RECOVERY_ACTION_HISTORY_LIMITS.retentionMs).actions.length, 1);
  const tied = action(3, { outcomeAt: now });
  assert.deepEqual(retainRecoveryActions([], [action(1, { outcomeAt: now }), tied], now, now, [id(1)]).actions.map(row => row.id), [id(3)]);
  const held = Array.from({ length: 1000 }, (_, i) => action(i + 1, { outcome: "unknown" }));
  const full = retainRecoveryActions(held, [action(1001)], now); assert.equal(full.actions.length, 1000); assert.equal(full.coalesced, 1);
  const mixed = [...held.slice(1), action(1001)];
  const replacement = retainRecoveryActions(mixed, [action(1002)], now);
  assert.equal(replacement.pruned, 1); assert(!replacement.actions.some(row => row.id === id(1001)));
});

it("keeps legacy history readable and the maximum incident/action history inside the shared ten-MiB file bound", () => {
  const legacy = emptyRecoveryHistory(); delete legacy.actions; assert(RecoveryHistorySchema.safeParse(legacy).success);
  const history = observeRecoveryIncidents(legacy, Array.from({ length: 1000 }, (_, i) => ({ id: id(i + 1), observation: {
    key: id(i + 1), kind: "storage-pressure" as const, evidenceRevision: id(1), observedAt: now, severity: "blocking" as const, phase: "needs-user" as const,
    evidence: "fresh" as const, facts: Array.from({ length: 24 }, () => ({ name: "available-bytes" as const, value: Number.MAX_SAFE_INTEGER, measuredAt: now })) } })), now);
  history.actions = Array.from({ length: 1000 }, (_, i) => action(i + 1));
  history.actionsClearedThrough = 100; history.actionsClearedIds = Array.from({ length: 1000 }, (_, i) => id(i + 1));
  assert(RecoveryHistorySchema.safeParse(history).success);
  assert(Buffer.byteLength(JSON.stringify(history)) < RECOVERY_HISTORY_LIMITS.maxBytes);
  assert(!RecoveryHistorySchema.safeParse({ ...history, actions: [action(1), action(1)] }).success);
});

it("validates action pagination against its own rows and rejects mixed or mismatched page contents", () => {
  const page = { status: "ready", filter: "all", view: "actions", offset: 0, pageSize: 1, at: now, audit: "available", revision: id(1), totalCount: 2,
    incidents: [], actions: [action(1)], nextCursor: { revision: id(1), offset: 1 }, previousCursor: null };
  assert(RecoveryHistoryPageSchema.safeParse(page).success);
  for (const patch of [{ actions: [] }, { actions: undefined }, { view: "incidents" }, { nextCursor: null }]) assert(!RecoveryHistoryPageSchema.safeParse({ ...page, ...patch }).success);
});
