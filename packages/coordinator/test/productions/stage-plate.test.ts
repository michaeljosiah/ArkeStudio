import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, SceneRecordSchema, type ScenePlate, type SceneRecord } from "@arke-studio/contracts";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { STAGE_PLATE_SCHEMA_VERSION } from "../../src/productions/scene-record.js";
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
