import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, RecoveryPolicySnapshotSchema, isRemoteHostCommand } from "../src/index.js";

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
