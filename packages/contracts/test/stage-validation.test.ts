import assert from "node:assert/strict";
import { it } from "node:test";
import { SceneSchema, stageFigureAt, stageObjectAt, stagingEase, stagePerformanceDeparture, stagingRetimed, stageLineCrossings, stageMotionSpeeds, stageSpeedWarnings, stagingPromptClause, type ResolvedShotStaging } from "../src/index.js";

const stage = (): ResolvedShotStaging => ({ version: 1, cast: [{ sheetId: "runner", x: 0, z: 0, parent: "car", to: [100, 0] }], sets: [],
  keys: [{ t: 0, p: [0, 2, 4], l: [0, 1, 0] }, { t: 4, p: [0, 2, 4], l: [0, 1, 0] }],
  performances: [{ sheetId: "runner", keys: [{ t: 1, x: 0, z: 0 }, { t: 2, x: 5, z: 0 }, { t: 3, x: 5, z: 0 }, { t: 4, x: 5.01, z: 0 }] }],
  objectMotions: [{ group: "car", keys: [{ t: 0, p: [0, 0, 0] }, { t: 4, p: [100, 0, 0] }] }],
});

it("measures each timed leg, ignores holds/tiny motion and does not charge a rider for vehicle travel (#1044)", () => {
  const staging = stage();
  const legs = stageMotionSpeeds(staging, 4);
  assert.equal(legs.length, 2);
  assert.equal(legs[0]!.speed, 5);
  assert.equal(legs[1]!.speed, 25);
  assert.match(stageSpeedWarnings(staging, id => id, 4).join("\n"), /5.0m in 1.0s .* too fast for a walk.*use run or add time/);
  staging.performances![0]!.keys[0]!.gait = "run";
  assert.deepEqual(stageSpeedWarnings(staging, id => id, 4), []);
  const brief = stagingPromptClause(staging, id => id, 4);
  assert.match(brief, /1.00s .* run/);
  assert.doesNotMatch(brief, /runner walks through/);
  staging.objectMotions![0]!.maxSpeed = 20;
  assert.match(stageSpeedWarnings(staging, id => id, 4).join("\n"), /car .*above 20.00m.s ceiling/);
});

it("measures curved object travel instead of the chord between its marks (#1044)", () => {
  const staging = stage();
  staging.objectMotions = [{ group: "car", maxSpeed: 1, keys: [
    { t: 0, p: [-1, 0, 0] }, { t: 1, p: [0, 0, 1] }, { t: 2, p: [1, 0, 0] },
  ] }];
  assert.ok(stageMotionSpeeds(staging, 4).filter(leg => leg.kind === "object").every(leg => leg.distance > Math.SQRT2));
});

function coverageScene() {
  return SceneSchema.parse({ id: "sc_probe", number: 1, slug: "probe", title: "Probe", status: "draft", version: 1,
    blocking: { version: 1, cast: [{ sheetId: "alice", x: -1, z: 0 }, { sheetId: "bob", x: 1, z: 0 }, { sheetId: "outside", x: 100, z: 0 }], sets: [] },
    shots: [1, 2].map(number => ({ id: `sh_${number}`, number, title: "Coverage", description: "Two-shot", durationSec: 4,
      staging: { version: 1, keys: [{ t: 0, p: [0, 1.5, 4], l: [0, 1, 0] }, { t: 4, p: [0, 1.5, 4], l: [0, 1, 0] }] },
    })),
  });
}

it("reports a crossing through the dead zone and opposite coverage only for a co-framed pair (#1045)", () => {
  const scene = coverageScene();
  scene.shots[0]!.staging!.keys.splice(1, 0, { t: 2, p: [3, 1.5, 0], l: [0, 1, 0] });
  scene.shots[0]!.staging!.keys[2]!.p[2] = -4;
  const findings = stageLineCrossings(scene);
  assert.equal(findings.filter(finding => finding.kind === "within-shot").length, 1);
  assert.ok(findings.some(finding => finding.kind === "across-coverage" && finding.shotIds.includes("sh_2")));
  assert.ok(findings.every(finding => finding.pair.join() === "alice,bob"));
  assert.equal(scene.version, 1, "diagnostics do not author changes");
  scene.shots[1]!.staging!.cast = scene.blocking!.cast.map(figure => ({ ...figure, x: figure.x + .1 }));
  scene.shots[1]!.staging!.sets = [];
  assert.equal(stageLineCrossings(scene).some(finding => finding.kind === "across-coverage"), false, "a different private layout is not the same coverage");
});

it("ignores same-side coverage and ambiguous axes, evaluating parented people and anchored cameras in world space (#1045)", () => {
  const scene = coverageScene();
  assert.deepEqual(stageLineCrossings(scene), []);
  scene.blocking!.cast = scene.blocking!.cast.slice(0, 2).map(figure => ({ ...figure, parent: "car" }));
  scene.blocking!.sets = [{ name: "Car", group: "car", x: 0, z: 0, w: 2, h: 1, d: 3 }];
  for (const shot of scene.shots) {
    shot.staging!.keys = shot.staging!.keys.map(key => ({ ...key, anchor: "car", anchorSpace: "local" }));
    shot.staging!.objectMotions = [{ group: "car", keys: [{ t: 0, p: [0, 0, 0] }, { t: 4, p: [20, 0, 10], rotation: [0, 180, 0] }] }];
  }
  assert.deepEqual(stageLineCrossings(scene), []);
  scene.blocking!.cast[1]!.x = scene.blocking!.cast[0]!.x;
  assert.deepEqual(stageLineCrossings(scene), []);
});

it("preserves legacy paths and shares object spline travel when performance controls are authored (#1046)", () => {
  const staging = stage();
  const figure = { sheetId: "runner", x: 0, z: 0 };
  const keys = staging.performances![0]!.keys = [{ t: 0, x: -1, z: 0, gait: "walk" }, { t: 2, x: 0, z: 1 }, { t: 4, x: 1, z: 0 }];
  assert.equal(stageFigureAt(figure, staging.performances, 1, 4).z, .5, "old tracks keep linear travel");
  keys[0]!.easeOut = 0;
  const objects = [{ group: "copy", keys: keys.map(key => ({ t: key.t, p: [key.x, 0, key.z] as [number, number, number] })) }];
  for (const at of [0, 1, 2, 3, 4, 5]) {
    const actor = stageFigureAt(figure, staging.performances, at, 4);
    assert.deepEqual([actor.x, actor.y, actor.z], stageObjectAt(objects, "copy", at).p);
  }
  assert.ok(stageFigureAt(figure, staging.performances, 1, 4).z > .5, "the interior mark shapes the curve");
  keys.splice(1, 1);
  assert.equal(stageFigureAt(figure, staging.performances, 1, 4).x, -.5, "a two-point path remains straight");
});

it("holds before eased travel, turns by the same progress, steps posture and scales holds on retime (#1046)", () => {
  const staging = stage();
  const figure = staging.cast[0] = { sheetId: "runner", x: 0, z: 0 };
  const keys = staging.performances![0]!.keys = [
    { t: 1, x: 0, z: 0, facing: 350, hold: 1, easeOut: .5 },
    { t: 3, x: 10, z: 0, facing: 10, pose: "sit", easeIn: .5 },
  ];
  for (const at of [0, 1, 2]) assert.equal(stageFigureAt(figure, staging.performances, at, 4).x, 0);
  const mix = stagingEase(keys[0]!, keys[1]!, .25);
  const moving = stageFigureAt(figure, staging.performances, 2.25, 4);
  assert.equal(moving.x, 10 * mix);
  assert.equal(moving.facing, 350 + 20 * mix);
  assert.equal(moving.pose, "stand");
  assert.equal(stageFigureAt(figure, staging.performances, 3, 4).pose, "sit");
  assert.equal(stageFigureAt(figure, staging.performances, 8, 4).x, 10);
  assert.equal(stageMotionSpeeds(staging, 4)[0]!.speed, 10, "waiting time cannot dilute travel speed");
  const retimed = stagingRetimed(staging, 8) as ResolvedShotStaging;
  assert.equal(retimed.performances![0]!.keys[0]!.hold, 2);
  assert.equal(retimed.performances![0]!.keys[0]!.t, 2);
  assert.equal(stageFigureAt(figure, retimed.performances, 4, 8).x, 0);
  assert.match(stagingPromptClause(retimed, id => id, 8), /hold until 4.00s, ease out 50%/);
  keys[0]!.hold = 50;
  assert.equal(stagePerformanceDeparture(keys[0]!, keys[1]!), 2.9);
  assert.equal(stagePerformanceDeparture(keys[0]!, { ...keys[1]!, t: 1.05 }), 1, "short legs still travel");
});
