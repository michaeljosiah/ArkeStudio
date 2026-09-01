import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import {
  __applyEventForTest,
  __pendingQueueRequestsForTest,
  __setBridgeForTest,
  __setStateForTest,
  importShotFrame,
  subscribeQueueResults,
} from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";

function bridge(messages: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json) => messages.push(JSON.parse(json) as ClientMessage),
  };
}

afterEach(() => __setBridgeForTest(null));

describe("importShotFrame sender", () => {
  it("sends only shot identity and consumes the generic correlated result", () => {
    __setStateForTest(FIXTURE_STATE);
    const messages: ClientMessage[] = [];
    __setBridgeForTest(bridge(messages));

    importShotFrame(WORLD, "saltlight", "sh_12");

    const message = messages[0];
    assert.ok(message?.kind === "import-shot-frame");
    assert.equal(message.worldId, WORLD);
    assert.equal(message.productionId, "saltlight");
    assert.equal(message.shotId, "sh_12");
    assert.match(message.requestId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(Object.keys(message).sort(), ["kind", "productionId", "requestId", "shotId", "worldId"]);
    assert.deepEqual(__pendingQueueRequestsForTest(), [message.requestId]);

    const seen: string[] = [];
    const unsubscribe = subscribeQueueResults((result) => seen.push(result.requestId));
    __applyEventForTest({
      at: "2026-08-31T12:00:00.000Z",
      type: "queue.enqueue-result",
      requestId: message.requestId,
      command: "import-shot-frame",
      disposition: "not-queued",
      requestedCount: 0,
      acceptedJobIds: [],
      failures: [],
    });
    unsubscribe();

    assert.deepEqual(seen, [message.requestId]);
    assert.deepEqual(__pendingQueueRequestsForTest(), []);
  });
});
