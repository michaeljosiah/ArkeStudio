import assert from "node:assert/strict";
import { it } from "node:test";
import { StudioAssistantCommandSchema, StudioAssistantResponseSchema, studioLocalNarrator, isRemoteHostCommand } from "../src/index.js";

const id = "01J8F3K2QW9VZX4N7M0RTYB6HC", requestId = "3c974434-e2b7-4c03-b660-5f6e5b027f06";
it("addresses one private saved reply part, without renderer text, files, providers or world bindings", () => {
  const command = { action: "read-reply", threadId: id, messageId: id, part: 0 };
  const frame = { kind: "studio-assistant", requestId, command }; assert(isRemoteHostCommand(StudioAssistantCommandSchema.parse(frame)));
  for (const patch of [{ text: "private" }, { worldId: id }, { path: "private" }, { provider: "cloud" }, { part: -1 }, { part: 128 }]) {
    assert(!StudioAssistantCommandSchema.safeParse({ ...frame, command: { ...command, ...patch } }).success);
  }
  const stop = StudioAssistantCommandSchema.parse({ ...frame, command: { action: "stop-reply-read", readRequestId: requestId } }); assert(isRemoteHostCommand(stop));
  const speech = { type: "speech", part: 0, parts: 1, source: "a".repeat(64), voiceId: "bm_george", format: "wav", audioBase64: "AQID" };
  StudioAssistantResponseSchema.parse(speech);
  for (const patch of [{ part: 1 }, { parts: 129 }, { path: "private" }, { format: "html" }, { audioBase64: "AQI" }]) assert(!StudioAssistantResponseSchema.safeParse({ ...speech, ...patch }).success);
});
it("uses the app's chosen local narrator and never adopts a world clone or silently substitutes for a selected cloud reader", () => {
  assert.equal(studioLocalNarrator(null), "bm_george");
  assert.equal(studioLocalNarrator({ provider: "kokoro", voiceId: "af_heart" }), "af_heart");
  for (const choice of [{ provider: "google", voiceId: "Puck" }, { provider: "kokoro", voiceId: "bm_george", worldId: id },
    { provider: "kokoro", voiceId: "bm_george", model: "other" }, { provider: "kokoro", voiceId: "" }]) assert.equal(studioLocalNarrator(choice), null);
});
