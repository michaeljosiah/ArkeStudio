import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DomainEvent, Frame } from "@arke-studio/contracts";
import {
  __handleFrameForTest,
  __pendingQueueRequestsForTest,
  __setStateForTest,
  generateWorldImage,
  subscribeCommandFailures,
  subscribeRemoteRefusals,
} from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A command the coordinator could not read is answered now (issue 2778), and the answer has to
 * reach the screen that sent it: dropped in silence, its control stayed disabled for good.
 */
describe("a command the coordinator could not read", () => {
  it("lets the waiting request go and tells the screens that listen for a failure", () => {
    __setStateForTest(FIXTURE_STATE);
    generateWorldImage(FIXTURE_STATE.world!.meta.worldId);
    const [requestId] = __pendingQueueRequestsForTest();
    assert.ok(requestId);
    const failures: Extract<DomainEvent, { type: "command.failed" }>[] = [];
    let hostOnly = 0;
    const offFailures = subscribeCommandFailures((failure) => failures.push(failure));
    const offRemote = subscribeRemoteRefusals(() => { hostOnly += 1; });
    try {
      // A refusal is not a sequenced frame; the store reads it before the frame parser.
      __handleFrameForTest({ kind: "command-refused", refused: "invalid", command: "generate-world-image", requestId } as unknown as Frame);
    } finally {
      offFailures();
      offRemote();
    }
    assert.deepEqual(__pendingQueueRequestsForTest(), [], "the request is no longer waited on");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.requestId, requestId, "correlated to the request that sent it");
    assert.equal(failures[0]!.command, "generate-world-image");
    assert.match(failures[0]!.reason, /could not read that request/);
    assert.equal(hostOnly, 0, "and it is not mistaken for an action only the PC can take");
  });
});
