import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueueEnqueueResult } from "../src/lib/store.js";
import { queueToastCopy } from "../src/components/queue-toaster.js";

const result = (overrides: Partial<QueueEnqueueResult> = {}): QueueEnqueueResult => ({
  at: "2026-08-04T09:00:00Z",
  type: "queue.enqueue-result",
  requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  command: "generate-main-photo",
  disposition: "accepted",
  requestedCount: 1,
  acceptedJobIds: ["jb_01J8E0000000000000000000J1"],
  failures: [],
  ...overrides,
});

describe("queue toast copy", () => {
  it("describes queueing rather than completion", () => {
    assert.deepEqual(queueToastCopy(result()), { kind: "success", title: "Added to Activity" });
    assert.deepEqual(
      queueToastCopy(
        result({
          requestedCount: 4,
          acceptedJobIds: [
            "jb_01J8E0000000000000000000J1",
            "jb_01J8E0000000000000000000J2",
            "jb_01J8E0000000000000000000J3",
            "jb_01J8E0000000000000000000J4",
          ],
        }),
      ),
      { kind: "success", title: "4 previews added to Activity" },
    );
  });

  it("states partial and rejected work accurately", () => {
    const partial = queueToastCopy(
      result({
        disposition: "partial",
        requestedCount: 4,
        acceptedJobIds: ["jb_01J8E0000000000000000000J1", "jb_01J8E0000000000000000000J2"],
        failures: [{ index: 2, reason: "Check provider settings." }],
      }),
    );
    assert.equal(partial.title, "2 of 4 previews added to Activity");
    assert.equal(partial.description, "Check provider settings.");
    assert.equal(
      queueToastCopy(result({ disposition: "rejected", acceptedJobIds: [], failures: [] })).kind,
      "error",
    );
  });

  it("does not toast local or cached work", () => {
    assert.equal(
      queueToastCopy(result({ disposition: "not-queued", requestedCount: 0, acceptedJobIds: [] })).kind,
      "none",
    );
  });

  it("names scene batches as shots", () => {
    assert.equal(
      queueToastCopy(
        result({
          command: "dispatch-scene",
          requestedCount: 2,
          acceptedJobIds: ["jb_01J8E0000000000000000000J1", "jb_01J8E0000000000000000000J2"],
        }),
      ).title,
      "2 shots added to Activity",
    );
  });
});
