import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueueEnqueueResult } from "../src/lib/store.js";
import { jobReadyToastCopy, queueToastCopy } from "../src/components/queue-toaster.js";
import type { Job } from "@arke-studio/contracts";

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
  it("mounts one top-center toaster clear of the desktop title bar", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(resolve(here, "../src/App.tsx"), "utf8");
    const toaster = readFileSync(resolve(here, "../src/components/queue-toaster.tsx"), "utf8");
    assert.equal(app.match(/<QueueToaster\s*\/>/g)?.length, 1);
    assert.match(toaster, /position="top-center"/);
    assert.match(toaster, /44px/);
  });

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

  it("clearly names queued and completed character sheets", () => {
    assert.deepEqual(
      queueToastCopy(
        result({ command: "generate-character-sheet", characterName: "Maren Kest" }),
      ),
      { kind: "success", title: "Character sheet for Maren Kest is queued for generation" },
    );
    const ready = {
      id: "jb_01J8E0000000000000000000J1",
      idempotencyKey: "01J8E1000000000000000000K9",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      target: { kind: "character-sheet", id: "maren-kest/g1" },
      capability: "image",
      provider: "fal",
      model: "flux",
      params: { characterName: "Maren Kest" },
      estimatedMicroUsd: 40000,
      status: "succeeded",
      providerJobId: "remote-1",
      attempt: 1,
      error: null,
      createdAt: "2026-08-04T09:00:00Z",
      updatedAt: "2026-08-04T09:01:00Z",
    } satisfies Job;
    assert.deepEqual(jobReadyToastCopy(ready), {
      kind: "success",
      title: "Character sheet for Maren Kest is ready",
    });
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
