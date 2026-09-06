import assert from "node:assert/strict";
import { it } from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import { stageFixtures } from "./fixtures/stage-scenes.js";
import { sampleStageCamera, stageObjectAt, stageLocalPoint, stageCameraKeyAt } from "../src/stage-camera.js";
import { stageProblems, stageFigureAt, stagingRetimed, stagingFov, stagingMotionWord } from "../src/staging.js";

it("keeps fixture subjects in frame through camera and independently timed action", () => {
  for (const { name, duration, stage } of stageFixtures) {
    assert.deepEqual(stageProblems(stage, duration), [], name);
    const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
    for (let at = 0; at <= duration; at += 0.25) {
      const pose = sampleStageCamera(stage, at, duration);
      const key = stageCameraKeyAt(stage, at, duration, 40);
      camera.fov = key.focalMm === undefined ? 40 : stagingFov(`${key.focalMm}mm`, "16:9");
      camera.updateProjectionMatrix();
      camera.position.set(...pose.p);
      camera.lookAt(new Vector3(...pose.l));
      camera.updateMatrixWorld(true);
      for (const figure of stage.cast) {
        if (name === "over-shoulder" && figure.sheetId === "speaker-one") continue; // foreground shoulder may intentionally crop
        const f = stageFigureAt(figure, stage.performances, at, duration, stage.objectMotions);
        const head = new Vector3(f.x, f.y + (f.pose === "sit" ? 1.28 : 1.62), f.z).project(camera);
        assert.ok(
          Math.abs(head.x) < 0.98 && Math.abs(head.y) < 0.98 && head.z < 1,
          `${name}: ${figure.sheetId} at ${at}s is out of frame: ${head.toArray()}`,
        );
      }
    }
  }
});
it("rides a turning object, settles in local space and retimes every action with the shot", () => {
  const { stage, duration } = stageFixtures.find((f) => f.name === "valley-chase")!;
  const f = stageFigureAt(stage.cast[0]!, undefined, 8, 8, stage.objectMotions);
  assert.deepEqual([f.x, f.y, f.z], [4.6, 0.45, 50.45]);
  for (const at of [6, 7, 8]) {
    const expected = stageLocalPoint([-0.4, 1.72, 2.4], stageObjectAt(stage.objectMotions, "lead-car", at));
    assert.ok(
      sampleStageCamera(stage, at, duration).p.every((v, i) => Math.abs(v - expected[i]!) < 1e-9),
      "final local camera hold must not overshoot",
    );
  }
  const retimed = stagingRetimed(stage, 4);
  assert.deepEqual(
    retimed.objectMotions?.[0]?.keys.map((k) => k.t),
    [0, 2, 4],
  );
  const inserted = stageCameraKeyAt(stage, 3, 8);
  const before = sampleStageCamera(stage, 3, 8),
    after = sampleStageCamera({ ...stage, keys: [inserted] }, 3, 8);
  assert.ok(before.p.every((v, i) => Math.abs(v - after.p[i]!) < 1e-8));
  assert.ok(before.l.every((v, i) => Math.abs(v - after.l[i]!) < 1e-8));
  assert.match(
    stageProblems(
      { ...stage, sets: stage.sets.map((s) => (s.shape === "mesh" ? { ...s, triangles: [0, 1, 999] } : s)) },
      8,
    ).join(" "),
    /triangle indices/,
  );
});

it("names a complete orbit even when its first and last position match",()=>{const fixture=stageFixtures.find(f=>f.name==="independent-motion")!;assert.match(stagingMotionWord(fixture.stage,fixture.duration),/orbit/);});
