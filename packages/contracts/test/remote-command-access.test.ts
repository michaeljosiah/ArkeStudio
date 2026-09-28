import assert from "node:assert/strict";
import { it } from "node:test";
import { z } from "zod";
import { ClientMessageSchema, type ClientMessage } from "../src/frames.js";
import { REMOTE_COMMAND_ACCESS, REMOTE_PREPARED_ACTION_ACCESS, isRemoteHostCommand, isRemoteHostConversationAction } from "../src/remote-command-access.js";
import { WorldChatPreparedActionSchema } from "../src/world-chat-actions.js";

function kinds(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) return (schema.options as z.ZodTypeAny[]).flatMap(kinds);
  if (schema instanceof z.ZodObject) return [schema.shape.kind.value as string];
  throw new Error("Unknown command schema");
}
it("every command in the wire schema has an explicit remote ownership decision", () => {
  assert.deepEqual(Object.keys(REMOTE_COMMAND_ACCESS).sort(), [...new Set(kinds(ClientMessageSchema))].sort());
});
it("every prepared action has an explicit policy and native work cannot hide in a decision", () => {
  assert.deepEqual(Object.keys(REMOTE_PREPARED_ACTION_ACCESS).sort(), kinds(WorldChatPreparedActionSchema).sort());
  for (const kind of ["world-chat-artifact-import", "world-chat-reference-import", "world-chat-reference-image-import", "world-chat-voice-clone", "world-chat-production-take-import", "world-chat-production-stage-playblast", "upload-world-image"]) {
    assert.equal(isRemoteHostConversationAction(kind), true, kind);
  }
  for (const kind of ["rename-world", "world-chat-canon", "world-chat-production-stage-construct", "world-chat-world-export"]) assert.equal(isRemoteHostConversationAction(kind), false, kind);
  assert.equal(isRemoteHostConversationAction("future-unclassified-action"), true);
});
it("host installers, deletion, native folders and chooser payloads stay on the PC", () => {
  const cases: ClientMessage[] = [
    { kind: "setup-remove", componentId: "kokoro-82m" }, { kind: "setup-install", componentId: "kokoro-82m" },
    { kind: "setup-repair", componentId: "kokoro-82m" }, { kind: "comfyui-update-runtime" },
    { kind: "repair-voice-models" }, { kind: "open-model-folder" }, { kind: "open-engine-log", engine: "voxa" },
    { kind: "download-update" }, { kind: "adapter-command", command: { action: "install", releaseIds: ["sample"] } },
    { kind: "adapter-command", command: { action: "remove", releaseId: "sample", deleteOwnedFile: true } },
    { kind: "stage-voice-clip", worldId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: "clip", source: { from: "chosen" } },
    { kind: "pick-staged-reference", worldId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", key: "world-image" },
  ];
  for (const command of cases) assert.equal(isRemoteHostCommand(ClientMessageSchema.parse(command)), true, command.kind);
});
it("world content, browser recordings, existing references and Content & safety remain allowed", () => {
  const cases: ClientMessage[] = [
    { kind: "set-model-enabled", modelId: "kokoro-82m", enabled: true },
    { kind: "refresh-diagnostics" }, { kind: "adapter-command", command: { action: "disable-content" } },
    { kind: "adapter-command", command: { action: "enable", acknowledgement: { adultAge: true, explicitChoice: true, rightsAndConsent: true } } },
    { kind: "adapter-command", command: { action: "remove", releaseId: "sample", deleteOwnedFile: false } },
    { kind: "stage-voice-clip", worldId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: "clip", source: { from: "recorded", audioBase64: "UklGRg==", contentType: "audio/wav" } },
    { kind: "pick-staged-reference", worldId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", key: "world-image", worldFile: "world.png" },
  ];
  for (const command of cases) assert.equal(isRemoteHostCommand(ClientMessageSchema.parse(command)), false, command.kind);
});
