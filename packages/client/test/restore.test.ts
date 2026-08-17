import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BenchReferenceToken } from "@arke-studio/contracts";
import { laneRestorePlan } from "../src/lib/restore.js";

/**
 * ⟲ restore brings back a take's pictures, not only its words (2026-08-17).
 *
 * It used to restore the brief, the model and the settings and leave the lanes alone — so
 * restoring a take built from a start frame gave you its prompt over whatever happened to be
 * staged, a request that could not be re-made. The snapshot carried the images the whole time.
 */
const entry = (token: string, artifactId: string): BenchReferenceToken => ({
  token,
  kind: "image",
  source: { source: "artifact", artifactId: artifactId as never, hash: "sha256:deadbeef" as never },
});

describe("restoring a take's pictures", () => {
  it("sets the lane to exactly what the snapshot names", () => {
    const plan = laneRestorePlan([entry("Image 1", "ar_01JA1"), entry("Image 3", "ar_01JA3")], ["Image 2"]);
    assert.deepEqual(plan.remove, ["Image 2"], "what the take did not use goes");
    assert.deepEqual(plan.add.map((e) => e.token), ["Image 1", "Image 3"], "what it did use comes back");
  });

  it("leaves a picture the take already had exactly where it is", () => {
    // A difference, not a clear-then-add: re-adding an unchanged image would churn the session
    // log and flicker the lane for something that never moved.
    const plan = laneRestorePlan([entry("Image 1", "ar_01JA1")], ["Image 1"]);
    assert.deepEqual(plan, { remove: [], add: [] });
  });

  it("empties a lane for a take that used none", () => {
    const plan = laneRestorePlan([], ["Image 1", "Image 2"]);
    assert.deepEqual(plan.remove, ["Image 1", "Image 2"]);
    assert.deepEqual(plan.add, []);
  });

  it("carries the source, so a known one restores its old token rather than claiming a new name", () => {
    // The brief says "Image 1"; if restoring re-added it as Image 4 the words would stop
    // matching the pictures.
    const plan = laneRestorePlan([entry("Image 1", "ar_01JA1")], []);
    assert.deepEqual(plan.add[0]!.source, {
      source: "artifact",
      artifactId: "ar_01JA1",
      hash: "sha256:deadbeef",
    });
  });
});
