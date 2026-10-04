import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "@arke-studio/contracts";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { enqueueInputs } from "../../src/queue/acknowledge.js";

const input = (id: string): EnqueueInput => ({
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  target: { kind: "character-look", id },
  capability: "image",
  provider: "fal",
  model: "flux",
  params: {},
  estimatedMicroUsd: 40000,
});

const job = (id: string): Job => ({ id }) as Job;

describe("queue command acknowledgement", () => {
  it("aggregates a durable multi-job success", async () => {
    let n = 0;
    const result = await enqueueInputs([input("a"), input("b")], async () =>
      job(`jb_01J8E0000000000000000000J${++n}`),
    );
    assert.equal(result.requestedCount, 2);
    assert.equal(result.acceptedJobIds.length, 2);
    assert.deepEqual(result.failures, []);
  });

  it("reports partial batches without discarding accepted jobs", async () => {
    let n = 0;
    const result = await enqueueInputs([input("a"), input("b"), input("c")], async () => {
      n += 1;
      if (n === 2) throw new Error("journal unavailable");
      return job(`jb_01J8E0000000000000000000J${n}`);
    });
    assert.equal(result.acceptedJobIds.length, 2);
    assert.deepEqual(result.failures, [
      {
        index: 1,
        reason: "journal unavailable",
      },
    ]);
  });

  it("journals nothing more once the request has ended, and counts what was put to the queue", async () => {
    let n = 0;
    let ended = false;
    const result = await enqueueInputs([input("a"), input("b"), input("c")], async () => {
      n += 1;
      ended = n === 2;
      return job(`jb_01J8E0000000000000000000J${n}`);
    }, () => ended);
    assert.equal(n, 2, "the third input was never journalled");
    assert.equal(result.requestedCount, 2);
    assert.deepEqual(result.acceptedJobIds, ["jb_01J8E0000000000000000000J1", "jb_01J8E0000000000000000000J2"]);
    assert.deepEqual(result.failures, []);
  });

  it("represents full rejection and zero-work batches honestly", async () => {
    const rejected = await enqueueInputs([input("a")], async () => {
      throw new Error("no");
    });
    assert.equal(rejected.acceptedJobIds.length, 0);
    assert.equal(rejected.failures.length, 1);
    assert.equal(rejected.failures[0]?.reason, "no");
    assert.deepEqual(await enqueueInputs([], async () => job("jb_01J8E0000000000000000000J1")), {
      requestedCount: 0,
      acceptedJobIds: [],
      failures: [],
    });
  });
});
