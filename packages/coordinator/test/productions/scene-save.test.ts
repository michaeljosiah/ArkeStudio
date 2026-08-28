import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectSceneRecord, SceneRecordSchema } from "@arke-studio/contracts";
import { restoreScene, saveScene, SceneStaleError } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Turn 97: a hand edit saves where it stands — the Bible's model (master §4.5) applied to scenes.
 * Every save cuts a version with a history snapshot; a save against a moved base is refused,
 * not merged; and v<n> can come back as a new version with nothing between lost.
 */

const CLOCK = () => "2026-08-21T12:00:00.000Z";
const STEM = "04-the-verse-rises";
const PATH = `productions/saltlight/scenes/${STEM}.json`;

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

/**
 * The file as the app reads it: the R-1 union, projected to the legacy shape (SPEC-029).
 *
 * Every save below now lands a graph scene, so reading with the legacy schema alone would fail
 * on the shape rather than on anything these tests are about. What they are about — the version,
 * the snapshot, the pinned identity, the cleared field — is the authored content, and the
 * projection is where that content is the same either side of the migration.
 */
async function readSceneFile(dir: string) {
  const raw = JSON.parse(await readFile(join(dir, ...PATH.split("/")), "utf8")) as unknown;
  const projection = projectSceneRecord(SceneRecordSchema.parse(raw));
  if (projection.kind !== "scene") throw new Error(projection.findings.map((f) => f.message).join(" "));
  return projection.scene;
}

describe("scene direct save (turn 97)", () => {
  it("a save cuts a version, snapshots history, and keeps the widened fields", async () => {
    const { dir, store } = await open();
    const before = await readSceneFile(dir);
    const edited = {
      ...before,
      synopsis: "Maren hears the verse under the harbour.",
      defaults: { size: "Medium", lighting: "Blue hour" },
      shots: before.shots.map((s, i) =>
        i === 0 ? { ...s, description: "She grips the rail and does not move.", framing: { size: "Close-up" } } : s,
      ),
    };
    await saveScene(store, { productionId: "saltlight", sceneFile: STEM, scene: edited, baseVersion: before.version });

    const after = await readSceneFile(dir);
    assert.equal(after.version, before.version + 1, "the committer stamps the next version");
    assert.equal(after.synopsis, "Maren hears the verse under the harbour.");
    assert.equal(after.defaults?.size, "Medium");
    assert.equal(after.shots[0]!.framing?.size, "Close-up");
    await access(join(dir, ".history", "productions", "saltlight", "scenes", STEM, `v${after.version}.json`));
  });

  it("a save against a moved base is refused, not merged — and says so in versions", async () => {
    const { dir, store } = await open();
    const before = await readSceneFile(dir);
    await assert.rejects(
      saveScene(store, {
        productionId: "saltlight",
        sceneFile: STEM,
        scene: { ...before, synopsis: "written against yesterday" },
        baseVersion: before.version - 1,
      }),
      (e: unknown) => e instanceof SceneStaleError && e.expected === before.version - 1 && e.found === before.version,
    );
    const after = await readSceneFile(dir);
    assert.equal(after.version, before.version, "nothing was written");
    assert.equal(after.synopsis, undefined);
  });

  it("identity is not the editor's to change: id, number and slug stay pinned to the file", async () => {
    const { dir, store } = await open();
    const before = await readSceneFile(dir);
    await saveScene(store, {
      productionId: "saltlight",
      sceneFile: STEM,
      scene: { ...before, id: "sc_99", number: 99, slug: "hijacked", title: "Renamed fine" },
      baseVersion: before.version,
    });
    const after = await readSceneFile(dir);
    assert.equal(after.id, before.id);
    assert.equal(after.number, before.number);
    assert.equal(after.slug, before.slug);
    assert.equal(after.title, "Renamed fine", "everything that is the editor's to change still lands");
  });

  it("restore brings v<n> back as a new version; the versions between stay in history", async () => {
    const { dir, store } = await open();
    const v = (await readSceneFile(dir)).version;
    const base = await readSceneFile(dir);
    await saveScene(store, {
      productionId: "saltlight",
      sceneFile: STEM,
      scene: { ...base, synopsis: "the keeper" },
      baseVersion: v,
    });
    const kept = await readSceneFile(dir);
    await saveScene(store, {
      productionId: "saltlight",
      sceneFile: STEM,
      scene: { ...kept, synopsis: "the regretted" },
      baseVersion: kept.version,
    });

    await restoreScene(store, { productionId: "saltlight", sceneFile: STEM, version: kept.version });
    const after = await readSceneFile(dir);
    assert.equal(after.version, kept.version + 2, "restore is a new version, not a rewind");
    assert.equal(after.synopsis, "the keeper");
    await access(join(dir, ".history", "productions", "saltlight", "scenes", STEM, `v${kept.version + 1}.json`));
  });

  it("a payload that fails the scene schema is refused whole", async () => {
    const { dir, store } = await open();
    const before = await readSceneFile(dir);
    await assert.rejects(
      saveScene(store, {
        productionId: "saltlight",
        sceneFile: STEM,
        scene: { ...before, shots: [{ id: "sh_1" }] },
        baseVersion: before.version,
      }),
    );
    assert.equal((await readSceneFile(dir)).version, before.version);
  });

  it("a save is a replacement, not a merge: a cleared field stays cleared (review 2026-08-22)", async () => {
    // JsonFile.set is a shallow merge, so a save that REMOVED a field resurrected it from the
    // old document — clearing the synopsis put the old sentence straight back, forever.
    const { dir, store } = await open();
    const base = await readSceneFile(dir);
    await saveScene(store, {
      productionId: "saltlight",
      sceneFile: STEM,
      scene: { ...base, synopsis: "a line to be regretted" },
      baseVersion: base.version,
    });
    const withSynopsis = await readSceneFile(dir);
    const { synopsis: _cleared, ...cleared } = withSynopsis;
    await saveScene(store, {
      productionId: "saltlight",
      sceneFile: STEM,
      scene: cleared,
      baseVersion: withSynopsis.version,
    });
    const after = await readSceneFile(dir);
    assert.equal(after.synopsis, undefined, "what the person deleted stays deleted");
    assert.equal(after.version, withSynopsis.version + 1);
  });

  it("a scene file name that walks out of the scenes directory is refused by name", async () => {
    // The stem lands in a path join on a loopback socket any local process can reach — so
    // "..\\..\\meta" was a world-wide write primitive until the guard (review 2026-08-22).
    const { dir, store } = await open();
    const before = await readSceneFile(dir);
    for (const stem of ["../meta", "..\\..\\bible", "a/b", "a\\b", ".hidden", ""]) {
      await assert.rejects(
        saveScene(store, { productionId: "saltlight", sceneFile: stem, scene: before, baseVersion: before.version }),
        /scene file|refused|not a scene file/i,
      );
      await assert.rejects(restoreScene(store, { productionId: "saltlight", sceneFile: stem, version: 1 }));
    }
  });
});
