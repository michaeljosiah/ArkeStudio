import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TimelineClip } from "@arke-studio/contracts";
import {
  autoScrollStep,
  fileKindsFromTransfer,
  laneTakesFiles,
  reorderPreview,
  snapCandidates,
  snapFrame,
  snapMoveDelta,
} from "../src/lib/clip-gesture.js";
import { evictableSource, filmstripFrameCount, filmstripTimes } from "../src/lib/filmstrip.js";

/**
 * What a drag shows before it commits (issue 1034): the slot a reorder lands in and the way the
 * neighbours make room, the edge that snaps, the canvas that scrolls; and what a desktop file
 * says it is before it is dropped (issue 1035).
 */

const clip = (id: string, startFrame: number, durationFrames: number): TimelineClip =>
  ({ id: `cl_${id}`, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_01J8G0000000000000000000R1", label: id } }) as TimelineClip;

// Four abutting clips: a 0–48, b 48–96, c 96–192, d 192–240.
const sequence = [clip("a", 0, 48), clip("b", 48, 96 - 48), clip("c", 96, 96), clip("d", 192, 48)];

describe("the slot a reorder lands in", () => {
  it("stays put while the centre has not crossed a neighbour's", () => {
    const preview = reorderPreview(sequence, "cl_b" as TimelineClip["id"], 10)!;
    assert.equal(preview.index, preview.from);
    assert.equal(preview.slotStartFrame, 48);
    assert.equal(preview.shifts.size, 0);
  });

  it("opens after the crossed neighbours when moving later, sliding them left by the clip's length", () => {
    // b's centre (72) + 60 = 132 passes c's centre (144)? No: 132 < 144, so only past a and itself: index 1 still.
    assert.equal(reorderPreview(sequence, "cl_b" as TimelineClip["id"], 60)!.index, 1);
    // +80 → centre 152 > c's 144: b lands after c.
    const preview = reorderPreview(sequence, "cl_b" as TimelineClip["id"], 80)!;
    assert.equal(preview.index, 2, "the move-to-order index the command will carry");
    assert.deepEqual([...preview.shifts.entries()], [["cl_c", -48]], "c slides left into b's hole");
    assert.equal(preview.slotStartFrame, 192 - 48, "the slot opens where c's tail was, less b's length");
  });

  it("opens where the first crossed neighbour stood when moving earlier, sliding them right", () => {
    // d's centre (216) − 150 = 66: past a's centre (24) but not b's (72) → index 1.
    const preview = reorderPreview(sequence, "cl_d" as TimelineClip["id"], -150)!;
    assert.equal(preview.index, 1);
    assert.deepEqual([...preview.shifts.entries()], [["cl_b", 48], ["cl_c", 48]]);
    assert.equal(preview.slotStartFrame, 48, "where b stood");
  });

  it("keeps every hole at its ordinal, the way the saved reorder relays the sequence", () => {
    // a 0–48, a 12-frame hole, b 60–108, c 108–156. Moving c to the front (its centre, 132,
    // taken 120 frames back, lands before a's at 24): the hole stays before whichever clip is
    // second, so a lands at 60 and b at 108.
    const holed = [clip("a", 0, 48), clip("b", 60, 48), clip("c", 108, 48)];
    const preview = reorderPreview(holed, "cl_c" as TimelineClip["id"], -120)!;
    assert.equal(preview.index, 0);
    assert.equal(preview.slotStartFrame, 0);
    assert.deepEqual([...preview.shifts.entries()], [["cl_a", 60], ["cl_b", 48]]);
  });

  it("knows nothing about a clip that is not on the track", () => {
    assert.equal(reorderPreview(sequence, "cl_zz" as TimelineClip["id"], 5), null);
  });
});

describe("snapping", () => {
  it("pulls a frame onto the nearest candidate inside the threshold and leaves it alone outside", () => {
    assert.deepEqual(snapFrame(50, [0, 48, 96], 4), { frame: 48, snappedTo: 48 });
    assert.deepEqual(snapFrame(60, [0, 48, 96], 4), { frame: 60, snappedTo: null });
    assert.deepEqual(snapFrame(50, [0, 48, 96], 4, true), { frame: 50, snappedTo: null }, "Alt bypasses");
  });

  it("snaps a moving clip by whichever edge is nearer, and answers as a delta", () => {
    // Clip 10–40 moved +35: head at 45, tail at 75; the tail is 3 from 72 and the head 3 from 48 — the head wins a tie.
    const tie = snapMoveDelta(10, 30, 35, [48, 72], 4);
    assert.deepEqual([tie.deltaFrames, tie.snappedTo], [38, 48]);
    // Moved +30: head 40, tail 70; only the tail is within reach of 72.
    const tail = snapMoveDelta(10, 30, 30, [48, 72], 4);
    assert.deepEqual([tail.deltaFrames, tail.snappedTo], [32, 72]);
    assert.deepEqual(snapMoveDelta(10, 30, 100, [48, 72], 4).snappedTo, null);
  });

  it("collects every clip edge on every track, the playhead and zero, leaving out the clip in hand", () => {
    const candidates = snapCandidates([{ clips: sequence }, { clips: [clip("m", 30, 10)] }], 200, "cl_b" as TimelineClip["id"]);
    assert.deepEqual(candidates, [0, 30, 40, 48, 96, 192, 200, 240]);
  });
});

describe("auto-scroll", () => {
  it("is still in the middle and faster the deeper the pointer sits in an edge band", () => {
    assert.equal(autoScrollStep(500, 0, 1000), 0);
    assert.ok(autoScrollStep(990, 0, 1000) > autoScrollStep(975, 0, 1000) && autoScrollStep(975, 0, 1000) > 0);
    assert.ok(autoScrollStep(5, 0, 1000) < 0);
    assert.equal(autoScrollStep(10, 0, 40), 0, "a canvas too narrow for two bands never scrolls");
    assert.equal(autoScrollStep(1500, 0, 1000), 18, "capped once the captured pointer leaves the canvas");
    assert.equal(autoScrollStep(-500, 0, 1000), -18);
  });
});

describe("what a dragged file says it is", () => {
  it("reads the kinds from the items the browser exposes during dragover", () => {
    assert.deepEqual(fileKindsFromTransfer({ types: ["Files"], items: [{ kind: "file", type: "video/mp4" }, { kind: "file", type: "audio/wav" }, { kind: "string", type: "text/plain" }] }), ["video", "audio"]);
    assert.deepEqual(fileKindsFromTransfer({ types: ["Files"], items: [{ kind: "file", type: "" }] }), ["unknown"]);
    assert.deepEqual(fileKindsFromTransfer({ types: ["Files"] }), ["unknown"], "an engine with no items still says there are files");
    assert.deepEqual(fileKindsFromTransfer({ types: ["text/plain"] }), []);
  });

  it("refuses a lane only on a real mismatch", () => {
    assert.equal(laneTakesFiles(["video", "image"], false), true);
    assert.equal(laneTakesFiles(["audio"], false), false, "sound on a picture lane");
    assert.equal(laneTakesFiles(["video", "audio"], true), true, "a video may carry sound; the import decides");
    assert.equal(laneTakesFiles(["image"], true), false, "a still on a sound lane");
    assert.equal(laneTakesFiles(["unknown"], true), true);
    // A mixed drop is not refused whole: the video lands and the import names the still it could not place.
    assert.equal(laneTakesFiles(["video", "image"], true), true);
    assert.equal(laneTakesFiles(["image", "image"], true), false, "nothing in it could land");
    assert.equal(laneTakesFiles(["audio", "image"], false), true, "the still lands on the picture lane");
  });
});

describe("the strip and the poster", () => {
  it("fits as many 16:9 frames as the width allows and samples the middle of each", () => {
    assert.equal(filmstripFrameCount(0, 58), 0);
    assert.equal(filmstripFrameCount(50, 58), 1, "a narrow clip still shows one frame");
    assert.equal(filmstripFrameCount(412, 58), 3);
    assert.deepEqual(filmstripTimes(2, 6, 3), [3, 5, 7]);
    assert.deepEqual(filmstripTimes(0, 0, 3), []);
  });

  it("releases only an idle source nobody still wants, oldest first, and none while every decoder is busy", () => {
    const wanted = new Set(["b#1"]);
    const entries: Array<readonly [string, { busy: boolean; queue: ReadonlyArray<{ key: string }>; lastUsed: number }]> = [
      ["a", { busy: false, queue: [], lastUsed: 2 }],
      ["b", { busy: false, queue: [{ key: "b#1" }], lastUsed: 1 }],
      ["c", { busy: true, queue: [], lastUsed: 0 }],
      ["d", { busy: false, queue: [{ key: "d#1" }], lastUsed: 3 }],
    ];
    assert.equal(evictableSource(entries, (key) => wanted.has(key)), "a", "b is still wanted, c is decoding, d is younger");
    // With only a wanted source and a busy one left, nothing goes: the next source waits its turn
    // instead of becoming a decoder past the cap.
    assert.equal(evictableSource(entries.filter(([name]) => name === "b" || name === "c"), (key) => wanted.has(key)), null);
    assert.equal(evictableSource([], () => false), null);
  });
});
