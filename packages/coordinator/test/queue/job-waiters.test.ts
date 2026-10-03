import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "@arke-studio/contracts";
import { JobWaiters } from "../../src/queue/job-waiters.js";

const job = (id: string, status: Job["status"] = "succeeded") => ({ id, status }) as Job;

describe("a job awaited to its end (SPEC-047 R-16, R-45)", () => {
  it("answers a waiter whatever the job was asked for, and holds only what it is told to", async () => {
    const waiters = new JobWaiters();
    const later = waiters.wait("a");
    waiters.settle(job("a"), false);
    assert.equal((await later).id, "a", "a waiter is answered though the job is not one held for later");

    waiters.settle(job("b"), true);
    assert.equal((await waiters.wait("b")).id, "b", "a job that ended before anyone waited is held");

    waiters.settle(job("c", "failed"), false);
    const unheld = await Promise.race([waiters.wait("c").then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 20))]);
    assert.equal(unheld, "waiting", "a job nobody was told to wait for is not kept");
  });

  it("a held job is handed over once", async () => {
    const waiters = new JobWaiters();
    waiters.settle(job("d", "cancelled"), true);
    assert.equal((await waiters.wait("d")).status, "cancelled");
    const again = await Promise.race([waiters.wait("d").then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 20))]);
    assert.equal(again, "waiting");
  });
});
