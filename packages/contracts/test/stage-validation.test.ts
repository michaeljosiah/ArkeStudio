import assert from "node:assert/strict";
import { it } from "node:test";
import { stageMotionSpeeds, stageSpeedWarnings, stagingPromptClause, type ResolvedShotStaging } from "../src/index.js";

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
