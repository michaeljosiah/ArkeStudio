import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, RecoveryPolicySnapshotSchema, RecoveryHistoryQuerySchema, RecoveryHistoryPageSchema, isRemoteHostCommand } from "../src/index.js";

const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
it("keeps recovery policy/presentation changes host-only with closed arguments", () => {
  const commands = [
    { kind: "recovery-set-mode", requestId, mode: "suggest-only" },
    { kind: "recovery-set-preferences", requestId, preferences: { desktopOptIn: true } },
    { kind: "recovery-history-control", requestId, command: { action: "snooze-hour", incidentId: "a".repeat(64) } },
  ];
  for (const command of commands) {
    assert(isRemoteHostCommand(ClientMessageSchema.parse(command)));
    assert(!ClientMessageSchema.safeParse({ ...command, shell: "arbitrary-command" }).success);
  }
  assert(!ClientMessageSchema.safeParse({ ...commands[0], mode: "unlimited" }).success);
  assert(!ClientMessageSchema.safeParse({ ...commands[1], preferences: { autoDelete: true } }).success);
  assert(!ClientMessageSchema.safeParse({ ...commands[2], command: { action: "restart", incidentId: "a".repeat(64) } }).success);
  assert(!ClientMessageSchema.safeParse({ ...commands[2], command: { action: "acknowledge", incidentId: "C:/private/path" } }).success);
});
it("policy projection cannot carry an executing intent capability", () => {
  const policy = { audit: "available", accepting: true, mode: "automatic", targets: [] };
  assert(RecoveryPolicySnapshotSchema.safeParse(policy).success);
  assert(!RecoveryPolicySnapshotSchema.safeParse({ ...policy, intent: { id: "a".repeat(64) } }).success);
});

it("allows bounded operational history reads without granting a host mutation or arbitrary path", () => {
  const query = { filter: "all", pageSize: 50 }, command = { kind: "recovery-history-read", requestId, query };
  assert(!isRemoteHostCommand(ClientMessageSchema.parse(command)));
  for (const patch of [{ pageSize: 0 }, { pageSize: 101 }, { filter: "private-logs" }, { cursor: { revision: "bad", offset: 0 } }, { cursor: { revision: "a".repeat(64), offset: 1001 } }, { path: "C:/private" }]) {
    assert(!RecoveryHistoryQuerySchema.safeParse({ ...query, ...patch }).success);
  }
});

it("rejects contradictory page counts and cursors instead of admitting a silently incomplete traversal", () => {
  const page = { status: "ready", audit: "available", at: 100, filter: "all", pageSize: 50, offset: 0, revision: "a".repeat(64), totalCount: 0, incidents: [], nextCursor: null, previousCursor: null };
  assert(RecoveryHistoryPageSchema.safeParse(page).success);
  for (const patch of [{ revision: null }, { totalCount: 51 }, { nextCursor: { revision: "a".repeat(64), offset: 50 } }, { offset: 1 }, { status: "stale", previousCursor: { revision: "a".repeat(64), offset: 0 } }, { status: "unavailable" }]) {
    assert(!RecoveryHistoryPageSchema.safeParse({ ...page, ...patch }).success);
  }
});
