import { orderedShots, type ClientState, type PlacePlan, type PlacePositionWords, type SceneRecord, type StagingKey, type StagingSet } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Plan's fixture (design turn 285): the Vigil with a set, two people on marks either side of a
 * chart table, and two camera positions, one south of the line between them and one north of it.
 * A shot staged at the south position sees Maren on the left; one staged at the north sees her on
 * the right, which is what a crossing is.
 */

export const PLAN_SETS: StagingSet[] = [
  { name: "watch room", kit: { kind: "room" }, x: 0, z: 0, w: 8, h: 3, d: 10 },
  { name: "chart table", x: 0, z: -2, w: 1.2, h: 0.75, d: 0.8, solid: true },
];
export const SOUTH_WORDS: PlacePositionWords = { subject: { kind: "cast", sheetId: "maren-kest" }, size: "medium", angle: "eye", side: "front" };
const SOUTH = { p: [0, 1.5, 4] as [number, number, number], l: [0, 1, 0] as [number, number, number], focalMm: 35 };
const NORTH = { p: [0, 1.5, -4] as [number, number, number], l: [0, 1, 0] as [number, number, number], focalMm: 35 };

export function vigilPlan(): PlacePlan {
  return {
    sheetId: "the-vigil",
    version: 3,
    sets: structuredClone(PLAN_SETS),
    positions: [
      { n: 1, name: "South", ...structuredClone(SOUTH), words: structuredClone(SOUTH_WORDS) },
      { n: 2, name: "North", ...structuredClone(NORTH) },
    ],
    next: 3,
  };
}

const standing = (camera: typeof SOUTH, durationSec: number): StagingKey[] => [{ t: 0, ...structuredClone(camera) }, { t: durationSec, ...structuredClone(camera) }];

/**
 * The fixture world with the Vigil planned and scene 4 staged in it. `second` is where shot 13's
 * camera stands: at the south position both shots keep one side, at the north shot 13 crosses.
 */
export function planState(options: { second?: "south" | "north"; plan?: boolean; staged?: boolean } = {}): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world!;
  world.sheets.push({ ...structuredClone(world.sheets.find((sheet) => sheet.id === "maren-kest")!), id: "iona-vale", name: "Iona Vale" });
  const scene = planScene(state);
  if (options.staged !== false) {
    scene.blocking = { version: 1, cast: [{ sheetId: "maren-kest", x: -1, z: 0 }, { sheetId: "iona-vale", x: 1, z: 0 }], sets: structuredClone(PLAN_SETS) };
    const [first, second] = orderedShots(scene);
    first!.staging = { version: 1, keys: standing(SOUTH, first!.durationSec ?? 4), position: 1 };
    const north = options.second === "north";
    second!.staging = { version: 1, keys: standing(north ? NORTH : SOUTH, second!.durationSec ?? 6), position: north ? 2 : 1 };
  }
  if (options.plan !== false) world.placePlans = [vigilPlan()];
  return state;
}

export function planScene(state: ClientState): SceneRecord {
  return state.world!.productions.find((production) => production.meta.id === "saltlight")!.scenes.find((scene) => scene.id === "sc_04")!;
}
