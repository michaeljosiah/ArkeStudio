import assert from "node:assert/strict";
import { it } from "node:test";
import { z } from "zod";
import { ClientMessageSchema, type ClientMessage } from "../src/frames.js";
import { REMOTE_COMMAND_ACCESS, isRemoteHostCommand } from "../src/remote-command-access.js";

function kinds(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) return (schema.options as z.ZodTypeAny[]).flatMap(kinds);
  if (schema instanceof z.ZodObject) return [schema.shape.kind.value as string];
  throw new Error("Unknown command schema");
}
it("every command in the wire schema has an explicit remote ownership decision", () => {
  assert.deepEqual(Object.keys(REMOTE_COMMAND_ACCESS).sort(), [...new Set(kinds(ClientMessageSchema))].sort());
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
