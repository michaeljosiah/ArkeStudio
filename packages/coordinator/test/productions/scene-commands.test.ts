import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { linearizeSceneFlow, orderedShots, SceneRecordSchema, type SceneRecord } from "@arke-studio/contracts";
import {
  applySceneCommand,
  sceneCommandFrom,
  SceneCommandRefused,
  SceneVersionMoved,
} from "../../src/productions/scene-commands.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { sha256 } from "../../src/world/text-files.js";

/**
 * The semantic scene commands (SPEC-029 R-36, R-39, R-61, R-62; T-9, T-10, T-11).
 *
 * What each test is really asking: did exactly one named thing happen, did identity survive it,
 * and — the one that matters most — does a refusal leave the world byte-identical rather than
 * half-edited.
 */

const CLOCK = () => "2026-08-30T09:00:00.000Z";
const PRODUCTION = "saltlight";
const SCENE = "04-the-verse-rises";
const SCENE_ID = "sc_04";

async function open(): Promise<{ dir: string; store: WorldStore }> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir: store.dir, store };
}

async function sceneOnDisk(store: WorldStore, stem = SCENE): Promise<SceneRecord> {
  const raw = await readFile(join(store.dir, "productions", PRODUCTION, "scenes", `${stem}.json`), "utf8");
  return SceneRecordSchema.parse(JSON.parse(raw));
}

/** Every byte of the world that a command could plausibly touch, as one comparable value. */
async function worldPrint(dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // `.git`-like bookkeeping moves on its own schedule; the journal records the commits we
      // are asserting about, so both are excluded deliberately rather than by accident.
      if (entry.name === ".journal" || entry.name === ".index" || entry.name === ".history") continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      const info = await stat(full);
      parts.push(`${prefix}${entry.name} ${info.size}`);
      if (entry.name.endsWith(".json")) parts.push(await readFile(full, "utf8"));
    }
  };
  await walk(dir, "");
  return parts.join("\n");
}

const shotIds = (record: SceneRecord): string[] => orderedShots(record).map((shot) => shot.id);

const nodeIdOf = (record: SceneRecord, shotId: string): string => {
  const sequence = linearizeSceneFlow(record);
  assert.ok(sequence.kind === "linear");
  return sequence.shots.find((pair) => pair.shot.id === shotId)!.nodeId;
};

describe("insert, move and duplicate keep identity and refuse a stale version (T-9)", () => {
  it("inserts on the edge the anchor names, minting an id past the whole production", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const held = shotIds(before);
    const heldNodes = held.map((id) => nodeIdOf(before, id));

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: {
        kind: "insert-shot",
        at: { after: held[1]! },
        shot: {
          title: "The lamp gutters",
          description: "The wick drowns and the room goes to blue.",
          durationSec: 3,
        },
      },
    });

    const after = await sceneOnDisk(store);
    const ids = shotIds(after);
    assert.equal(ids.length, held.length + 1);
    assert.equal(ids[2]?.startsWith("sh_"), true);
    assert.ok(!held.includes(ids[2]!), "the new shot's id is one nothing else in the world holds");
    assert.deepEqual([...ids.slice(0, 2), ...ids.slice(3)], held, "every other shot kept its place");
    // Identity, not position: the surviving shots keep the node ids groups and references name.
    assert.deepEqual(held.map((id) => nodeIdOf(after, id)), heldNodes);
    assert.deepEqual(
      orderedShots(after).map((shot) => shot.number),
      [1, 2, 3, 4, 5],
      "numbers are display order and are renumbered, so no two shots read as the same one",
    );
  });

  it("moves a shot to where the anchor says, not one place short of it", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const held = shotIds(before);
    const mover = held[0]!;
    const nodeBefore = nodeIdOf(before, mover);

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      // A forward move: resolving the anchor against the ORIGINAL list would land it before the
      // target instead of after it, which is the off-by-one this asserts against.
      command: { kind: "move-shot", shotId: mover, to: { after: held[2]! } },
    });

    const after = await sceneOnDisk(store);
    assert.deepEqual(shotIds(after), [held[1]!, held[2]!, mover, held[3]!]);
    assert.equal(nodeIdOf(after, mover), nodeBefore, "a move keeps the shot's node id");
  });

  it("duplicates the authored beat and never its output", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const source = orderedShots(before)[0]!;

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: { kind: "duplicate-shot", shotId: source.id },
    });

    const after = await sceneOnDisk(store);
    const copy = orderedShots(after)[1]!;
    assert.notEqual(copy.id, source.id, "a fresh id, so nothing that pointed at the original follows");
    assert.equal(copy.description, source.description);
    assert.equal(copy.covers, undefined, "and no claim on footage it has no relationship to");
  });

  it("refuses against a version that has moved, and writes nothing (R-62)", async () => {
    const { dir, store } = await open();
    const before = await sceneOnDisk(store);
    const print = await worldPrint(dir);

    await assert.rejects(
      () =>
        applySceneCommand(store, {
          productionId: PRODUCTION,
          sceneFile: SCENE,
          sceneId: SCENE_ID,
          baseVersion: before.version + 5,
          command: { kind: "delete-shot", shotId: shotIds(before)[0]! },
        }),
      SceneVersionMoved,
    );
    assert.equal(await worldPrint(dir), print, "the world is byte-identical after a refusal");
  });
});

describe("board overrides are keyed by shot id and versioned like every other command (T-10)", () => {
  it("sets a split, replaces it with a merge, and clears it back to nothing", async () => {
    const { store } = await open();
    const first = await sceneOnDisk(store);
    const target = shotIds(first)[2]!;

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: first.version,
      command: { kind: "set-board-override", shotId: target, override: "split" },
    });
    const split = await sceneOnDisk(store);
    assert.deepEqual(split.boards?.splits, [target]);
    assert.deepEqual(split.boards?.merges, []);

    // The opposite answer to the same question: setting one clears the other, or the packer's
    // walk would depend on which list it read first.
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: split.version,
      command: { kind: "set-board-override", shotId: target, override: "merge" },
    });
    const merged = await sceneOnDisk(store);
    assert.deepEqual(merged.boards?.splits, []);
    assert.deepEqual(merged.boards?.merges, [target]);

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: merged.version,
      command: { kind: "clear-board-override", shotId: target, override: "merge" },
    });
    assert.equal((await sceneOnDisk(store)).boards, undefined, "nothing left to say is absent, not empty");
  });

  it("refuses a break before the first shot, which would divide nothing", async () => {
    const { dir, store } = await open();
    const before = await sceneOnDisk(store);
    const print = await worldPrint(dir);
    await assert.rejects(
      () =>
        applySceneCommand(store, {
          productionId: PRODUCTION,
          sceneFile: SCENE,
          sceneId: SCENE_ID,
          baseVersion: before.version,
          command: { kind: "set-board-override", shotId: shotIds(before)[0]!, override: "split" },
        }),
      /divide nothing/,
    );
    assert.equal(await worldPrint(dir), print);
  });

  it("an override survives an insert above it, because it is keyed by shot id not position", async () => {
    const { store } = await open();
    const first = await sceneOnDisk(store);
    const target = shotIds(first)[2]!;
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: first.version,
      command: { kind: "set-board-override", shotId: target, override: "split" },
    });
    const split = await sceneOnDisk(store);
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: split.version,
      command: {
        kind: "insert-shot",
        at: { atStart: true },
        shot: { title: "A held breath", description: "Nothing moves.", durationSec: 2 },
      },
    });
    assert.deepEqual(
      (await sceneOnDisk(store)).boards?.splits,
      [target],
      "the break is still before the same shot, not before whatever is third now",
    );
  });
});

describe("deletion names every blocker and cleans up atomically (T-11)", () => {
  it("refuses a shot with an accepted take, by name, writing nothing", async () => {
    const { dir, store } = await open();
    const before = await sceneOnDisk(store);
    const print = await worldPrint(dir);
    // The fixture accepts a clip on sh_12.
    await assert.rejects(
      () =>
        applySceneCommand(store, {
          productionId: PRODUCTION,
          sceneFile: SCENE,
          sceneId: SCENE_ID,
          baseVersion: before.version,
          command: { kind: "delete-shot", shotId: "sh_12" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SceneCommandRefused);
        assert.match(error.message, /accepted take/);
        return true;
      },
    );
    assert.equal(await worldPrint(dir), print, "a refused delete leaves the world byte-identical");
  });

  it("deletes an unencumbered shot and drops its selection in the same commit", async () => {
    const { dir, store } = await open();
    const before = await sceneOnDisk(store);
    const target = shotIds(before).at(-1)!;

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: { kind: "delete-shot", shotId: target },
    });

    const after = await sceneOnDisk(store);
    assert.ok(!shotIds(after).includes(target));
    assert.deepEqual(
      orderedShots(after).map((shot) => shot.number),
      [1, 2, 3],
    );
    const selections = JSON.parse(
      await readFile(join(dir, "productions", PRODUCTION, "selections.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(target in selections, false, "no selection is left keyed by a shot that is gone");
  });

  it("drops the deleted shot's board override rather than leaving a hint pointing at nothing", async () => {
    const { store } = await open();
    const first = await sceneOnDisk(store);
    const target = shotIds(first).at(-1)!;
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: first.version,
      command: { kind: "set-board-override", shotId: target, override: "split" },
    });
    const split = await sceneOnDisk(store);
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: split.version,
      command: { kind: "delete-shot", shotId: target },
    });
    assert.equal((await sceneOnDisk(store)).boards, undefined);
  });

  it("refuses a shot that is not in the scene, naming it", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    await assert.rejects(
      () =>
        applySceneCommand(store, {
          productionId: PRODUCTION,
          sceneFile: SCENE,
          sceneId: SCENE_ID,
          baseVersion: before.version,
          command: { kind: "delete-shot", shotId: "sh_999" },
        }),
      /sh_999/,
    );
  });
});

describe("an edit is a patch on one shot, and everything else is untouched", () => {
  it("changes the named fields, keeps the rest, and moves nothing", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const target = orderedShots(before)[1]!;

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: { kind: "edit-shot", shotId: target.id, change: { durationSec: 9 } },
    });

    const after = await sceneOnDisk(store);
    const edited = orderedShots(after)[1]!;
    assert.equal(edited.durationSec, 9);
    assert.equal(edited.description, target.description, "a patch, not a rewrite");
    assert.equal(edited.title, target.title);
    assert.deepEqual(shotIds(after), shotIds(before), "an edit is not a move");
    assert.equal(nodeIdOf(after, target.id), nodeIdOf(before, target.id));
  });
});

describe("the fence names a scene, not a filename (codex round on #653)", () => {
  it("refuses a command composed against a different scene at the same path", async () => {
    /*
     * Deleting a scene frees its id AND its stem, and a new scene drafted at the same path can
     * be at v1 too. A delayed command composed against v1 of the deleted one would sail through
     * a version check and land in a scene it was never about.
     */
    const { dir, store } = await open();
    const before = await sceneOnDisk(store);
    const print = await worldPrint(dir);

    await assert.rejects(
      () =>
        applySceneCommand(store, {
          productionId: PRODUCTION,
          sceneFile: SCENE,
          sceneId: "sc_99",
          baseVersion: before.version,
          command: { kind: "delete-shot", shotId: shotIds(before).at(-1)! },
        }),
      /holds scene sc_04, not sc_99/,
    );
    assert.equal(await worldPrint(dir), print);
  });
});

describe("a deletion refuses when it cannot prove itself safe", () => {
  it("names the unreadable dispatch plans as a blocker rather than assuming none", async () => {
    // "I could not look" is not "there is nothing there": this is exactly the moment a delete
    // must not proceed, because a running dispatch may still reference the shot.
    const { dir, store } = await open();
    const before = await sceneOnDisk(store);
    const print = await worldPrint(dir);

    await assert.rejects(
      () =>
        applySceneCommand(
          store,
          {
            productionId: PRODUCTION,
            sceneFile: SCENE,
            sceneId: SCENE_ID,
            baseVersion: before.version,
            command: { kind: "delete-shot", shotId: shotIds(before).at(-1)! },
          },
          {
            activePlans: () => Promise.reject(new Error("the journal could not be read")),
          },
        ),
      /could not be read, so a running one cannot be ruled out/,
    );
    assert.equal(await worldPrint(dir), print, "and nothing was written while it could not tell");
  });

  it("names an authorized plan for this scene", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    await assert.rejects(
      () =>
        applySceneCommand(
          store,
          {
            productionId: PRODUCTION,
            sceneFile: SCENE,
            sceneId: SCENE_ID,
            baseVersion: before.version,
            command: { kind: "delete-shot", shotId: shotIds(before).at(-1)! },
          },
          {
            activePlans: () =>
              Promise.resolve([{ planId: "pl_01", sceneId: SCENE_ID, status: "active" }]),
          },
        ),
      /pl_01/,
    );
  });
});

describe("an edit can clear an optional field, which JSON alone cannot say", () => {
  it("translates the named fields to the absence editShot reads as removal", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const target = orderedShots(before).find((shot) => shot.durationSec !== undefined)!;

    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: sceneCommandFrom({ kind: "edit-shot", shotId: target.id, change: {}, clear: ["durationSec"] }),
    });

    const after = await sceneOnDisk(store);
    const edited = orderedShots(after).find((shot) => shot.id === target.id)!;
    assert.equal("durationSec" in edited, false, "the key is gone, not set to the word undefined");
    assert.equal(edited.description, target.description, "and nothing else moved");
  });

  it("leaves every field a change did not name", async () => {
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const target = orderedShots(before)[0]!;
    await applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: sceneCommandFrom({ kind: "edit-shot", shotId: target.id, change: { intent: "Held." } }),
    });
    const edited = orderedShots(await sceneOnDisk(store)).find((shot) => shot.id === target.id)!;
    assert.equal(edited.intent, "Held.");
    assert.equal(edited.durationSec, target.durationSec, "an omitted key is not a cleared one");
  });
});

describe("shot ids are minted under the same lock that writes them", () => {
  it("two inserts into different scenes never mint the same id", async () => {
    /*
     * The race the gate closes: both handlers read the same production snapshot before either
     * commits, mint the same next id, and both commit cleanly — their base hashes never collide
     * because they replace DIFFERENT files. The result is two shots with one id, and selections
     * and takes keyed by the bare id then alias the wrong one.
     */
    const { store } = await open();
    const other = "02-the-tables-say-neap";
    const first = await sceneOnDisk(store);
    const second = await sceneOnDisk(store, other);
    const beat = { title: "A held breath", description: "Nothing moves.", durationSec: 2 };

    await Promise.all([
      applySceneCommand(store, {
        productionId: PRODUCTION,
        sceneFile: SCENE,
        sceneId: first.id,
        baseVersion: first.version,
        command: { kind: "insert-shot", at: { atStart: true }, shot: beat },
      }),
      applySceneCommand(store, {
        productionId: PRODUCTION,
        sceneFile: other,
        sceneId: second.id,
        baseVersion: second.version,
        command: { kind: "insert-shot", at: { atStart: true }, shot: beat },
      }),
    ]);

    const ids = [
      ...shotIds(await sceneOnDisk(store)),
      ...shotIds(await sceneOnDisk(store, other)),
    ];
    assert.equal(new Set(ids).size, ids.length, `ids must be unique across the production: ${ids.join(", ")}`);
  });
});

describe("the blockers are checked under the same lock that writes", () => {
  it("an accept that lands while the command waits for the gate refuses the deletion", async () => {
    /*
     * The window a version fence cannot close: accepting a take does not touch the SCENE's
     * version, so blockers derived before the gate and a write made inside it can disagree with
     * nothing to catch the difference — and the deletion would remove the very selection the
     * accept had just written, leaving paid footage belonging to no shot.
     *
     * Staged deterministically: something else holds the gate, the delete command queues behind
     * it having already read the scene, and the accept commits before the gate is released. The
     * command therefore enters the gate with its outside-the-gate view already stale.
     */
    const { store } = await open();
    const before = await sceneOnDisk(store);
    const target = shotIds(before).at(-1)!;
    const selectionsPath = `productions/${PRODUCTION}/selections.json`;

    let releaseHolder = (): void => {};
    let queued = (): void => {};
    const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
    const commandQueued = new Promise<void>((resolve) => (queued = resolve));

    const holding = store.gateOp(async () => {
      await commandQueued;
      // A real accept, committed through the store so the bundle sees it, exactly as the
      // accept-take handler would land it.
      const raw = await readFile(join(store.dir, "productions", PRODUCTION, "selections.json"), "utf8");
      const selections = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      selections[target] = { ...selections[target], acceptedTakeId: "tk_01J8F0000000000000000000B2" };
      await store.commitUnserialised({
        kind: "accept-take",
        source: "test",
        files: [
          {
            path: selectionsPath,
            action: "replace",
            content: `${JSON.stringify(selections, null, 2)}
`,
            baseHash: sha256(raw),
          },
        ],
      });
      await holderMayFinish;
    });

    // The command reads the scene, finds it current, and queues behind the holder.
    const deleting = applySceneCommand(store, {
      productionId: PRODUCTION,
      sceneFile: SCENE,
      sceneId: SCENE_ID,
      baseVersion: before.version,
      command: { kind: "delete-shot", shotId: target },
    });
    queued();
    releaseHolder();
    await holding;

    await assert.rejects(() => deleting, /accepted take/);
    const after = await sceneOnDisk(store);
    assert.ok(shotIds(after).includes(target), "the shot the footage belongs to is still there");
    const selections = JSON.parse(
      await readFile(join(store.dir, "productions", PRODUCTION, "selections.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    assert.equal(selections[target]?.["acceptedTakeId"], "tk_01J8F0000000000000000000B2");
  });
});
