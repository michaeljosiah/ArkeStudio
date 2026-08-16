import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel } from "@arke-studio/contracts";
import { durationTrack, durationPillLabel } from "../src/lib/duration.js";

/**
 * The length track (asked for 2026-08-16). Its panel is a popover, so none of this is in the
 * document while it is shut — the maths is tested here directly, and the screen test checks the
 * one thing that stays visible: the pill.
 */

const BASE: ManifestModel = {
  id: "test-video",
  provider: "fal",
  capability: "video",
  displayName: "Test Video",
  accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 8, durations: { 4: "4", 6: "6", 8: "8" }, durationAuto: true },
  pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
};
/** The same row whose reference route runs shorter, as wan's does. */
const SHORTER: ManifestModel = { ...BASE, limits: { ...BASE.limits, maxReferenceDurationSec: 6 } };

const free = (chosen?: number) => durationTrack(BASE, chosen, { withReferences: false });

describe("the length track's geometry", () => {
  it("runs from one position below the shortest stop, so the shortest stop can be reached", () => {
    // A range input fires no change when a click lands on the value it already holds. Parked on
    // the first stop, the shortest length — the cheapest one — could not be chosen at all.
    const unset = free();
    assert.equal(unset.min, -1);
    assert.equal(unset.value, -1);
    assert.equal(unset.unset, true);
    assert.equal(unset.fill, 0, "nothing chosen asserts nothing");
    // The shortest length is its own position, one along from unset.
    assert.equal(free(4).value, 0);
    assert.notEqual(free(4).value, unset.value);
  });

  it("fills to the handle, in proportion to the whole track", () => {
    // Four positions: unset, 4, 6, 8.
    assert.equal(Math.round(free(4).fill), 33);
    assert.equal(Math.round(free(6).fill), 67);
    assert.equal(free(8).fill, 100);
  });

  it("shortens for a job carrying references, and says what that cost", () => {
    const held = durationTrack(SHORTER, 6, { withReferences: true });
    assert.deepEqual(held.stops, [4, 6]);
    assert.equal(held.lostToReferences, 8, "the tail is named, to be shown struck");
    assert.equal(held.fill, 100, "6s is the end of the shortened track");
    // Without references the same row keeps its full range and gives nothing up.
    const loose = durationTrack(SHORTER, 6, { withReferences: false });
    assert.deepEqual(loose.stops, [4, 6, 8]);
    assert.equal(loose.lostToReferences, null);
  });

  it("keeps a length past the ceiling, and puts it past the end of the track", () => {
    // 8s was chosen before the reference was attached. Nothing is rewritten behind the user:
    // the length stands, marked, and Generate refuses in words.
    const over = durationTrack(SHORTER, 8, { withReferences: true });
    assert.equal(over.overCeiling, true);
    // Past the end, not on the ceiling — otherwise the ceiling is not somewhere the handle can
    // be clicked back onto, and the obvious way out of the refusal would do nothing.
    assert.equal(over.max, over.stops.length);
    assert.equal(over.value, over.max);
    assert.equal(over.fill, 100);
  });

  it("holds still for a model that declares no lengths at all", () => {
    const bare: ManifestModel = { ...BASE, limits: { maxDurationSec: 8 } };
    const track = durationTrack(bare, undefined, { withReferences: false });
    assert.deepEqual(track.stops, []);
    assert.equal(track.fill, 0);
  });
});

describe("what the closed pill says", () => {
  it("carries the answer, so the row states the length without the panel being open", () => {
    assert.equal(durationPillLabel(BASE, 6), "6s");
  });

  it("names who is choosing when nobody has chosen", () => {
    // A model that takes "auto" is being asked to choose; one that does not simply gets no
    // duration on the wire. Printing the shortest stop would name a length nobody asked for.
    assert.equal(durationPillLabel(BASE, undefined), "Auto");
    const noAuto: ManifestModel = { ...BASE, limits: { ...BASE.limits, durationAuto: undefined } };
    assert.equal(durationPillLabel(noAuto, undefined), "default");
  });
});
