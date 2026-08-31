import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EpisodeSchema, type Routing } from "@arke-studio/contracts";
import { deleteScene, SceneDeleteRefused } from "../../src/productions/ops.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { saveRouting } from "../../src/productions/interactive.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { legacySceneView } from "@arke-studio/contracts";

/**
 * Removing a scene, and refusing to when something still needs it.
 *
 * The gap round 3 found from the other side: a scene made by accident had no way out and lived
 * in the production for good. Deleting one is easy; deleting one safely is the work — a take is
 * money already spent, a branch-map edge is a promise to a viewer, and an episode that lists a
 * scene which no longer exists is the exact defect the wrap-up guard now refuses.
 */

const CLOCK = () => "2026-08-22T12:00:00.000Z";
const STEM = "04-the-verse-rises";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

const scenePath = (dir: string) => join(dir, "productions", "saltlight", "scenes", `${STEM}.json`);

describe("deleting a scene (round 3's other gap)", () => {
  it("takes the file, and history keeps it", async () => {
    const { dir, store } = await open();
    const before = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const scene = legacySceneView(before.scenes.find((s) => s.id === "sc_04")!);
    // The fixture's shot carries an accepted take; reject it by clearing the selection first,
    // which is exactly what the refusal below tells a person to do.
    await applySceneCommand(store, {
      productionId: "saltlight",
      sceneFile: STEM,
      sceneId: scene.id,
      baseVersion: scene.version,
      command: { kind: "edit-scene", synopsis: scene.synopsis ?? null },
    });
    const cleared = await clearSelections(store, dir);
    assert.ok(cleared, "the fixture's selections were cleared for this test");

    await deleteScene(store, { productionId: "saltlight", sceneFile: STEM });

    await assert.rejects(() => access(scenePath(dir)), "the file is gone");
    const after = await scanWorld(dir);
    const production = after.bundle.productions.find((p) => p.meta.id === "saltlight")!;
    assert.ok(!production.scenes.some((s) => s.id === "sc_04"), "and the world no longer holds it");
    assert.deepEqual(after.problems, [], "the world still scans clean");
    // History is the undo: the last version is still on the shelf.
    await access(join(dir, ".history", "productions", "saltlight", "scenes", STEM));
  });

  it("refuses while a shot has an accepted take, and names the shot", async () => {
    const { store } = await open();
    await assert.rejects(
      deleteScene(store, { productionId: "saltlight", sceneFile: STEM }),
      (err: unknown) => {
        assert.ok(err instanceof SceneDeleteRefused);
        assert.match(err.message, /shot 12/, "the shot is named, not just counted");
        assert.match(err.message, /reject it first/, "and the way out is stated");
        return true;
      },
    );
  });

  it("refuses while the branch map still names it, and says which edge", async () => {
    const { dir, store } = await open();
    await clearSelections(store, dir);
    const routing: Routing = {
      version: 1,
      start: "sc_02",
      choices: [{ id: "ch_on", from: "sc_02", label: "Go to the verse", to: "sc_04" }],
      endings: [],
      excluded: [],
      groups: [],
    };
    await saveRouting(store, "saltlight", routing);
    await assert.rejects(
      deleteScene(store, { productionId: "saltlight", sceneFile: STEM }),
      (err: unknown) => {
        assert.ok(err instanceof SceneDeleteRefused);
        assert.match(err.message, /branch map/);
        assert.match(err.message, /Go to the verse/, "the edge is quoted in the words the player reads");
        return true;
      },
    );
  });

  it("leaves no episode listing a scene that no longer exists", async () => {
    // The wrap-up guard refuses a membership naming a scene nobody made; deletion must not
    // create that state from the other direction.
    const { dir, store } = await open();
    await clearSelections(store, dir);
    const episodePath = "productions/saltlight/episodes/the-first-night.json";
    await store.commit({
      kind: "episode-edit",
      source: "form",
      files: [
        {
          path: episodePath,
          action: "create",
          content:
            JSON.stringify(
              EpisodeSchema.parse({
                id: "ep_the-first-night",
                version: 1,
                order: 1,
                title: "The first night",
                scenes: ["sc_02", "sc_04", "sc_06"],
              }),
              null,
              2,
            ) + "\n",
          baseHash: null,
        },
      ],
    });

    await deleteScene(store, { productionId: "saltlight", sceneFile: STEM });

    const after = await scanWorld(dir);
    const episode = after.bundle.productions
      .find((p) => p.meta.id === "saltlight")!
      .episodes.find((e) => e.id === "ep_the-first-night")!;
    assert.deepEqual(episode.scenes, ["sc_02", "sc_06"], "the deleted scene left the membership");
    assert.equal(episode.version, 2, "and the episode cut a version, so the removal is undoable");
  });

  it("clears the selections its shots carried, and leaves every other shot's alone", async () => {
    const { dir, store } = await open();
    await clearSelections(store, dir);
    // A selection with no acceptance — a trim — does not block the delete, but must not survive.
    await store.commit({
      kind: "selection-set",
      source: "form",
      files: [
        {
          path: "productions/saltlight/selections.json",
          action: "replace",
          content: JSON.stringify({ sh_12: { trimInSec: 2 }, sh_99: { trimInSec: 1 } }, null, 2) + "\n",
          baseHash: await hashOf(store, dir, "productions/saltlight/selections.json"),
        },
      ],
    });

    await deleteScene(store, { productionId: "saltlight", sceneFile: STEM });

    const raw = await readFile(join(dir, "productions", "saltlight", "selections.json"), "utf8");
    const selections = JSON.parse(raw) as Record<string, unknown>;
    assert.ok(!("sh_12" in selections), "the deleted scene's shot took its selection with it");
    assert.ok("sh_99" in selections, "and nothing else was touched");
  });

  it("a scene file name that walks out of the scenes directory is refused by name", async () => {
    const { store } = await open();
    for (const stem of ["../meta", "..\\..\\bible", "a/b", "", "."]) {
      await assert.rejects(deleteScene(store, { productionId: "saltlight", sceneFile: stem }));
    }
  });
});

/** Empty selections.json so the accepted-take guard is out of the way; true if it changed. */
async function clearSelections(store: WorldStore, dir: string): Promise<boolean> {
  const path = "productions/saltlight/selections.json";
  const before = await readFile(join(dir, ...path.split("/")), "utf8").catch(() => null);
  if (before === null || before.trim() === "{}") return false;
  await store.commit({
    kind: "selection-set",
    source: "form",
    files: [{ path, action: "replace", content: "{}\n", baseHash: await hashOf(store, dir, path) }],
  });
  return true;
}

async function hashOf(_store: WorldStore, dir: string, path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const raw = await readFile(join(dir, ...path.split("/")), "utf8");
  return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}
