import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientMessageSchema, MAX_PLACE_POSITIONS, PlacePlanRefused, PlacePlanSchema, SceneSchema, ShotStagingSchema,
  placePictureStale, placePlanAfter, placePositionCamera, placePositionKeys, placePositionShots, planBounds, planCast,
  planFrame, planMark, planSides, planSpot, sameStageSets, scenePlacePlan, shotNudged, shotPlacePosition,
  stageSourceFingerprintInput, orderedShots,
  type PlacePlan, type StagingSet,
} from "../src/index.js";

/**
 * The Plan (design turn 285, issue 2302). The sample is the film scene the turn was drawn from:
 * one club, a booth on the west wall with two men facing each other along it, a table in the
 * north-east. What each test asks is whether the plan says what a person standing in that room
 * would say: who is on the left, which camera has crossed, where a wide on the dance floor stands.
 */

const SETS: StagingSet[] = [
  { name: "club", x: 0, z: 0, w: 14.8, h: 3.2, d: 7.9, kit: { kind: "room" } },
  { name: "bar", x: 0, z: -3.5, w: 4, h: 1.05, d: .6, kit: { kind: "counter" } },
  { name: "her table", x: 5.2, z: -1.75, w: 1, h: .75, d: 1.3, rotation: [0, 90, 0], kit: { kind: "table", seats: 2 } },
  { name: "dance floor", x: .2, z: .3, w: 5.2, h: .03, d: 4.7 },
];
// Ade north, Tunde south, facing each other along the booth; Ife across the room.
const CAST = [
  { sheetId: "ade", x: -5.35, z: -1.1, facing: 0, pose: "sit" },
  { sheetId: "ife", x: 6.15, z: -1.75, facing: -90, pose: "sit" },
  { sheetId: "tunde", x: -5.35, z: 1.2, facing: 180, pose: "sit" },
] as const;

const still = (p: [number, number, number], l: [number, number, number], extra: Record<string, unknown> = {}) =>
  [{ t: 0, p, l, ...extra }, { t: 4, p, l, ...extra }];
const over = (subject: string, whom: string) => ({ frame: { subject, size: "medium close-up", angle: "eye", side: "over", over: whom } });

function scene(shots: Array<{ keys: unknown; position?: number; performances?: unknown; own?: boolean }>) {
  return SceneSchema.parse({
    id: "sc_02", number: 2, slug: "gold-on-gold", title: "Gold on Gold", status: "draft", version: 1,
    inherits: { location: "the-club" },
    blocking: { version: 1, cast: CAST, sets: SETS },
    shots: shots.map((shot, index) => ({
      id: `sh_${index + 1}`, number: index + 1, title: "Shot", description: "A shot.", durationSec: 4, framing: { lens: "28mm" },
      staging: {
        version: 1, keys: shot.keys,
        ...(shot.position === undefined ? {} : { position: shot.position }),
        ...(shot.performances === undefined ? {} : { performances: shot.performances }),
        ...(shot.own ? { cast: CAST, sets: [] } : {}),
      },
    })),
  });
}

const plan = (positions: PlacePlan["positions"] = [], next = positions.length + 1): PlacePlan =>
  PlacePlanSchema.parse({ sheetId: "the-club", version: 3, sets: SETS, positions, next });

describe("a place's plan", () => {
  it("numbers positions once, never reuses a number, and holds one name once", () => {
    let current = plan();
    current = placePlanAfter(current, { op: "add-position", p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35 });
    current = placePlanAfter(current, { op: "add-position", name: "The wide", p: [.2, 1.5, 3.07], l: [.2, 1, -1], focalMm: 10 });
    assert.deepEqual(current.positions.map((position) => [position.n, position.name]), [[1, "Position 1"], [2, "The wide"]]);
    assert.throws(() => placePlanAfter(current, { op: "add-position", name: "  the   WIDE ", p: [0, 1, 0], l: [0, 1, 1], focalMm: 35 }), PlacePlanRefused, "compared as view names are");
    assert.throws(() => placePlanAfter(current, { op: "edit-position", n: 1, name: "The wide" }), PlacePlanRefused);
    current = placePlanAfter(current, { op: "remove-position", n: 1 });
    current = placePlanAfter(current, { op: "add-position", p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35 });
    assert.deepEqual(current.positions.map((position) => position.n), [2, 3], "a removed position leaves a gap");
    assert.equal(current.next, 4);
    assert.throws(() => placePlanAfter(current, { op: "edit-position", n: 1, name: "Gone" }), PlacePlanRefused);
    PlacePlanSchema.parse(current);
  });

  it("refuses a twenty-fifth position, a name past 24 characters and a number past the next", () => {
    let current = plan();
    for (let index = 0; index < MAX_PLACE_POSITIONS; index++) current = placePlanAfter(current, { op: "add-position", p: [index, 1.5, 3], l: [index, 1, 0], focalMm: 35 });
    assert.throws(() => placePlanAfter(current, { op: "add-position", p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35 }), /24 positions/);
    const message = (name: string) => ({ kind: "place-plan", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", sheetId: "the-club", change: { op: "add-position", name, p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35 } });
    assert.equal(ClientMessageSchema.safeParse(message("On Ade, at her table xyz")).success, true, "24 characters");
    assert.equal(ClientMessageSchema.safeParse(message("On Ade, at her table xyzw")).success, false, "25 characters");
    // A Yoruba letter with a dot below and a tone above is one letter and three code points.
    assert.equal(ClientMessageSchema.safeParse(message("ẹ̀".repeat(24))).success, true, "counted as a person reads it: 24 letters");
    assert.equal(ClientMessageSchema.safeParse(message("ẹ̀".repeat(25))).success, false);
    assert.equal(PlacePlanSchema.safeParse({ sheetId: "the-club", version: 1, sets: [], next: 2, positions: [{ n: 2, name: "Late", p: [0, 1, 0], l: [0, 1, 1], focalMm: 35 }] }).success, false);
  });

  it("keeps a position's words beside its numbers and drops them on a hand move", () => {
    const words = { subject: { kind: "cast", sheetId: "ife" }, size: "medium", angle: "eye", side: "front" } as const;
    let current = placePlanAfter(plan(), { op: "add-position", p: [3, 1.2, -.35], l: [6.15, .95, -1.75], focalMm: 65, words });
    assert.deepEqual(current.positions[0]!.words, words);
    current = placePlanAfter(current, { op: "edit-position", n: 1, name: "On Ife" });
    assert.deepEqual(current.positions[0]!.words, words, "a rename leaves the camera alone");
    current = placePlanAfter(current, { op: "edit-position", n: 1, p: [3.5, 1.2, -.35], words: null });
    assert.equal(current.positions[0]!.words, undefined);
    assert.deepEqual(current.positions[0]!.p, [3.5, 1.2, -.35]);
  });

  it("solves a position's words through its own lens, for a person and for a piece of the set", () => {
    const stage = { cast: [...CAST], sets: SETS };
    // Ife faces west (−90°): a camera in front of her stands west of her, level with her eyes.
    const front = placePositionCamera({ subject: { kind: "cast", sheetId: "ife" }, size: "medium", angle: "eye", side: "front" }, 65, stage, "16:9")!;
    assert.ok(front.p[0] < 6.15 - 1 && Math.abs(front.p[2] + 1.75) < .01, `in front of her, on her line: ${front.p}`);
    assert.ok(Math.abs(front.l[0] - 6.15) < .01 && Math.abs(front.l[2] + 1.75) < .01, "looking at her");
    // The room's master: a wide on the dance floor through a 10 mm stands about three metres south of its centre.
    const wide = placePositionCamera({ subject: { kind: "set", name: "dance floor" }, size: "wide", angle: "eye", side: "front" }, 10, stage, "16:9")!;
    assert.ok(Math.abs(wide.p[0] - .2) < .01 && wide.p[2] > 2.5 && wide.p[2] < 3.8, `south of the floor: ${wide.p}`);
    // Over the shoulder stands behind the near figure, looking past them.
    const shoulder = placePositionCamera({ subject: { kind: "cast", sheetId: "tunde" }, size: "medium close-up", angle: "eye", side: "over", over: "ade" }, 65, stage, "16:9")!;
    assert.ok(shoulder.p[2] < -1.1, "north of Ade, behind him");
    assert.equal(placePositionCamera({ subject: { kind: "set", name: "the stage" }, size: "wide", angle: "eye", side: "front" }, 10, stage, "16:9"), null);
    assert.equal(placePositionCamera({ subject: { kind: "cast", sheetId: "nobody" }, size: "wide", angle: "eye", side: "front" }, 10, stage, "16:9"), null);
  });

  it("hands a shot a still camera at a position, and says when the shot has since moved it", () => {
    const position = { p: [3.3, 1.2, -.35] as [number, number, number], l: [6.15, .95, -1.75] as [number, number, number], focalMm: 65 };
    const keys = placePositionKeys(position, 5);
    assert.deepEqual(keys.map((key) => key.t), [0, 5]);
    assert.equal(shotNudged(position, { keys }), false);
    assert.equal(shotNudged(position, { keys: [keys[0]!, { ...keys[1]!, p: [3.4, 1.2, -.35] }] }), true, "the nudge is the shot's");
    assert.equal(shotNudged(position, { keys: keys.map((key) => ({ ...key, track: "ife" })) }), true, "a camera that follows someone is not standing at the position");
    const staging = ShotStagingSchema.parse({ version: 1, keys, position: 7 });
    assert.equal(staging.position, 7);
    assert.equal(ShotStagingSchema.safeParse({ version: 1, keys, position: 0 }).success, false);
  });

  it("leaves which position a camera started from out of a playblast's fingerprint", () => {
    const keys = still([3.3, 1.2, -.35], [6.15, .95, -1.75]);
    const plain = scene([{ keys }]), named = scene([{ keys, position: 7 }]);
    assert.equal(stageSourceFingerprintInput(plain, orderedShots(plain)[0]!, "16:9"), stageSourceFingerprintInput(named, orderedShots(named)[0]!, "16:9"));
  });

  it("finds the plan of a scene's place, the position each shot uses and the shots at each position", () => {
    const here = plan([
      { n: 1, name: "Both men", p: [-1.5, 1.2, .05], l: [-5.35, 1, .05], focalMm: 28 },
      { n: 4, name: "Ade's view", p: [-4.65, 1.05, -.8], l: [5.6, .9, -1.75], focalMm: 135 },
    ], 5);
    const keys = still([-1.5, 1.2, .05], [-5.35, 1, .05]);
    const record = scene([{ keys, position: 1 }, { keys, position: 4 }, { keys, position: 1 }, { keys, position: 9 }, { keys }]);
    assert.equal(scenePlacePlan([here], record), here);
    assert.equal(scenePlacePlan([here], { inherits: { location: "the-vigil" } }), undefined);
    assert.equal(scenePlacePlan([here], {}), undefined, "a scene with no place has no plan");
    assert.deepEqual([...placePositionShots(here, record)], [[1, [1, 3]], [4, [2]]]);
    assert.equal(shotPlacePosition(here, orderedShots(record)[3]!), undefined, "a position the place no longer holds is no position");
    assert.equal(sameStageSets(SETS, JSON.parse(JSON.stringify(SETS))), true);
    // The same set as the schema hands it back, keys in the schema's order, is still the same set.
    assert.equal(sameStageSets(SETS, PlacePlanSchema.parse({ sheetId: "the-club", version: 1, sets: SETS, positions: [], next: 1 }).sets), true);
    assert.equal(sameStageSets(SETS, SETS.slice(1)), false);
  });

  it("marks a picture stale when its position or the set has moved since it was drawn", () => {
    const position = { p: [3.3, 1.2, -.35] as [number, number, number], l: [6.15, .95, -1.75] as [number, number, number], focalMm: 65 };
    const picture = { aspect: "16:9", file: "takes/tk_01J8G0000000000000000000A1/view.png", sourceTakeId: "tk_01J8G0000000000000000000A1", acceptedAt: "2026-11-18T10:00:00.000Z", setVersion: 3, camera: position };
    assert.equal(placePictureStale({ version: 3 }, position, picture), false);
    assert.equal(placePictureStale({ version: 4 }, position, picture), true, "the set changed");
    assert.equal(placePictureStale({ version: 3 }, { ...position, focalMm: 50 }, picture), true, "the lens changed");
    assert.equal(placePictureStale({ version: 3 }, { ...position, p: [3.3, 1.4, -.35] }, picture), true, "the camera moved");
  });
});

describe("sides", () => {
  // Cameras on the floor side of the booth (east of the two men) look west: Tunde on the left.
  const twoShot = still([-1.5, 1.2, .05], [-5.35, 1, .05]);
  const onTunde = still([-3.9, 1.25, -1.75], [-5.35, .95, 1.2], { focalMm: 65, ...over("tunde", "ade") });
  const onAde = still([-3.9, 1.25, 1.85], [-5.35, .95, -1.1], { focalMm: 75, ...over("ade", "tunde") });
  // From inside the wall bench, west of them: the same two, the other way round.
  const crossed = still([-6.6, 1.2, .05], [-5.35, .95, 1.2], { focalMm: 65, ...over("tunde", "ade") });

  it("writes a pair in picture order and keeps to the side most of its shots stand on", () => {
    const sides = planSides(scene([{ keys: twoShot }, { keys: onTunde }, { keys: onAde }]));
    assert.equal(sides.length, 1, "Ife is in none of these frames");
    const [pair] = sides;
    assert.deepEqual([pair!.left, pair!.right], ["tunde", "ade"], "from the floor, Tunde is on the left");
    assert.deepEqual(pair!.shotIds, ["sh_1", "sh_2", "sh_3"]);
    assert.deepEqual(pair!.crossings, []);
    assert.deepEqual(pair!.line, [[-5.35, -1.1], [-5.35, 1.2]]);
    assert.ok(Math.abs(pair!.keep[0] - 1) < 1e-9 && Math.abs(pair!.keep[1]) < 1e-9, "the cameras keep to the east of the line");
  });

  it("flags the shot on the other side, and refuses nothing", () => {
    const record = scene([{ keys: twoShot }, { keys: onTunde }, { keys: crossed }, { keys: onAde }]);
    const [pair] = planSides(record);
    assert.deepEqual(pair!.crossings, ["sh_3"]);
    assert.deepEqual([pair!.left, pair!.right], ["tunde", "ade"], "one crossing does not turn the pair round");
    assert.equal(record.version, 1, "judging changes nothing");
  });

  it("takes the earliest shot's side on a tie, and needs two shots to make a pair", () => {
    const [pair] = planSides(scene([{ keys: crossed }, { keys: onTunde }]));
    assert.deepEqual([pair!.left, pair!.right], ["ade", "tunde"], "the first shot stood west of them");
    assert.deepEqual(pair!.crossings, ["sh_2"]);
    assert.deepEqual(planSides(scene([{ keys: twoShot }])), [], "one shot is not a pair's coverage");
  });

  it("counts a single only when it is on one of the pair looking at the other, and leaves a private layout out", () => {
    // On Tunde alone, from the floor, with nothing saying he looks at Ade: Ade is out of frame.
    const single = still([-3.9, 1.25, 1.85], [-5.35, .95, 1.2], { focalMm: 135 });
    assert.deepEqual(planSides(scene([{ keys: single }, { keys: single }])), []);
    // The same frame, with his mark saying he looks at Ade.
    const looking = [{ sheetId: "tunde", keys: [{ t: 0, x: -5.35, z: 1.2, facing: 180, pose: "sit", look: "ade" }] }];
    const tracked = single.map((key) => ({ ...key, track: "tunde" }));
    assert.equal(planSides(scene([{ keys: tracked, performances: looking }, { keys: tracked, performances: looking }])).length, 1);
    assert.deepEqual(planSides(scene([{ keys: twoShot, own: true }, { keys: onTunde, own: true }])), []);
  });

  it("counts a camera on the line for neither side", () => {
    const onLine = still([-5.35, 1.2, 4], [-5.35, 1, 0], over("tunde", "ade"));
    const [pair] = planSides(scene([{ keys: onLine }, { keys: onTunde }, { keys: onAde }]));
    assert.deepEqual(pair!.shotIds, ["sh_2", "sh_3"]);
  });
});

describe("the plan's picture", () => {
  it("stands each person on their first mark, with the later marks and walks their shots give them", () => {
    const walk = [{ sheetId: "ade", keys: [{ t: 0, x: -5.35, z: -1.1 }, { t: 2, x: -1, z: -1.05 }, { t: 4, x: 4.25, z: -1.75 }] }];
    const keys = still([-1.5, 1.2, .05], [-5.35, 1, .05]);
    const cast = planCast(scene([{ keys, performances: walk }, { keys, performances: walk }, { keys }]));
    assert.deepEqual(cast.map((figure) => figure.sheetId), ["ade", "ife", "tunde"], "in the scene's cast order");
    const ade = cast[0]!;
    assert.deepEqual([ade.x, ade.z, ade.seated], [-5.35, -1.1, true]);
    assert.deepEqual(ade.later, [[-1, -1.05], [4.25, -1.75]], "each later mark once, the first mark never");
    assert.deepEqual(ade.walks, [[[-5.35, -1.1], [-1, -1.05], [4.25, -1.75]]], "the same walk in two shots is one line");
    assert.deepEqual(cast[2]!.later, []);
  });

  it("fits the room to the view with −z at the top, and puts a place on the floor at its pixel", () => {
    const bounds = planBounds(SETS, [[0, 0]]);
    assert.deepEqual(bounds, { x0: -7.4, z0: -3.95, x1: 7.4, z1: 3.95 }, "the room, not the furniture in it");
    const frame = planFrame(bounds, 667, 440);
    assert.ok(Math.abs(frame.halfW - 7.7) < 1e-9, "0.3 m round the room, held by its width");
    const [x, y] = planSpot(frame, 0, 0);
    assert.ok(Math.abs(x - 333.5) < 1e-6 && Math.abs(y - 220) < 1e-6, "the room's centre is the picture's");
    assert.ok(planSpot(frame, 0, -3.95)[1] < y, "north is up");
    // No room: everything the set covers, and anything drawn outside it.
    const open = planBounds(SETS.slice(1), [[-9, 0]]);
    assert.ok(open.x0 === -9 && open.x1 > 5.5 && open.z0 < -3.5);
    assert.deepEqual(planBounds([]), { x0: -2, z0: -2, x1: 2, z1: 2 });
  });

  it("draws a wedge as wide as the lens sees, and a frame for a position that looks straight down", () => {
    const wide = planMark({ p: [.2, 1.5, 3.07], l: [.2, 1, -1], focalMm: 10 }, "16:9");
    const long = planMark({ p: [-4.65, 1.05, -.8], l: [5.6, .9, -1.75], focalMm: 135 }, "16:9");
    assert.ok(wide.kind === "wedge" && long.kind === "wedge");
    if (wide.kind !== "wedge" || long.kind !== "wedge") return;
    const spread = (mark: typeof wide) => Math.hypot(mark.left[0] - mark.right[0], mark.left[1] - mark.right[1]);
    assert.ok(spread(wide) > 1.5 && spread(long) < .25, "a 10 mm opens wide, a 135 mm barely");
    assert.ok(wide.tip[1] < 3.07 && Math.abs(wide.tip[0] - .2) < 1e-9, "it points where the camera looks: north");
    assert.ok(Math.abs(Math.hypot(wide.tip[0] - wide.apex[0], wide.tip[1] - wide.apex[1]) - 1) < 1e-9, "a metre long");
    const down = planMark({ p: [5.2, 2.3, -1.75], l: [5.2, .75, -1.75], focalMm: 24 }, "16:9");
    assert.equal(down.kind, "frame");
    if (down.kind !== "frame") return;
    const width = down.corners[1]![0] - down.corners[0]![0], height = down.corners[2]![1] - down.corners[1]![1];
    assert.ok(Math.abs(width / height - 16 / 9) < 1e-6, "the rectangle its lens frames, at the production's aspect");
  });
});
