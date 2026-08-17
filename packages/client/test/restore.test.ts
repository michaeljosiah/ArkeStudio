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

  it("hands the wire the discriminant and its id, and nothing else", () => {
    /*
     * The bug this test was written the wrong way round for, and which shipped in 0.5.19.
     *
     * The stored token's source carries a content `hash`; the frame's pick schema is `.strict()`.
     * Passing the stored shape through made the coordinator reject the whole frame and drop it
     * without a word — the lane simply never filled, while the paired `reference-removed` in the
     * same restore landed fine, so the half that worked disguised the half that did not.
     *
     * The first version of this test asserted the hash WAS carried, which is exactly the shape
     * that fails. A green test is not evidence when it pins the wrong requirement.
     */
    const plan = laneRestorePlan([entry("Image 1", "ar_01JA1")], []);
    assert.deepEqual(plan.add, [{ token: "Image 1", pick: { source: "artifact", artifactId: "ar_01JA1" } }]);
    assert.equal("hash" in plan.add[0]!.pick, false, "a key the strict schema does not know sinks the frame");
  });

  it("narrows a take source the same way", () => {
    const fromTake: BenchReferenceToken = {
      token: "Image 2",
      kind: "image",
      source: { source: "take", takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HE" as never, hash: "sha256:deadbeef" as never },
    };
    const plan = laneRestorePlan([fromTake], []);
    assert.deepEqual(plan.add[0]!.pick, { source: "take", takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HE" });
  });
});
