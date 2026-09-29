import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readCameraMove,
  resolvedShotStaging,
  sampleStageCamera,
  stageFigureAt,
  stageShot,
  stagingBeats,
  stagingMotionWord,
  stagingMoveWord,
  type Shot,
  type ShotStaging,
} from "../src/index.js";

/**
 * The camera semantics issue 886 found wrong in the first pass, as regressions.
 *
 * The review reproduced three: a pan became a truck, a tilt became a crane, and a static shot of
 * a walking subject became a tracking shot because the camera was anchored regardless. Those
 * were fixed; what this file adds is the rest of the list — combined moves, the direction word
 * read beside its own component, tracking against trucking, aim-only motion in the guidance,
 * and holds — because a first pass that reads "crane up, tilting down" as a crane that falls is
 * the same class of defect, and the same words reach the generator.
 *
 * Conventions: the first pass stands the camera on +Z looking down −Z at the subject, so +X is
 * the camera's right, a push shortens `p[2]`, a crane up raises `p[1]`, a pan right sweeps the
 * aim's x upward and a tilt up sweeps its y upward.
 */

const shot = (extra: Partial<Shot>): Shot => ({
  id: "sh_12",
  number: 12,
  title: "Maren at the rail",
  description: "@maren-kest grips the rail of @the-vigil.",
  durationSec: 4,
  ...extra,
});
const walker = (extra: Partial<Shot>): Shot => shot({ description: "@maren-kest walks to the door of @the-vigil.", ...extra });
const nameOf = (id: string): string => (id === "maren-kest" ? "Maren" : id);
const staged = (s: Shot, cast: string[] = ["maren-kest"], durationSec = 4) => {
  const first = stageShot(s, { cast, sets: ["The Vigil"], durationSec });
  return { first, resolved: resolvedShotStaging({ blocking: undefined }, first as ShotStaging), durationSec };
};
const move = (movement: string, description?: string, durationSec = 4) =>
  staged(description === undefined ? shot({ framing: { movement } }) : shot({ framing: { movement }, description }), ["maren-kest"], durationSec);

describe("combined camera moves keep every component (issue 886)", () => {
  it("a push-in with a pan right both pushes and pans, and is named for both", () => {
    const { first, resolved, durationSec } = move("Slow push-in with a pan right");
    const [a, b] = first.keys as [typeof first.keys[0], typeof first.keys[0]];
    assert.ok(b.p[2] < a.p[2], "the camera ends nearer");
    assert.ok(b.l[0] > a.l[0], "and the aim has swept to the right");
    assert.equal(a.anchor, undefined, "a push does not ride the subject");
    assert.match(stagingMoveWord(first.keys), /^dolly with pan$/);
    assert.match(stagingMotionWord(resolved, durationSec), /dolly with pan/);
    const [start, end] = stagingBeats(resolved, nameOf, durationSec);
    assert.notEqual(start, end, "the beats say two different things about the two ends of the move");
    assert.match(start!, /aim \(/);
  });

  it("a pan right and a tilt up sweep both axes of the aim from one held position", () => {
    const { first } = move("Pan right and tilt up");
    const [a, b] = first.keys as [typeof first.keys[0], typeof first.keys[0]];
    assert.deepEqual(a.p, b.p, "the position holds");
    assert.ok(b.l[0] > a.l[0], "aim sweeps right");
    assert.ok(b.l[1] > a.l[1], "and up");
    assert.equal(stagingMoveWord(first.keys), "pan and tilt");
  });

  it("a truck left with a pan right travels left while the lens turns right", () => {
    const { first } = move("Truck left, panning right");
    const [a, b] = first.keys as [typeof first.keys[0], typeof first.keys[0]];
    assert.ok(b.p[0] < a.p[0], "the camera moves to its own left");
    assert.ok(b.l[0] > a.l[0], "while the aim sweeps to its right");
    assert.equal(stagingMoveWord(first.keys), "truck with pan");
  });
});

describe("a direction word belongs to the component beside it", () => {
  it("crane up, tilting down: the camera rises while the aim drops", () => {
    // Read as one string with one direction, this was a crane that fell and no tilt at all.
    const { first } = move("Crane up, tilting down");
    const [a, b] = first.keys as [typeof first.keys[0], typeof first.keys[0]];
    assert.ok(b.p[1] > a.p[1], "the crane goes up");
    assert.ok(b.l[1] < a.l[1], "the tilt goes down");
    assert.equal(stagingMoveWord(first.keys), "crane with tilt");
  });

  it("pan left, pushing in: the aim sweeps left and the camera still ends nearer", () => {
    const { first } = move("Pan left, pushing in");
    const [a, b] = first.keys as [typeof first.keys[0], typeof first.keys[0]];
    assert.ok(b.l[0] < a.l[0], "pan left");
    assert.ok(b.p[2] < a.p[2], "push in");
  });

  it("reads each clause of a phrase for its own move and direction", () => {
    const cases: Array<[string, Partial<ReturnType<typeof readCameraMove>>]> = [
      ["Pan right", { pan: "right", rides: false, dolly: null }],
      ["slow pan to the left", { pan: "left", slow: true }],
      ["Tilt down", { tilt: "down" }],
      ["Boom down", { crane: "down", rig: "crane" }],
      ["Crane up, tilting down", { crane: "up", tilt: "down" }],
      ["Truck left", { truck: "left", rig: "dolly" }],
      ["Dolly out", { dolly: 1.6, rig: "dolly" }],
      ["Track in", { dolly: 0.55, rides: false }],
      ["Tracking", { rides: true, dolly: null, truck: null, rig: "dolly" }],
      ["Follow her through the door", { rides: true }],
      ["Slow arc around the table", { orbit: true, slow: true }],
      ["Handheld push-in", { dolly: 0.55, rig: "handheld" }],
      ["Static", { pan: null, tilt: null, dolly: null, crane: null, truck: null, orbit: false, rides: false, rig: "sticks" }],
    ];
    for (const [phrase, expected] of cases) {
      const read = readCameraMove(phrase);
      for (const [field, value] of Object.entries(expected)) {
        assert.deepEqual(read[field as keyof typeof read], value, `${phrase}: ${field}`);
      }
    }
  });
});

describe("tracking is riding, trucking is lateral, and a locked-off camera stays put", () => {
  it("a tracking shot of a walker rides her at a held offset, and its guidance says so", () => {
    const { first, resolved, durationSec } = move("Tracking", "@maren-kest walks to the door of @the-vigil.");
    assert.ok(first.cast[0]?.to, "she walks");
    assert.ok(first.keys.every((k) => k.anchor === "maren-kest" && k.track === "maren-kest"), "every key rides her and follows her");
    assert.deepEqual(first.keys[0]?.p, first.keys[1]?.p, "the offset holds — the keys do not also drift sideways");
    assert.match(stagingMotionWord(resolved, durationSec), /tracking/);
    const early = sampleStageCamera(resolved, 0, durationSec).p;
    const late = sampleStageCamera(resolved, 3, durationSec).p;
    assert.ok(Math.hypot(early[0] - late[0], early[2] - late[2]) > 0.5, "so in the world the camera walks with her");
    assert.match(stagingBeats(resolved, nameOf, durationSec)[0]!, /behind Maren.*aimed at Maren$/);
  });

  it("a truck is lateral travel on a world-locked camera", () => {
    const { first } = move("Truck right");
    assert.equal(first.keys[0]?.anchor, undefined);
    assert.ok(first.keys[1]!.p[0] > first.keys[0]!.p[0], "it moves to its own right");
    assert.equal(stagingMoveWord(first.keys), "truck");
  });

  it("a locked-off camera lets the actor cross the frame rather than following her", () => {
    for (const framing of [{ size: "Wide", movement: "Static" }, undefined]) {
      const s = framing === undefined ? walker({ camera: "WS · static" }) : walker({ framing });
      const { first, resolved, durationSec } = staged(s);
      assert.ok(first.cast[0]?.to, "she walks");
      assert.ok(first.keys.every((k) => k.anchor === undefined && k.track === undefined), "nothing rides");
      assert.deepEqual(sampleStageCamera(resolved, 0, durationSec), sampleStageCamera(resolved, 3, durationSec), "the camera does not move");
      const her0 = stageFigureAt(first.cast[0]!, undefined, 0, durationSec);
      const her3 = stageFigureAt(first.cast[0]!, undefined, 3, durationSec);
      assert.ok(Math.hypot(her0.x - her3.x, her0.z - her3.z) > 0.5, "she does");
      assert.equal(stagingMotionWord(resolved, durationSec), "static");
    }
  });

  it("a castless move is world-locked about the origin", () => {
    const { first } = staged(shot({ framing: { movement: "Push in with a pan right" } }), []);
    assert.equal(first.keys[0]?.anchor, undefined);
    assert.ok(first.keys[1]!.p[2] < first.keys[0]!.p[2]);
    assert.ok(first.keys[1]!.l[0] > first.keys[0]!.l[0]);
  });
});

describe("aim-only motion reaches the guidance", () => {
  it("a pan left and a pan right never produce the same beats", () => {
    const left = move("Pan left");
    const right = move("Pan right");
    assert.notDeepEqual(stagingBeats(left.resolved, nameOf, 4), stagingBeats(right.resolved, nameOf, 4));
    const up = move("Tilt up");
    const down = move("Tilt down");
    assert.notDeepEqual(stagingBeats(up.resolved, nameOf, 4), stagingBeats(down.resolved, nameOf, 4));
    for (const { resolved } of [left, right, up, down]) {
      const [a, b] = stagingBeats(resolved, nameOf, 4);
      assert.notEqual(a, b, "and the two ends of a pan or tilt are two different lines");
      assert.match(a!, /aim \(-?\d+\.\d\d, -?\d+\.\d\d, -?\d+\.\d\d\)m in world space/, "each line carries the aim as numbers");
    }
  });

  it("names a pan on a held position, and never calls a pan on a moving camera an orbit", () => {
    const pan: ShotStaging = { version: 1, cast: [], sets: [], keys: [
      { t: 0, p: [0, 1.5, 4], l: [-1.5, 1.2, 0] },
      { t: 4, p: [0, 1.5, 4], l: [1.5, 1.2, 0] },
    ] };
    assert.equal(stagingMoveWord(pan.keys), "pan");
    const pushAndPan: ShotStaging = { ...pan, keys: [
      { t: 0, p: [0, 1.5, 4], l: [-1.5, 1.2, 0] },
      { t: 4, p: [0, 1.5, 2], l: [1.5, 1.2, 0] },
    ] };
    assert.equal(stagingMoveWord(pushAndPan.keys), "dolly with pan", "the camera–aim angle sweeps, but the aim is what moved");
    const orbit: ShotStaging = { ...pan, keys: [
      { t: 0, p: [-3, 1.5, 3], l: [0, 1.2, 0] },
      { t: 2, p: [0, 1.5, 4.2], l: [0, 1.2, 0] },
      { t: 4, p: [3, 1.5, 3], l: [0, 1.2, 0] },
    ] };
    assert.equal(stagingMoveWord(orbit.keys), "orbit", "a held aim with the camera revolving around it is still an orbit");
  });
});

describe("intermediate holds", () => {
  it("a position hold before a dolly stays exactly still, then moves, and each key is its own beat", () => {
    const hold: ShotStaging = { version: 1, cast: [{ sheetId: "maren-kest", x: 0, z: 0 }], sets: [], keys: [
      { t: 0, p: [0, 1.5, 4], l: [0, 1.2, 0] },
      { t: 2, p: [0, 1.5, 4], l: [0, 1.2, 0] },
      { t: 4, p: [0, 1.5, 2], l: [0, 1.2, 0] },
    ] };
    const resolved = resolvedShotStaging({ blocking: undefined }, hold);
    for (const t of [0, 1, 2]) assert.deepEqual(sampleStageCamera(resolved, t, 4).p, [0, 1.5, 4], `held at ${t}s`);
    assert.ok(sampleStageCamera(resolved, 3, 4).p[2] < 4, "moving by 3s");
    assert.equal(stagingMoveWord(hold.keys), "dolly");
    const beats = stagingBeats(resolved, nameOf, 4);
    assert.equal(beats.length, 3);
    assert.match(beats[0]!, /^0\.0s — 4\.0m /);
    assert.match(beats[1]!, /^2\.0s — 4\.0m /, "the hold's end is a beat at the same distance");
    assert.match(beats[2]!, /^4\.0s — 2\.0m /);
  });

  it("an aim hold before a pan keeps the aim exactly still, then sweeps it", () => {
    const hold: ShotStaging = { version: 1, cast: [], sets: [], keys: [
      { t: 0, p: [0, 1.5, 4], l: [-1.5, 1.2, 0] },
      { t: 2, p: [0, 1.5, 4], l: [-1.5, 1.2, 0] },
      { t: 4, p: [0, 1.5, 4], l: [1.5, 1.2, 0] },
    ] };
    const resolved = resolvedShotStaging({ blocking: undefined }, hold);
    for (const t of [0, 1, 2]) assert.deepEqual(sampleStageCamera(resolved, t, 4).l, [-1.5, 1.2, 0], `aim held at ${t}s`);
    assert.ok(sampleStageCamera(resolved, 3, 4).l[0] > -1.5, "and sweeping by 3s");
    assert.equal(stagingMoveWord(hold.keys), "pan");
    const [a, b, c] = stagingBeats(resolved, nameOf, 4);
    assert.equal(a!.replace(/^0\.0s/, ""), b!.replace(/^2\.0s/, ""), "two beats of the hold say the same aim");
    assert.notEqual(b!.replace(/^2\.0s/, ""), c!.replace(/^4\.0s/, ""), "and the pan's end says another");
  });
});
