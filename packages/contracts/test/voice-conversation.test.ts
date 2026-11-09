import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { VoiceConversationCommandSchema, speakableConversationText, REMOTE_COMMAND_ACCESS } from "../src/index.js";

test("opening a live sending mode requires explicit consent and bounded turn-end settings", () => {
  const command = { kind: "voice-conversation", session: randomUUID(), command: { action: "open", worldId: "sample", conversationId: "cv_01J00000000000000000000000", silenceMs: 650, cloudConsent: true } };
  assert.equal(VoiceConversationCommandSchema.safeParse(command).success, true);
  for (const patch of [{ cloudConsent: false }, { cloudConsent: undefined }, { silenceMs: 100 }, { silenceMs: 3000 }]) {
    assert.equal(VoiceConversationCommandSchema.safeParse({ ...command, command: { ...command.command, ...patch } }).success, false);
  }
  assert.equal(REMOTE_COMMAND_ACCESS["voice-conversation"], "host");
  assert.equal(speakableConversationText("I hear you. Tell me more."), true);
  for (const text of ['{"reply":"Hello"}', "```json", "[a proposal]", "<action>", "x".repeat(8001)]) assert.equal(speakableConversationText(text), false);
});
