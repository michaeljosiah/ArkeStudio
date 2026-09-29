import assert from "node:assert/strict";
import { it } from "node:test";
import { Vector3 } from "three";
import { resolvedShotStaging, sampleStageCamera, stageCameraScalar, stageCameraMotionWarnings, stageCameraStandoffWarnings, type ShotStaging } from "../src/index.js";

import { walkingOrbit } from "./fixtures/stage-scenes.js";

const distance = (a: number[], b: number[]) => new Vector3(...a).distanceTo(new Vector3(...b));
it("passes through an anchored nine-key orbit without interior ease stops", () => {
  const resolved = walkingOrbit;
  assert.deepEqual(stageCameraMotionWarnings(resolved, 6), []);
  const samples = Array.from({ length: 181 }, (_, i) => {
    const pose = sampleStageCamera(resolved, i / 30, 6);
    return { p: [pose.p[0], pose.p[1], pose.p[2] - (4.6 - i / 30 * 7.6 / 6)], direction: new Vector3(...pose.l).sub(new Vector3(...pose.p)).normalize() };
  });
  const speeds = samples.slice(1).map((sample, i) => distance(sample.p, samples[i]!.p) * 30);
  const angles = samples.slice(1).map((sample, i) => sample.direction.angleTo(samples[i]!.direction) * 30);
  for (let key = 1; key < 8; key++) {
    const at = Math.round(key * .75 * 30);
    assert.ok(Math.abs(speeds[at]! - speeds[at - 1]!) < .15, `speed continuous at ${key}: ${speeds[at - 1]} -> ${speeds[at]}`);
    assert.ok(angles[at]! / angles[at - 1]! > .8 && angles[at]! / angles[at - 1]! < 1.2, `aim continuous at ${key}`);
  }
});

it("keeps irregular scalar timing monotone with matching velocities at passing keys", () => {
  const keys = [0, 1.35, 2.7, 3.3, 4.2, 6].map(t => ({ t, p: [0, 0, 0] as [number, number, number], l: [0, 0, 0] as [number, number, number] }));
  const values = [0, 1, 2, 3, 6, 7];
  for (let i = 1; i < keys.length - 1; i++) {
    const t = keys[i]!.t, dt = .0001;
    const before = (stageCameraScalar(keys, values, t) - stageCameraScalar(keys, values, t - dt)) / dt;
    const after = (stageCameraScalar(keys, values, t + dt) - stageCameraScalar(keys, values, t)) / dt;
    assert.ok(Math.abs(before - after) < .01);
    assert.equal(stageCameraScalar(keys, values, t), values[i]);
  }
  let previous = -Infinity;
  for (let t = 0; t <= 6; t += .01) { const value = stageCameraScalar(keys, values, t); assert.ok(value >= previous); previous = value; }
});

it("warns about a walker approaching between camera keys, and clears for an anchored follow", () => {
  const staging: ShotStaging = { version: 1, cast: [{ sheetId: "walker", x: 0, z: 3, to: [0, -3] }], sets: [], keys: [
    { t: 0, p: [0, 1.2, 0], l: [0, 1.2, 3] }, { t: 6, p: [0, 1.2, 0], l: [0, 1.2, -3] },
  ] };
  assert.match(stageCameraStandoffWarnings(resolvedShotStaging({}, staging), 6).join(), /@walker.*at 3.00s/);
  staging.keys = staging.keys.map(key => ({ ...key, p: [0, 1.2, 2], l: [0, 1.2, 0], anchor: "walker", track: "walker" }));
  assert.deepEqual(stageCameraStandoffWarnings(resolvedShotStaging({}, staging), 6), []);
});

it("pans through interior aim keys while position holds, and preserves endpoint poses", () => {
  const stage = { version: 1, cast: [], sets: [], keys: [0, 1.35, 2.7, 4.2, 6].map((t, i) => ({
    t, p: [0, 1.5, 4] as [number, number, number], l: [i - 2, 1.2, 0] as [number, number, number], easeIn: .2, easeOut: .2,
  })) };
  for (let i = 1; i < stage.keys.length - 1; i++) {
    const t = stage.keys[i]!.t, dt = .001;
    const poses = [t - dt, t, t + dt].map(at => sampleStageCamera(stage, at, 6));
    const before = distance(poses[0]!.l, poses[1]!.l) / dt, after = distance(poses[1]!.l, poses[2]!.l) / dt;
    assert.ok(before > .1 && Math.abs(before - after) < .01, "aim passes through without stopping");
    poses.forEach(pose => assert.deepEqual(pose.p, [0, 1.5, 4]));
  }
  for (const key of [stage.keys[0]!, stage.keys.at(-1)!]) assert.deepEqual(sampleStageCamera(stage, key.t, 6), { p: key.p, l: key.l });
});

it("honours rest ramp fractions while matching passing-key velocities", () => {
  const keys = [0, 2, 4, 6].map(t => ({ t, p: [0, 0, 0] as [number, number, number], l: [0, 0, 0] as [number, number, number], easeOut: .5, easeIn: .5 }));
  const values = [0, 2, 5, 6], dt = .0001;
  assert.ok(stageCameraScalar(keys, values, dt) / dt < .001, "departure starts from rest");
  assert.ok((6 - stageCameraScalar(keys, values, 6 - dt)) / dt < .001, "arrival ends at rest");
  for (const t of [2, 4]) {
    const before = (stageCameraScalar(keys, values, t) - stageCameraScalar(keys, values, t - dt)) / dt;
    const after = (stageCameraScalar(keys, values, t + dt) - stageCameraScalar(keys, values, t)) / dt;
    assert.ok(Math.abs(before - after) < .002);
  }
  const shorter = keys.map(key => ({ ...key, easeOut: .1, easeIn: .1 }));
  assert.ok(stageCameraScalar(shorter, values, .1) > stageCameraScalar(keys, values, .1));
  assert.deepEqual([2.1, 2.5, 3.9].map(t => stageCameraScalar(keys, [0, 2, 2, 4], t)), [2, 2, 2]);
});

it("refreshes cached geometry after an in-place camera edit", () => {
  const stage = structuredClone(walkingOrbit);
  const before = sampleStageCamera(stage, 2, 6);
  stage.keys[3]!.p[0] += 2;
  const after = sampleStageCamera(stage, 2, 6);
  assert.ok(distance(before.p, after.p) > .1);
  stage.keys.forEach(key => { delete key.track; delete key.anchor; });
  stage.keys[3]!.l = [3, 2, 0];
  const aimBefore = sampleStageCamera(stage, 2, 6).l;
  stage.keys[3]!.l[0] += 2;
  assert.ok(distance(aimBefore, sampleStageCamera(stage, 2, 6).l) > .1);
});

it("flags abrupt camera timing for review without refusing the authored move", () => {
  const stage = { version: 1, cast: [], sets: [], keys: [0, 2, 2.1, 6].map((t, i) => ({
    t, p: [i, 1.5, 4] as [number, number, number], l: [0, 1.2, 0] as [number, number, number],
  })) };
  assert.match(stageCameraMotionWarnings(stage, 6).join(), /changes sharply near 2/);
  assert.ok(sampleStageCamera(stage, 2.05, 6).p.every(Number.isFinite));
});
