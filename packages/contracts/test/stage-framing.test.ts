import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STAGE_FRAMED_HEIGHT, stageFrameKey, stageReframed, stagingFov, sampleStageCamera, type ResolvedShotStaging, type StageFrameWords } from "../src/index.js";

/** The camera in words (issue 1820, design turn 229a). */

const stage = (facing = 0): ResolvedShotStaging => ({
  version: 1, sets: [], keys: [],
  cast: [{ sheetId: "ade", x: 1, z: 0, facing }, { sheetId: "ife", x: 1, z: -3, facing: 0 }],
});
const words = (change: Partial<StageFrameWords> = {}): StageFrameWords => ({ subject: "ade", size: "medium", angle: "eye", side: "front", ...change });
const world = (staging: ResolvedShotStaging, key: NonNullable<ReturnType<typeof stageFrameKey>>) => sampleStageCamera({ ...staging, keys: [key] }, key.t, 4);

describe("the camera in words (issue 1820)", () => {
  it("stands in front of the subject at the distance the size and lens give", () => {
    const staging = stage();
    const key = stageFrameKey(staging, words(), 0, 4, "16:9", "35 mm")!;
    assert.equal(key.anchor, "ade");
    assert.equal(key.track, "ade");
    const pose = world(staging, key);
    // Facing +Z, "front" is +Z of the subject.
    assert.ok(pose.p[2] > 0.5, "in front");
    const fov = stagingFov("35 mm", "16:9") * Math.PI / 180;
    const expected = 1.8 * STAGE_FRAMED_HEIGHT.medium / (2 * Math.tan(fov / 2));
    assert.ok(Math.abs(Math.hypot(pose.p[0] - 1, pose.p[2]) - expected) < 0.01, "the framed height fills the lens");
    const close = world(staging, stageFrameKey(staging, words({ size: "close-up" }), 0, 4, "16:9", "35 mm")!);
    assert.ok(Math.hypot(close.p[0] - 1, close.p[2]) < expected, "a close-up stands closer");
    const long = world(staging, stageFrameKey(staging, words({ focalMm: 85 }), 0, 4, "16:9", "35 mm")!);
    assert.ok(Math.hypot(long.p[0] - 1, long.p[2]) > expected * 2, "a longer lens stands further back for the same size");
  });

  it("takes its sides from the subject's own facing, and over the shoulder stands behind the other", () => {
    const staging = stage(90); // facing +X
    const front = world(staging, stageFrameKey(staging, words(), 0, 4, "16:9", "35 mm")!);
    assert.ok(front.p[0] > 2, "front follows a turned subject");
    const behind = world(staging, stageFrameKey(staging, words({ side: "behind" }), 0, 4, "16:9", "35 mm")!);
    assert.ok(behind.p[0] < 0);
    const over = stageFrameKey(stage(), words({ side: "over", over: "ife", subject: "ade" }), 0, 4, "16:9", "35 mm")!;
    assert.equal(over.anchor, undefined, "a two-person view is not anchored to one of them");
    assert.ok(over.p[2] < -3, "behind Ife, looking at Ade");
    const low = world(stage(), stageFrameKey(stage(), words({ angle: "low" }), 0, 4, "16:9", "35 mm")!);
    assert.ok(low.p[1] < low.l[1], "a low angle looks up");
  });

  it("solves worded keys again after a retime, and leaves keys written as numbers alone", () => {
    const staging: ResolvedShotStaging = { ...stage(), performances: [{ sheetId: "ade", keys: [{ t: 0, x: 1, z: 0 }, { t: 4, x: 1, z: 4 }] }] };
    const worded = stageFrameKey(staging, words({ side: "left" }), 4, 4, "16:9", "35 mm")!;
    const numbered = { t: 0, p: [0, 1.5, 3] as [number, number, number], l: [0, 1, 0] as [number, number, number] };
    const reframed = stageReframed({ ...staging, keys: [numbered, worded] }, 4, "16:9", "50 mm");
    assert.deepEqual(reframed.keys[0], numbered);
    assert.deepEqual(reframed.keys[1]!.frame, worded.frame, "the words stay");
    assert.notDeepEqual(reframed.keys[1]!.p, worded.p, "a new lens moves the camera to hold the same size");
  });
});
