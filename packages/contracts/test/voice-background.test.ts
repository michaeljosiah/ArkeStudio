import assert from "node:assert/strict";
import { test } from "node:test";
import { newId, voiceBackgroundTransition, type VoiceBackgroundOperation } from "../src/index.js";

const requested = (): VoiceBackgroundOperation => ({ id: newId("vop"), worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", conversationId: newId("cv"),
  initiatingRunId: newId("run"), turnId: newId("turn"), model: "cloud/selected", request: "Read canon", status: "requested",
  createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" });

test("background outcomes cannot replace captured intent or replay terminal delivery", () => {
  const intent = requested(), running = { ...intent, status: "running" as const };
  const complete = { ...running, status: "completed" as const, result: "Grounded answer" };
  assert(voiceBackgroundTransition(undefined, intent)); assert(voiceBackgroundTransition(intent, running));
  assert(voiceBackgroundTransition(running, complete));
  for (const mutation of [{ model: "cloud/other" }, { worldId: "other" }, { request: "Different" }, { variant: "other" }])
    assert(!voiceBackgroundTransition(running, { ...complete, ...mutation }));
  assert(!voiceBackgroundTransition(complete, complete));
  const spoken = { ...complete, speechAttempted: true };
  assert(voiceBackgroundTransition(complete, spoken)); assert(!voiceBackgroundTransition(spoken, spoken));
  assert(!voiceBackgroundTransition(complete, { ...spoken, result: "Late replacement" }));
  assert(!voiceBackgroundTransition({ ...running, status: "cancel-requested" }, complete));
  assert(!voiceBackgroundTransition(running, { ...complete, result: undefined }));
});
