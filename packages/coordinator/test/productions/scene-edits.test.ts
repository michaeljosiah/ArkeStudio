import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SceneRecordSchema } from "@arke-studio/contracts";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { applySceneEdits, SceneEditRefused, sceneVersionFor } from "../../src/productions/scene-edits.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Arke's rename, landed straight in (SPEC-036 R-38).
 *
 * What each test asks: does the rename go through the header's own write, is it fenced by the
 * version the prompt showed, and is every refusal worded for the one corrective turn rather than
 * left as a stack trace.
 */

const CLOCK = () => "2026-09-02T12:00:00.000Z";
const PRODUCTION = "saltlight";
const SCENE = "sc_04";
const THREAD = { kind: "scene", productionId: PRODUCTION, sceneId: SCENE } as const;

async function open(): Promise<{ dir: string; store: WorldStore }> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir: store.dir, store };
}

async function sceneOnDisk(store: WorldStore) {
  const stem = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.sceneFiles[SCENE]!;
  return SceneRecordSchema.parse(JSON.parse(await readFile(join(store.dir, "productions", PRODUCTION, "scenes", `${stem}.json`), "utf8")));
}

describe("a rename from the dock lands through edit-scene (SPEC-036 R-38)", () => {
  it("reads the version the prompt will show, and renames against it", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const shown = sceneVersionFor(store, THREAD);
    assert.equal(shown, before.version, "the fence is the version on disk when the prompt is built");

    await applySceneEdits(store, { entryContext: THREAD, edits: [{ kind: "rename", title: "The tide answers" }], baseVersion: shown });

    const after = await sceneOnDisk(store);
    assert.equal(after.title, "The tide answers");
    assert.equal(after.version, before.version + 1, "one version cut, like a rename typed in the header");
    assert.equal(after.synopsis, before.synopsis, "and nothing else about the scene moved");
  });

  it("refuses when the scene moved between the prompt and the answer, and says so for the retry", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const shown = sceneVersionFor(store, THREAD)!;
    // Someone renames it in the header while the model is still writing.
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.sceneFiles[SCENE]!,
      sceneId: SCENE,
      baseVersion: before.version,
      command: { kind: "edit-scene", title: "Typed by hand" },
    });

    await assert.rejects(
      applySceneEdits(store, { entryContext: THREAD, edits: [{ kind: "rename", title: "From the model" }], baseVersion: shown }),
      (err: unknown) => err instanceof SceneEditRefused && /changed while you were answering/.test(err.message),
    );
    assert.equal((await sceneOnDisk(store)).title, "Typed by hand", "the hand-typed name stood");
  });

  it("refuses a thread that is not about a scene, and a scene the production does not hold", async () => {
    const { store } = await open();
    await assert.rejects(
      applySceneEdits(store, { entryContext: { kind: "production", productionId: PRODUCTION }, edits: [{ kind: "rename", title: "x" }], baseVersion: 1 }),
      (err: unknown) => err instanceof SceneEditRefused && /own scene thread/.test(err.message),
    );
    assert.equal(sceneVersionFor(store, { kind: "production", productionId: PRODUCTION }), null);
    await assert.rejects(
      applySceneEdits(store, {
        entryContext: { kind: "scene", productionId: PRODUCTION, sceneId: "sc_nowhere" },
        edits: [{ kind: "rename", title: "x" }],
        baseVersion: 1,
      }),
      (err: unknown) => err instanceof SceneEditRefused && /could not be found/.test(err.message),
    );
  });

  it("a dry run checks the fence and writes nothing, so the runner can ask before the bible is touched (codex, PR 716)", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const shown = sceneVersionFor(store, THREAD)!;
    await applySceneEdits(store, { entryContext: THREAD, edits: [{ kind: "rename", title: "Checked only" }], baseVersion: shown, dryRun: true });
    assert.deepEqual(await sceneOnDisk(store), before, "nothing on disk moved");
    await assert.rejects(
      applySceneEdits(store, { entryContext: THREAD, edits: [{ kind: "rename", title: "Checked only" }], baseVersion: shown + 1, dryRun: true }),
      (err: unknown) => err instanceof SceneEditRefused && /changed while you were answering/.test(err.message),
      "and a fence that does not match refuses in the same words the write would",
    );
  });

  it("does nothing at all for a turn that carries no edit", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    await applySceneEdits(store, { entryContext: THREAD, edits: [], baseVersion: null });
    assert.deepEqual(await sceneOnDisk(store), before);
  });
});
