import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, SceneRecordSchema, type ScenePlate, type SceneRecord } from "@arke-studio/contracts";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { STAGE_KIT_SCHEMA_VERSION, STAGE_LOOK_SCHEMA_VERSION, STAGE_PLATE_SCHEMA_VERSION } from "../../src/productions/scene-record.js";
import { SUPPORTED_SCHEMA_VERSION } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/** The location plate on the scene's blocking (issue 1818, design turn 229c). */

const CLOCK = () => "2026-10-17T09:00:00.000Z";
const PRODUCTION = "saltlight";
const SCENE = "04-the-verse-rises";
const SCENE_ID = "sc_04";
const PLATE: ScenePlate = {
  source: { source: "artifact", artifactId: "ar_01J8G0000000000000000000A2", hash: "sha256:fedcba9876543210" },
  label: "Lobby",
  shotId: "sh_12",
};

async function open(): Promise<WorldStore> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}
async function sceneOnDisk(store: WorldStore): Promise<SceneRecord> {
  return SceneRecordSchema.parse(JSON.parse(await readFile(join(store.dir, "productions", PRODUCTION, "scenes", `${SCENE}.json`), "utf8")));
}
const edit = (store: WorldStore, baseVersion: number, shotId: string, blocking: unknown) =>
  applySceneCommand(store, { productionId: PRODUCTION, sceneFile: SCENE, sceneId: SCENE_ID, baseVersion, command: { kind: "edit-stage", shotId, blocking } as never });

describe("the location plate (issue 1818)", () => {
  it("lands on the scene's blocking and fences the world at the plate's schema", async () => {
    const store = await open();
    assert.ok(SUPPORTED_SCHEMA_VERSION >= STAGE_PLATE_SCHEMA_VERSION, "this build reads what it writes");
    const before = await sceneOnDisk(store);
    const shotId = orderedShots(before)[0]!.id;
    await edit(store, before.version, shotId, { cast: [], sets: [], plate: { ...PLATE, shotId } });
    const after = await sceneOnDisk(store);
    assert.deepEqual(after.blocking?.plate, { ...PLATE, shotId });
    assert.equal(store.getBundle().meta.schemaVersion, STAGE_PLATE_SCHEMA_VERSION, "an older build refuses a world it would drop the scene from");
  });

  it("refuses another production's picture, whatever a picker offered (SPEC-020 R-13)", async () => {
    const store = await open();
    const before = await sceneOnDisk(store);
    const shotId = orderedShots(before)[0]!.id;
    const elsewhere = { id: "ar_01J8G0000000000000000000B7", kind: "image", file: "elsewhere.png", hash: "sha256:0011", production: "another", origin: { by: "user" }, links: [], created: CLOCK() };
    store.getBundle().artifacts.push(elsewhere as never);
    await assert.rejects(
      edit(store, before.version, shotId, { cast: [], sets: [], plate: { ...PLATE, shotId, source: { source: "artifact", artifactId: elsewhere.id, hash: elsewhere.hash } } }),
      (error: unknown) => /belongs to another production/.test(JSON.stringify((error as { reasons?: unknown }).reasons ?? String(error))),
    );
    assert.equal((await sceneOnDisk(store)).blocking?.plate, undefined);
  });

  it("is kept by a blocking edit that does not mention it, and taken off only by null", async () => {
    const store = await open();
    const first = await sceneOnDisk(store);
    const shotId = orderedShots(first)[0]!.id;
    await edit(store, first.version, shotId, { cast: [], sets: [], plate: PLATE });
    const planted = await sceneOnDisk(store);
    await edit(store, planted.version, shotId, { cast: [{ sheetId: "maren-kest", x: 1, z: 0 }], sets: [{ name: "rail", x: 0, z: -2, w: 4, h: 1, d: .2 }] });
    const moved = await sceneOnDisk(store);
    assert.deepEqual(moved.blocking?.plate, PLATE, "moving marks never drops the plate");
    assert.equal(moved.blocking?.cast[0]?.x, 1);
    await edit(store, moved.version, shotId, { cast: moved.blocking!.cast, sets: moved.blocking!.sets, plate: null });
    assert.equal((await sceneOnDisk(store)).blocking?.plate, undefined);
  });
});

describe("the set kit (issue 1819)", () => {
  it("lands a kit item on the scene's blocking and fences the world at the kit's schema", async () => {
    const store = await open();
    assert.ok(SUPPORTED_SCHEMA_VERSION >= STAGE_KIT_SCHEMA_VERSION, "this build reads what it writes");
    const before = await sceneOnDisk(store);
    const shotId = orderedShots(before)[0]!.id;
    const room = { name: "lobby", x: 0, z: 0, w: 8, h: 5, d: 12, solid: true, kit: { kind: "room", open: ["front"] } };
    await edit(store, before.version, shotId, { cast: [], sets: [room] });
    assert.deepEqual((await sceneOnDisk(store)).blocking?.sets, [room], "the item is one entry; its walls are derived, never stored");
    assert.ok(store.getBundle().meta.schemaVersion >= STAGE_KIT_SCHEMA_VERSION);
  });
});

describe("the scene's lights and atmosphere (issue 1825)", () => {
  it("are kept by a blocking edit that does not mention them, taken off by null, and fence the world", async () => {
    const store = await open();
    const first = await sceneOnDisk(store);
    const shotId = orderedShots(first)[0]!.id;
    const lights = [{ name: "niche wash", kind: "spot", colour: "#ffb35c", kelvin: 3200, strength: 14, reach: 8, x: 0.3, y: 3.6, z: -5.2, aim: "planter" }];
    const atmosphere = { time: "night", haze: 0.02 };
    await edit(store, first.version, shotId, { cast: [], sets: [], lights, atmosphere });
    const lit = await sceneOnDisk(store);
    assert.deepEqual(lit.blocking?.lights, lights);
    assert.deepEqual(lit.blocking?.atmosphere, atmosphere);
    assert.ok(store.getBundle().meta.schemaVersion >= STAGE_LOOK_SCHEMA_VERSION);
    await edit(store, lit.version, shotId, { cast: [{ sheetId: "maren-kest", x: 0, z: 0 }], sets: [] });
    const moved = await sceneOnDisk(store);
    assert.deepEqual(moved.blocking?.lights, lights, "moving marks keeps the lights");
    assert.deepEqual(moved.blocking?.atmosphere, atmosphere);
    await edit(store, moved.version, shotId, { cast: moved.blocking!.cast, sets: [], lights: null, atmosphere: null });
    const dark = await sceneOnDisk(store);
    assert.equal(dark.blocking?.lights, undefined);
    assert.equal(dark.blocking?.atmosphere, undefined);
  });
});
