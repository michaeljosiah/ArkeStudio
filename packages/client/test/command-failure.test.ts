import assert from "node:assert/strict";
import { it } from "node:test";
import { __setStateForTest, __applyEventForTest, subscribeCommandFailures } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("delivers a handler crash to the global notification subscriber", () => {
  __setStateForTest(FIXTURE_STATE);
  const reasons: string[] = [];
  const unsubscribe = subscribeCommandFailures((event) => reasons.push(event.reason));
  try {
    __applyEventForTest({ type: "command.failed", at: "2026-09-07T12:00:00Z",
      command: "generate-look-preview", requestId: "request-test", reason: "That didn't finish." });
    assert.deepEqual(reasons, ["That didn't finish."]);
  } finally { unsubscribe(); }
});
