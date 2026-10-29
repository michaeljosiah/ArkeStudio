import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Frame } from "@arke-studio/contracts";
import { __handleFrameForTest, __setStateForTest, __stateForTest, onStudioAssistantReply } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("delivers private replies to panel subscribers without changing shared app/world state", () => {
  __setStateForTest(structuredClone(FIXTURE_STATE)); const before = __stateForTest();
  const seen: Frame[] = [], stopBroken = onStudioAssistantReply(() => { throw new Error("private presentation failed"); });
  const stop = onStudioAssistantReply(frame => seen.push(frame));
  const frame: Frame = { kind: "studio-assistant", seq: 42, requestId: randomUUID(), response: { type: "state", state: {
    audit: "available", accepting: true, busy: false, share: null, ephemeralReply: null,
    threads: [{ id: "01J8F3K2QW9VZX4N7M0RTYB6HC", createdAt: 1, updatedAt: 1, archived: false, pending: null,
      messages: [{ id: "01J8F3K2QW9VZX4N7M0RTYB6HD", role: "user", at: 1, text: "PRIVATE_STUDIO_TRANSCRIPT" }] }],
  } } };
  try {
    __handleFrameForTest(frame); assert.deepEqual(seen, [frame]); assert.equal(__stateForTest(), before);
    assert(!JSON.stringify(__stateForTest()).includes("PRIVATE_STUDIO"));
    stop(); __handleFrameForTest({ ...frame, seq: 43 }); assert.equal(seen.length, 1);
  } finally { stop(); stopBroken(); }
});
