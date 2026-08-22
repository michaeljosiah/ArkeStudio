import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_CLIP_SEC, applyClipDrag, snapPointsFor } from "../src/lib/clip-drag.js";
import type { ClipBounds, ClipPlacement } from "../src/lib/clip-drag.js";

const bounds: ClipBounds = { totalSec: 20, maxLane: 3, snapPoints: [] };
const at = (startSec: number, endSec: number, lane = 1): ClipPlacement => ({ startSec, endSec, lane });

describe("dragging a clip along the ruler", () => {
  it("keeps its length, so a move is a move and not a trim", () => {
    const moved = applyClipDrag(at(2, 6), "move", 3, 0, bounds);
    assert.deepEqual(moved, { startSec: 5, endSec: 9, lane: 1 });
  });

  it("stops with its tail on the end rather than being squashed against it", () => {
    const moved = applyClipDrag(at(2, 6), "move", 100, 0, bounds);
    assert.deepEqual(moved, { startSec: 16, endSec: 20, lane: 1 }, "four seconds long, still");
  });

  it("stops at the top rather than before it", () => {
    assert.deepEqual(applyClipDrag(at(2, 6), "move", -100, 0, bounds), { startSec: 0, endSec: 4, lane: 1 });
  });

  it("changes lane by whole lanes, clamped to the ones that exist", () => {
    assert.equal(applyClipDrag(at(2, 6), "move", 0, 1, bounds).lane, 2);
    assert.equal(applyClipDrag(at(2, 6), "move", 0, 9, bounds).lane, 3, "no lane above the last");
    assert.equal(applyClipDrag(at(2, 6), "move", 0, -9, bounds).lane, 0, "and none below the bottom");
  });
});

describe("dragging a clip's edges", () => {
  it("moves the head without moving the tail", () => {
    assert.deepEqual(applyClipDrag(at(2, 6), "trim-start", 1, 0, bounds), {
      startSec: 3,
      endSec: 6,
      lane: 1,
    });
  });

  it("moves the tail without moving the head", () => {
    assert.deepEqual(applyClipDrag(at(2, 6), "trim-end", 2, 0, bounds), { startSec: 2, endSec: 8, lane: 1 });
  });

  it("never lets an edge cross its opposite", () => {
    const collapsed = applyClipDrag(at(2, 6), "trim-start", 99, 0, bounds);
    assert.equal(collapsed.startSec, 6 - MIN_CLIP_SEC);
    assert.ok(collapsed.endSec > collapsed.startSec, "an inverted window is not something to file");
    const other = applyClipDrag(at(2, 6), "trim-end", -99, 0, bounds);
    assert.equal(other.endSec, 2 + MIN_CLIP_SEC);
  });

  it("does not let the tail leave the film", () => {
    assert.equal(applyClipDrag(at(2, 6), "trim-end", 99, 0, bounds).endSec, 20);
  });

  /*
   * The film can shrink under a clip that is already placed — a shot deleted, a take un-accepted,
   * a shorter master track assigned. The clamp's floor then sits above its ceiling, and a crossed
   * clamp returns the ceiling rather than refusing, which is an end before its own start.
   */
  it("refuses both edges when the film is shorter than the clip's own start", () => {
    const shrunk = { ...bounds, totalSec: 40 };
    const stranded = at(50, 55);
    const tail = applyClipDrag(stranded, "trim-end", 1, 0, shrunk);
    assert.deepEqual(tail, stranded, "there is no honest tail to offer, so the gesture does nothing");
    assert.ok(tail.endSec > tail.startSec, "and never an end before its own start");
  });

  it("never drags a head below zero, whatever the clip's length", () => {
    const sliver = { startSec: 0, endSec: 0.05, lane: 0 };
    const head = applyClipDrag(sliver, "trim-start", -1, 0, bounds);
    assert.deepEqual(head, sliver, "a clip already shorter than the minimum has no head to move");
    assert.ok(head.startSec >= 0, "a negative start is not something to file");
  });
});

describe("snapping to the cuts", () => {
  const snapping: ClipBounds = { ...bounds, snapPoints: [0, 4, 8, 20] };

  it("lands a near miss on the cut", () => {
    assert.equal(applyClipDrag(at(2, 6), "move", 1.9, 0, snapping).startSec, 4, "3.9 is within reach of 4");
  });

  it("leaves a placement nobody was aiming at alone", () => {
    assert.equal(applyClipDrag(at(2, 6), "move", 4, 0, snapping).startSec, 6, "6 is nearer nothing");
  });

  it("offers the top and the end, which are not shot boundaries", () => {
    assert.deepEqual(snapPointsFor([4, 8], 20), [0, 4, 8, 20]);
    assert.deepEqual(snapPointsFor([0, 4], 8), [0, 4, 8], "and never offers the same point twice");
  });
});
