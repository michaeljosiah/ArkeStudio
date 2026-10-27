import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, FrameSchema, isRemoteHostCommand, RemoteCommandRefusalSchema, StudioAssistantCommandSchema, StudioAssistantSnapshotSchema } from "../src/index.js";
const request = { kind: "studio-assistant", requestId: "12345678-1234-4234-8234-123456789abc", command: { action: "watch" } };
it("keeps every Studio operation on the owner transport and rejects arbitrary operation fields", () => {
  assert.equal(isRemoteHostCommand(ClientMessageSchema.parse(request)), true);
  assert(RemoteCommandRefusalSchema.safeParse({ kind: "command-refused", refused: "host-only", command: "studio-assistant" }).success);
  for (const command of [{ action: "repair", path: "C:/private" }, { action: "watch", worldId: "private" },
    { action: "approve-cloud", threadId: "01J8F3K2QW9VZX4N7M0RTYB6HC", runId: "01J8F3K2QW9VZX4N7M0RTYB6HC", shareId: "01J8F3K2QW9VZX4N7M0RTYB6HC", digest: "wrong" }]) {
    assert.equal(StudioAssistantCommandSchema.safeParse({ ...request, command }).success, false);
  }
  assert.equal(StudioAssistantCommandSchema.safeParse({ ...request, requestId: "not-correlated" }).success, false);
  assert.equal(FrameSchema.safeParse({ kind: "studio-assistant", seq: 1, requestId: request.requestId,
    response: { type: "result", status: "unconfirmed", reason: "timeout", threadId: null, runId: null }, rawLog: "PRIVATE" }).success, false);
});
it("bounds the aggregate private snapshot rather than multiplying individual message limits", () => {
  const thread = { id: "01J8F3K2QW9VZX4N7M0RTYB6HC", createdAt: 1, updatedAt: 1, archived: false, pending: null,
    messages: Array.from({ length: 100 }, () => ({ id: "01J8F3K2QW9VZX4N7M0RTYB6HD", role: "arke", at: 1, text: "x".repeat(16000) })) };
  const snapshot = { audit: "available", accepting: true, busy: false, threads: [thread], share: null, ephemeralReply: null };
  assert(StudioAssistantSnapshotSchema.safeParse(snapshot).success);
  assert.equal(StudioAssistantSnapshotSchema.safeParse({ ...snapshot, threads: [thread, { ...thread, id: "01J8F3K2QW9VZX4N7M0RTYB6HE" }] }).success, false);
});
