import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isGraphScene, orderedShots, SceneRecordSchema, type SceneRecord } from "@arke-studio/contracts";
import { restoreScene } from "../../src/productions/ops.js";
import {
  applySceneCommand,
  SceneVersionMoved,
  type SceneCommand,
} from "../../src/productions/scene-commands.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Semantic scene commands replace the retired whole-scene writer. They still persist one
 * complete record atomically, cut history, fence stale edits, and leave restore as a new version.
 */

const CLOCK = () => "2026-08-21T12:00:00.000Z";
const PRODUCTION = "saltlight";
const SCENE_ID = "sc_04";
const STEM = "04-the-verse-rises";
const PATH = `productions/${PRODUCTION}/scenes/${STEM}.json`;

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

async function readSceneFile(dir: string): Promise<SceneRecord> {
  return SceneRecordSchema.parse(JSON.parse(await readFile(join(dir, ...PATH.split("/")), "utf8")));
}

async function apply(store: WorldStore, record: SceneRecord, command: SceneCommand): Promise<void> {
  await applySceneCommand(store, {
    productionId: PRODUCTION,
    sceneFile: STEM,
    sceneId: record.id,
    baseVersion: record.version,
    command,
  });
}

describe("semantic scene persistence", () => {
  it("a command writes one complete graph record, cuts a version, and snapshots history", async () => {
    const { dir, store } = await open();
    const before = await readSceneFile(dir);
    const target = orderedShots(before)[0]!;

    await apply(store, before, {
      kind: "edit-shot",
      shotId: target.id,
      change: {
        description: "She grips the rail and does not move.",
        framing: { size: "Close-up" },
      },
    });

    const after = await readSceneFile(dir);
    assert.ok(isGraphScene(after), "the whole persisted record has one graph authority");
    assert.equal(after.version, before.version + 1);
    assert.equal(orderedShots(after)[0]!.framing?.size, "Close-up");
    assert.deepEqual(orderedShots(after).slice(1), orderedShots(before).slice(1), "unnamed shots stay byte-for-field intact");
    await access(join(dir, ".history", "productions", PRODUCTION, "scenes", STEM, `v${after.version}.json`));
  });

  it("a command against a moved base is refused, not merged, and says so in versions", async () => {
    const { dir, store } = await open();
    const before = await readSceneFile(dir);

    await assert.rejects(
      applySceneCommand(store, {
        productionId: PRODUCTION,
        sceneFile: STEM,
        sceneId: SCENE_ID,
        baseVersion: before.version - 1,
        command: { kind: "edit-scene", synopsis: "written against yesterday" },
      }),
      (error: unknown) =>
        error instanceof SceneVersionMoved &&
        error.expected === before.version - 1 &&
        error.found === before.version,
    );
    const after = await readSceneFile(dir);
    assert.equal(after.version, before.version, "nothing was written");
    assert.equal(after.synopsis, undefined);
  });

  it("restore brings a prior command version back as a new version and keeps later history", async () => {
    const { dir, store } = await open();
    const base = await readSceneFile(dir);
    await apply(store, base, { kind: "edit-scene", synopsis: "the keeper" });
    const kept = await readSceneFile(dir);
    await apply(store, kept, { kind: "edit-scene", synopsis: "the regretted" });

    await restoreScene(store, { productionId: PRODUCTION, sceneFile: STEM, version: kept.version });

    const after = await readSceneFile(dir);
    assert.equal(after.version, kept.version + 2, "restore is a new version, not a rewind");
    assert.equal(after.synopsis, "the keeper");
    await access(join(dir, ".history", "productions", PRODUCTION, "scenes", STEM, `v${kept.version + 1}.json`));
  });

  it("an explicit semantic clear removes the field rather than merging the old value back", async () => {
    const { dir, store } = await open();
    const base = await readSceneFile(dir);
    await apply(store, base, { kind: "edit-scene", synopsis: "a line to be regretted" });
    const withSynopsis = await readSceneFile(dir);
    await apply(store, withSynopsis, { kind: "edit-scene", synopsis: null });

    const after = await readSceneFile(dir);
    assert.equal(after.synopsis, undefined);
    assert.equal(after.version, withSynopsis.version + 1);
  });

  it("a scene file name that walks out of the scenes directory is refused by name", async () => {
    const { store } = await open();
    for (const stem of ["../meta", "..\\..\\bible", "a/b", "a\\b", ".hidden", ""]) {
      await assert.rejects(
        applySceneCommand(store, {
          productionId: PRODUCTION,
          sceneFile: stem,
          sceneId: SCENE_ID,
          baseVersion: 1,
          command: { kind: "edit-scene", synopsis: null },
        }),
        /scene file/i,
      );
      await assert.rejects(restoreScene(store, { productionId: PRODUCTION, sceneFile: stem, version: 1 }));
    }
  });
});
