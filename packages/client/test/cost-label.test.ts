import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel } from "@arke-studio/contracts";
import { costLabel } from "../src/components/character-voice-sample.js";

/**
 * The speaking-sample picker says what a route costs the same way for every row (issue 868):
 * a cloud route's price for the chosen length, a local route's "free" and the run it measured.
 * "free" against "$3.78" with nothing beside it is how a person picks the free one once.
 */
const row = (pricing: ManifestModel["pricing"]): ManifestModel =>
  ({
    id: "row",
    provider: "fal",
    capability: "video",
    displayName: "Row",
    accepts: { referenceImages: 1, startFrame: false, endFrame: false },
    limits: { resolutions: ["480p"] },
    pricing,
  }) as unknown as ManifestModel;

describe("the speaking-sample picker's cost label", () => {
  it("prices a cloud route for the length, and states a local route's reference run beside free", () => {
    assert.equal(costLabel(row({ kind: "perSecond", microUsdPerSecond: 130000 }), 6), "$0.78");
    assert.equal(costLabel(row({ kind: "unmetered", typicalRunSec: 636 }), 6), "free · ~11 min · reference");
    assert.equal(costLabel(row({ kind: "unmetered", typicalRunSec: 768 }), 5), "free · ~13 min · reference");
  });

  it("states this machine's own run once there is one, for the length chosen (issue 2401)", () => {
    const runs = { row: [{ engineSec: 240, durationSec: 5, at: "2026-11-03T12:00:00.000Z" }] };
    const measured = { choices: {}, timings: {}, runs };
    assert.equal(costLabel(row({ kind: "unmetered", typicalRunSec: 636 }), 5, measured), "free · ~4 min");
    assert.equal(costLabel(row({ kind: "unmetered", typicalRunSec: 636 }), 15, measured), "free · ~11 min · reference");
  });

  it("says minutes, not a number, where the row measured nothing", () => {
    assert.equal(costLabel(row({ kind: "unmetered" }), 6), "free · minutes, not seconds");
  });
});
