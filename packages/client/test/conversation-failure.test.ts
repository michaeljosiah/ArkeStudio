import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureLine } from "../src/components/conversation.js";

/**
 * What a person is told when a turn produces nothing (design turn 89's transcript; found by
 * driving on 2026-08-21). A refused answer and a failed request are different events with
 * different remedies, and saying "that did not go through" for both sends somebody to press
 * retry against a refusal that will repeat.
 */

describe("a turn that produced nothing says which kind of nothing", () => {
  it("a transport failure says nothing was lost, and invites a retry", () => {
    const line = failureLine({ status: "failed" });
    assert.match(line, /did not go through/);
    assert.match(line, /Nothing was lost/);
  });

  it("a timeout and a budget stop name themselves", () => {
    assert.match(failureLine({ status: "timeout" }), /took too long/);
    assert.match(failureLine({ status: "budget-exceeded" }), /past its budget/);
  });

  it("a refused answer says what was refused, and does not promise a retry will help", () => {
    const line = failureLine({
      status: "failed",
      detail: "rejected: A quotation was not found in the entity it cites.",
    });
    assert.match(line, /answered and the answer was refused/);
    assert.match(line, /A quotation was not found in the entity it cites\./, "the gate's own words");
    assert.doesNotMatch(line, /Nothing was lost/, "that is the other event");
    assert.match(line, /asking a different way/, "the remedy that actually works");
  });

  it("a detail that is not a refusal does not masquerade as one", () => {
    const line = failureLine({ status: "failed", detail: "socket closed" });
    assert.match(line, /did not go through/);
  });
});
