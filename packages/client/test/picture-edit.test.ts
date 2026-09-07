import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TimelineClip } from "@arke-studio/contracts";
import { clipAtFrame, frameAtPixel, framesFromDelta, pictureDragCommand, timingEntryCommand } from "../src/lib/picture-edit.js";

/**
 * A completed gesture is one command or none (SPEC-037 R-23): the pointer measures pixels and
 * this decides what they mean, clamped to what the neighbours and the source allow.
 */

function clip(id: `cl_${string}`, startFrame: number, durationFrames: number, sourceInFrames = 0): TimelineClip {
  return {
    id,
    startFrame,
    durationFrames,
    sourceInFrames,
    source: { kind: "shot", shotId: `sh_${id.slice(3)}`, sceneNumber: 1, shotNumber: 1, label: id },
  };
}

/** 0–40, hole, 50–88 with ten frames of source behind it, hole, 100–200. */
const clips = [clip("cl_a", 0, 40), clip("cl_b", 50, 38, 10), clip("cl_c", 100, 100)];

describe("pointer deltas become single Picture commands (#679)", () => {
  it("turns pixels into whole frames and clamps a lane position", () => {
    assert.equal(framesFromDelta(50, 200, 400), 100);
    assert.equal(framesFromDelta(-50, 200, 400), -100);
    assert.equal(framesFromDelta(50, 0, 400), 0, "a lane with no width moves nothing");
    assert.equal(frameAtPixel(-5, 200, 400), 0);
    assert.equal(frameAtPixel(210, 200, 400), 400);
    assert.equal(frameAtPixel(100, 200, 400), 200);
  });

  it("reorders by where the clip's centre lands and sends nothing for a drop in place", () => {
    assert.equal(pictureDragCommand(clips, "cl_a", "move", 0), null);
    assert.equal(pictureDragCommand(clips, "cl_a", "move", 10), null, "still first among the centres");
    assert.deepEqual(pictureDragCommand(clips, "cl_a", "move", 60), { kind: "move-to-order", clipId: "cl_a", index: 1 });
    assert.equal(clipAtFrame(clips, 45), null);
    assert.deepEqual(pictureDragCommand(clips, "cl_c", "move", -140), { kind: "move-to-order", clipId: "cl_c", index: 0 });
    assert.equal(pictureDragCommand(clips, "cl_zz", "move", 60), null, "an unknown clip is not a gesture");
  });

  it("clamps a head trim to the source and the previous clip, and a tail trim to the next", () => {
    assert.deepEqual(pictureDragCommand(clips, "cl_b", "trim-start", -4), { kind: "trim", clipId: "cl_b", edge: "start", deltaFrames: -4 });
    // Ten frames of source and ten frames of hole behind the head: the smaller bound wins.
    assert.deepEqual(pictureDragCommand(clips, "cl_b", "trim-start", -40), { kind: "trim", clipId: "cl_b", edge: "start", deltaFrames: -10 });
    // The previous clip's tail is the bound when it is the nearer one.
    const crowded = [clip("cl_a", 0, 46), clip("cl_b", 50, 38, 10), clip("cl_c", 100, 100)];
    assert.deepEqual(pictureDragCommand(crowded, "cl_b", "trim-start", -40), { kind: "trim", clipId: "cl_b", edge: "start", deltaFrames: -4 });
    assert.deepEqual(pictureDragCommand(clips, "cl_b", "trim-start", 500), { kind: "trim", clipId: "cl_b", edge: "start", deltaFrames: 37 });
    assert.deepEqual(pictureDragCommand(clips, "cl_b", "trim-end", 30), { kind: "trim", clipId: "cl_b", edge: "end", deltaFrames: 12 });
    assert.deepEqual(pictureDragCommand(clips, "cl_b", "trim-end", -500), { kind: "trim", clipId: "cl_b", edge: "end", deltaFrames: -37 });
    assert.deepEqual(pictureDragCommand(clips, "cl_c", "trim-end", 500), { kind: "trim", clipId: "cl_c", edge: "end", deltaFrames: 500 }, "nothing follows the last clip");
  });

  it("finds the clip under a frame and none in a hole", () => {
    assert.equal(clipAtFrame(clips, 39)?.id, "cl_a");
    assert.equal(clipAtFrame(clips, 45), null);
    assert.equal(clipAtFrame(clips, 50)?.id, "cl_b");
    assert.equal(clipAtFrame(clips, 90), null);
    assert.equal(clipAtFrame(clips, 200), null);
  });
});

describe("a typed timecode becomes the one command a drag would", () => {
  // A 3:47 song at 25fps, alone on its lane, with its whole source in play.
  const song = [clip("cl_s", 0, 5675)];
  const source = () => 5675;

  it("sets Out and Duration by trimming the tail, and In by trimming the head", () => {
    assert.deepEqual(timingEntryCommand(song, "cl_s", "out", "0:48", 25, source), { kind: "trim", clipId: "cl_s", edge: "end", deltaFrames: -4475 });
    assert.deepEqual(timingEntryCommand(song, "cl_s", "duration", "00:00:10:00", 25, source), { kind: "trim", clipId: "cl_s", edge: "end", deltaFrames: -5425 });
    assert.deepEqual(timingEntryCommand(song, "cl_s", "in", "10", 25, source), { kind: "trim", clipId: "cl_s", edge: "start", deltaFrames: 250 });
    assert.deepEqual(timingEntryCommand(song, "cl_s", "position", "1:00", 25, source), { kind: "move-to-frame", clipId: "cl_s", startFrame: 1500 });
  });

  it("clamps to the source and the clip the way the grips do", () => {
    const short = [clip("cl_s", 0, 1200)];
    // Out past the measured source lands on the source's last frame; already there, nothing goes.
    assert.deepEqual(timingEntryCommand(short, "cl_s", "out", "9:59", 25, source), { kind: "trim", clipId: "cl_s", edge: "end", deltaFrames: 4475 });
    assert.equal(timingEntryCommand(song, "cl_s", "out", "9:59", 25, source), null);
    // In past the tail keeps one frame; a head with no source behind it cannot move earlier.
    assert.deepEqual(timingEntryCommand(short, "cl_s", "in", "9:59", 25, source), { kind: "trim", clipId: "cl_s", edge: "start", deltaFrames: 1199 });
    assert.equal(timingEntryCommand([clip("cl_s", 100, 1200)], "cl_s", "in", "0", 25, source), null);
  });

  it("sends nothing for the same value, for text that is not a time, or for a clip it cannot find", () => {
    assert.equal(timingEntryCommand(song, "cl_s", "out", "00:03:47:00", 25, source), null);
    assert.equal(timingEntryCommand(song, "cl_s", "position", "0", 25, source), null);
    assert.equal(timingEntryCommand(song, "cl_s", "duration", "three minutes", 25, source), null);
    assert.equal(timingEntryCommand(song, "cl_s", "duration", "", 25, source), null);
    // The parser would read "1.5" as fifteen seconds; a value with anything but digits and colons is not a time.
    assert.equal(timingEntryCommand(song, "cl_s", "duration", "1.5", 25, source), null);
    assert.equal(timingEntryCommand(song, "cl_s", "duration", "0:48s", 25, source), null);
    assert.equal(timingEntryCommand(song, "cl_s", "duration", "00:00:48;00", 25, source), null);
    assert.equal(timingEntryCommand(song, "cl_s", "duration", "9".repeat(40), 25, source), null, "digits past the frame range are not a time");
    assert.equal(timingEntryCommand(song, "cl_zz", "out", "0:48", 25, source), null);
  });
});
