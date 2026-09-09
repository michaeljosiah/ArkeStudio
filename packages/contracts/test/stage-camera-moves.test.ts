import assert from "node:assert/strict";
import { it } from "node:test";
import { STAGE_CAMERA_MOVES, ShotStagingSchema, stageCameraMove, sampleStageCamera, stageCameraKeyAt, stageTargetTransform, stageWorldPoint, stageProblems, stagingFov, type ResolvedShotStaging } from "../src/index.js";

const scene = (): ResolvedShotStaging => ({
  version: 1, cast: [{ sheetId: "actor", x: 0, z: 0, height: 2 }, { sheetId: "other", x: 1, z: 0 }], sets: [],
  keys: [{ t: 0, p: [0, 1.5, 5], l: [0, 1.3, 0], focalMm: 85, roll: 5 }, { t: 4, p: [1, 2, 6], l: [0, 1.3, 0], focalMm: 85, roll: 5 }],
  performances: [{ sheetId: "actor", keys: [{ t: 0, x: 0, z: 0 }, { t: 4, x: 0, z: 2, facing: 90 }] }],
});
const near = (actual: readonly number[], expected: readonly number[]) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) < 1e-8));

it("generates editable, bounded moves from the current camera without changing action (#1048)", () => {
  const staging = scene();
  const before = structuredClone(staging);
  const start = sampleStageCamera(staging, 1, 4).p;
  for (const { id } of STAGE_CAMERA_MOVES) {
    const keys = stageCameraMove(id, staging, { durationSec: 4, at: 1, subjectId: "other" });
    const generated = { ...staging, keys };
    assert.ok(ShotStagingSchema.safeParse(generated).success, id);
    assert.deepEqual(stageProblems(generated, 4), [], id);
    near(sampleStageCamera(generated, 0, 4).p, start);
    assert.equal(keys[0]!.easeOut, .25);
    assert.equal(keys.at(-1)!.easeIn, .25);
    assert.ok(keys.every(key => key.track === "other"));
  }
  assert.deepEqual(staging, before);
  const orbit = { ...staging, keys: stageCameraMove("orbit-360", staging, { durationSec: 4 }) };
  near(sampleStageCamera(orbit, 0, 4).p, sampleStageCamera(orbit, 4, 4).p);
  assert.ok(sampleStageCamera(orbit, 2, 4).p[2] < 0, "the midpoint crosses behind the subject");
});

it("rides a turning subject in local space after settling behind it (#1048)", () => {
  const staging = scene();
  staging.keys = stageCameraMove("follow-behind", staging, { durationSec: 4 });
  for (const at of [1, 2, 4]) {
    const target = stageTargetTransform(staging, "actor", at, 4)!;
    near(stageWorldPoint(sampleStageCamera(staging, at, 4).p, target), staging.keys.at(-1)!.p);
  }
  assert.ok(staging.keys.every(key => key.anchor === "actor" && key.anchorSpace === "local"));
});

it("compensates the vertigo lens throughout a moving subject's dolly and keeps low cameras above ground (#1048)", () => {
  for (const height of [1.5, .2]) {
    const staging = scene();
    staging.keys[0]!.p[1] = height;
    staging.keys = stageCameraMove("vertigo", staging, { durationSec: 4 });
    const framed: number[] = [];
    for (const at of [0, 1, 2, 3, 4]) {
      const camera = sampleStageCamera(staging, at, 4);
      const lens = stageCameraKeyAt(staging, at, 4).focalMm!;
      const distance = Math.hypot(...camera.p.map((value, index) => value - camera.l[index]!));
      framed.push(2 * distance * Math.tan(stagingFov(`${lens}mm`, "16:9") * Math.PI / 360));
      assert.ok(camera.p[1] >= .15);
    }
    assert.ok(framed.every(height => Math.abs(height - framed[0]!) < 1e-8));
  }
});
