import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShotSchema, ShotStagingSchema, stageShot, stagingBeats, stagingFov, stagingMoveWord, stagingPromptClause, type Shot } from "../src/index.js";

const shot = (extra: Partial<Shot>): Shot => ({
  id: "sh_12",
  number: 12,
  title: "Maren at the rail",
  description: "@maren-kest grips the rail of @the-vigil.",
  durationSec: 4,
  ...extra,
});

describe("the Stage's arithmetic", () => {
  it("stages a shot deterministically from its cast, sets and framing words", () => {
    const first = stageShot(shot({ camera: "MCU · slow push-in" }), { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 });
    const again = stageShot(shot({ camera: "MCU · slow push-in" }), { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 });
    assert.deepEqual(first, again, "the same shot stages the same way twice");
    assert.equal(first.version, 1);
    assert.deepEqual(first.cast, [{ sheetId: "maren-kest", x: -1.5, z: 0 }]);
    assert.equal(first.sets[0]?.name, "The Vigil");
    assert.equal(first.keys.length, 2);
    assert.equal(first.keys[0]?.anchor, "maren-kest");
    assert.equal(first.keys[0]?.track, "maren-kest");
    assert.equal(first.keys[1]?.t, 4);
    assert.ok(first.keys[1]!.p[2] < first.keys[0]!.p[2], "a push-in ends closer");
    assert.ok(ShotStagingSchema.safeParse(first).success, "what staging writes is what the schema reads");
    assert.ok(ShotSchema.safeParse({ ...shot({}), staging: first }).success);
  });

  it("reads the move off the framing: static holds, orbit sweeps, crane rises, and a castless shot stays in the world", () => {
    const still = stageShot(shot({ framing: { size: "Wide", movement: "Static" } }), { cast: [], sets: [], durationSec: 6 });
    assert.equal(still.keys[0]?.anchor, undefined);
    assert.equal(stagingMoveWord(still.keys), "static");
    const orbit = stageShot(shot({ framing: { movement: "Slow orbit" } }), { cast: ["maren-kest"], sets: [], durationSec: 8 });
    assert.equal(orbit.keys.length, 3);
    assert.equal(stagingMoveWord(orbit.keys), "orbit");
    const crane = stageShot(shot({ framing: { movement: "Crane up" } }), { cast: ["maren-kest"], sets: [], durationSec: 5 });
    assert.equal(stagingMoveWord(crane.keys), "crane");
    const truck = stageShot(shot({ framing: { movement: "Tracking" } }), { cast: ["maren-kest"], sets: [], durationSec: 5 });
    assert.equal(stagingMoveWord(truck.keys), "truck");
  });

  it("derives the lens cone from the real lens and never a fixed angle", () => {
    assert.ok(stagingFov("50mm") < stagingFov("24mm"));
    assert.equal(stagingFov(undefined), 34);
    assert.equal(stagingFov("1mm"), 82, "clamped to something the previs can draw");
  });

  it("writes the move as timed beats in metres, with bearings from the subject's own facing", () => {
    const staging = {
      version: 1,
      cast: [{ sheetId: "maren-kest", x: 0, z: 5.5, to: [0, -6.5] as [number, number] }],
      sets: [],
      keys: [
        { t: 0, p: [0, 1.55, 3] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
        { t: 5, p: [-2.55, 1.5, 0.2] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
        { t: 10, p: [0.2, 4.4, 0.5] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
        { t: 15, p: [0, 1.45, -2.9] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
      ],
    };
    const beats = stagingBeats(staging, (id) => (id === "maren-kest" ? "Maren" : id));
    assert.equal(beats.length, 4);
    // She walks toward -Z, so +Z is behind her and -X is her left.
    assert.match(beats[0]!, /^0\.0s — 3\.0m behind Maren, 1\.55m high, aimed at Maren$/);
    assert.match(beats[1]!, /to the left of Maren/);
    assert.match(beats[2]!, /above Maren/);
    assert.match(beats[3]!, /in front of Maren/);
    const clause = stagingPromptClause(staging, (id) => (id === "maren-kest" ? "Maren" : id));
    assert.match(clause, /^Camera move, orbit, blocked out on the stage \(4 keys\)\. Maren walks through the shot\./);
    assert.ok(clause.includes(beats[3]!));
  });

  it("keeps the schema a read path: a staging with one key or no keys still parses", () => {
    assert.ok(ShotStagingSchema.safeParse({ version: 1, cast: [], sets: [], keys: [] }).success);
    assert.ok(ShotStagingSchema.safeParse({ version: 3, cast: [], sets: [], keys: [{ t: 0, p: [0, 1, 2], l: [0, 1, 0] }], playblast: { artifactId: "ar_01J8G0000000000000000000A1", version: 2 } }).success);
    assert.equal(ShotStagingSchema.safeParse({ version: 0, cast: [], sets: [], keys: [] }).success, false);
  });
});
