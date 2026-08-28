import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  isGraphScene,
  linearizeSceneFlow,
  migrateLegacyScene,
  SceneRecordSchema,
  SceneSchema,
  validateSceneFlow,
  type GraphScene,
  type Scene,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import {
  draftSceneSkeleton,
  landBoard,
  reorderScenes,
  restoreScene,
  saveScene,
  setPromptOverride,
} from "../../src/productions/ops.js";
import { readWorldMeta, scanWorld, WorldOpenError } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * World schema 3 and lazy per-scene migration (SPEC-029 R-9..R-15, T-5..T-8; issue 583).
 *
 * The promise these tests hold is narrow and load-bearing: reading a world never changes it, the
 * first authored write to a scene turns that one scene into its canonical graph and fences the
 * world in the same commit, and no scene ever carries two ideas of its own order. Everything is
 * checked against the bytes on disk, because every failure mode here is a file that says
 * something other than what the code believed it said.
 */

const CLOCK = () => "2026-08-24T12:00:00.000Z";
const PRODUCTION = "saltlight";
const VERSE = "04-the-verse-rises";
const TABLES = "02-the-tables-say-neap";
const SLACK = "06-slack-water";
const scenePath = (stem: string) => `productions/${PRODUCTION}/scenes/${stem}.json`;

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store) };
}

async function readRaw(dir: string, portable: string): Promise<string> {
  return readFile(join(dir, ...portable.split("/")), "utf8");
}

/** The file as JSON, untouched by any schema — these tests are about what the bytes say. */
async function readJson(dir: string, portable: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readRaw(dir, portable)) as Record<string, unknown>;
}

async function readScene(dir: string, stem: string): Promise<Scene | GraphScene> {
  return SceneRecordSchema.parse(await readJson(dir, scenePath(stem)));
}

async function schemaVersion(dir: string): Promise<number> {
  return (await readJson(dir, "world.json"))["schemaVersion"] as number;
}

/** Ordered shots however the file happens to hold them, so both arms answer the same question. */
function shotsOf(record: Scene | GraphScene) {
  const sequence = linearizeSceneFlow(record);
  assert.ok(sequence.kind === "linear", "the scene must linearise");
  return sequence.shots.map((pair) => pair.shot);
}

/**
 * R-1's invariant, asked of every scene file in the world, at the bytes.
 *
 * Called after each write below rather than once at the end: "no scene carries both at any
 * point" is not a property of the final state, and a migration that wrote `flow` beside `shots`
 * and tidied up afterwards would pass an end-state check while leaving a window in which an
 * interrupted commit strands a file with two orders in it.
 */
async function assertOneStructuralAuthority(dir: string): Promise<void> {
  const scenes = join(dir, "productions", PRODUCTION, "scenes");
  for (const file of await readdir(scenes)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(join(scenes, file), "utf8")) as Record<string, unknown>;
    const has = ["shots", "flow"].filter((key) => key in raw);
    assert.deepEqual(has, [has[0]], `${file} carries ${has.join(" and ") || "neither shots nor flow"}`);
  }
}

/**
 * Every file in the world by content hash, so "nothing was written" can be asked of the world
 * rather than of the two or three files a test remembered to name. `.index/` and `world.lock`
 * are derived and process-owned — deleting either loses nothing — so they are not the world.
 */
async function fingerprint(dir: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      const portable = relative(dir, full).split("\\").join("/");
      if (portable.startsWith(".index") || portable === "world.lock") continue;
      if (entry.isDirectory()) await walk(full);
      else seen.set(portable, createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  };
  await walk(dir);
  return seen;
}

/** A graph scene in the shape every writer still hands in: ordered `shots[]`, no `flow`. */
function shotsBack(scene: GraphScene): Scene {
  const { flow: _flow, ...base } = scene;
  return { ...base, shots: shotsOf(scene) };
}

/** What moved between two fingerprints, as paths — a readable answer where a map diff is not. */
function touched(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

describe("read is pure: opening a legacy world writes nothing and raises nothing (R-10)", () => {
  it("a scan of a schema-1 world leaves every byte of it alone", async () => {
    const dir = await makeTempWorld();
    const before = await fingerprint(dir);

    const scan = await scanWorld(dir);

    assert.equal(scan.meta.schemaVersion, 1, "the fixture world is legacy and stays legacy");
    assert.deepEqual(scan.problems, [], "every legacy scene still parses through the union");
    assert.deepEqual(touched(before, await fingerprint(dir)), [], "a read must not move one byte");
  });

  it("compiling a board neither migrates the scene nor fences the world", async () => {
    // R-10 names board compilation among the reads that must not migrate. It does write — the
    // board record lands on the scene — but a compiled picture is production output, so it
    // preserves the version and leaves the shape it found exactly as it found it.
    const { dir, store } = await open();
    const production = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!;
    assert.equal(production.scenes.find((s) => s.id === "sc_04")!.shots.length, 4, "the scan hands over the shots it always did");

    await landBoard(store, PRODUCTION, VERSE, new Uint8Array([1, 2, 3]), CLOCK);

    assert.equal(await schemaVersion(dir), 1, "a compiled board does not fence the world");
    const after = await readScene(dir, VERSE);
    assert.ok(!isGraphScene(after), "and does not migrate the scene it is a picture of");
    assert.equal(after.version, 2, "nor cut a version");
    await assertOneStructuralAuthority(dir);
  });
});

describe("the first authored write migrates one scene and fences the world (T-5)", () => {
  it("writes one graph scene and schema 3 in the same commit, and snapshots the legacy file", async () => {
    const { dir, store } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    const before = await fingerprint(dir);

    await saveScene(store, {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      scene: { ...legacy, synopsis: "Maren hears the verse under the harbour." },
      baseVersion: legacy.version,
    });

    const migrated = await readScene(dir, VERSE);
    assert.ok(isGraphScene(migrated), "the scene is now graph-backed");
    assert.equal(await schemaVersion(dir), 3, "and the world crossed the boundary that fences it");
    await assertOneStructuralAuthority(dir);

    // Nothing else in the world moved. The scene, the snapshot of the version it becomes, the
    // boundary, and the audit line: that is all a migration is allowed to be. The outgoing
    // legacy snapshot is already on disk at its own version and is rewritten with the identical
    // bytes, which is why it is not in this list.
    assert.deepEqual(touched(before, await fingerprint(dir)), [
      `.history/productions/${PRODUCTION}/scenes/${VERSE}/v${legacy.version + 1}.json`,
      "changes.jsonl",
      scenePath(VERSE),
      "world.json",
    ]);

    // One commit: the scene's change line and the world's carry the same id (R-11).
    const changes = (await readRaw(dir, "changes.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { commitId: string; entity: string; path?: string });
    const sceneLine = changes.findLast((c) => c.path === scenePath(VERSE));
    const worldLine = changes.findLast((c) => c.entity === "world");
    assert.ok(sceneLine && worldLine, "both the scene and the boundary are in the audit trail");
    assert.equal(sceneLine.commitId, worldLine.commitId, "one commit, not two");

    // R-13: the replaced legacy scene went through the ordinary history track, as itself.
    const snapshotPath = `.history/productions/${PRODUCTION}/scenes/${VERSE}/v${legacy.version}.json`;
    const snapshot = await readJson(dir, snapshotPath);
    assert.ok("shots" in snapshot && !("flow" in snapshot), "history keeps the legacy shape it replaced");
    assert.deepEqual(SceneSchema.parse(snapshot).shots, legacy.shots, "every shot, as it was");
    assert.equal(
      (await fingerprint(dir)).get(snapshotPath),
      before.get(snapshotPath),
      "and keeps it byte for byte — the legacy scene is recoverable, not reconstructed",
    );

    // R-12: every shot payload and id preserved, in the array's order, byte for field.
    assert.deepEqual(shotsOf(migrated), legacy.shots, "the shots survive unchanged and in the order they were in");
    assert.deepEqual(validateSceneFlow(migrated.flow), [], "and the graph they became is one path");
    assert.deepEqual(migrated.flow.storyboardGroups, [], "migration authors no beats");

    // R-13: identity, provenance and the joins hanging off them are not renamed or moved.
    assert.equal(migrated.id, legacy.id);
    assert.equal(migrated.number, legacy.number);
    assert.equal(migrated.slug, legacy.slug);
    assert.equal(migrated.version, legacy.version + 1, "one version, like any other authored save");
    assert.deepEqual(migrated.inherits, legacy.inherits);
    assert.deepEqual(migrated.board, legacy.board, "the compiled board record rides across");
    assert.equal(migrated.synopsis, "Maren hears the verse under the harbour.", "the edit itself landed");
    assert.deepEqual(
      await readJson(dir, `productions/${PRODUCTION}/selections.json`),
      { sh_12: { acceptedTakeId: "tk_01J8F0000000000000000000B2", startFrameTakeId: "tk_01J8A0000000000000000000A1" } },
      "the selection joined to sh_12 still names the shot it always named",
    );
  });

  it("repeating the migration is byte-identical (R-12)", async () => {
    const { dir, store } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));

    await saveScene(store, {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      scene: legacy,
      baseVersion: legacy.version,
    });
    const written = (await readScene(dir, VERSE)) as GraphScene;

    // The same scene through the same projection, computed twice: byte-identical means the ids
    // are derived from the scene and its shots, never minted.
    const again = migrateLegacyScene(legacy);
    assert.equal(JSON.stringify(again.flow), JSON.stringify(migrateLegacyScene(legacy).flow));
    assert.equal(JSON.stringify(written.flow), JSON.stringify(again.flow), "the file says what the projection says");
    assert.deepEqual(
      written.flow.nodes.map((node) => node.id),
      ["sfn_sc-04-entry", "sfn_sh-12", "sfn_sh-13", "sfn_sh-14", "sfn_sh-15", "sfn_sc-04-exit"],
      "node ids come from the scene and shot ids and nothing else",
    );
  });

  it("a shot's prompt override migrates the scene too, and then leaves its ids alone", async () => {
    const { dir, store } = await open();
    await setPromptOverride(store, store.getBundle(), {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      shotId: "sh_13",
      text: "The lamps flare in sequence, not together.",
    });

    const first = (await readScene(dir, VERSE)) as GraphScene;
    assert.ok(isGraphScene(first), "authored text is an authored write");
    assert.equal(await schemaVersion(dir), 3);
    await assertOneStructuralAuthority(dir);
    assert.equal(shotsOf(first)[1]!.promptOverride?.text, "The lamps flare in sequence, not together.");

    await setPromptOverride(store, store.getBundle(), {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      shotId: "sh_13",
      text: null,
    });
    const second = (await readScene(dir, VERSE)) as GraphScene;
    assert.deepEqual(
      second.flow.nodes.map((node) => node.id),
      first.flow.nodes.map((node) => node.id),
      "editing a payload inside an existing graph never re-mints its ids",
    );
    assert.deepEqual(second.flow.edges, first.flow.edges, "nor its connections — wording is not structure");
    assert.equal(shotsOf(second)[1]!.promptOverride, undefined, "and the override cleared");
  });

  it("an accepted scene proposal is born graph-backed (R-11)", async () => {
    const { dir, store, gate } = await open();
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: PRODUCTION,
      brief: "The lamps hold their line.",
    });
    // The drafting agent authors `shots[]`, exactly as its instruction says; the gate is what
    // turns the accepted target into the one shape a write may produce.
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const staged = SceneSchema.parse(JSON.parse(await readFile(target, "utf8")));
    await writeFile(
      target,
      JSON.stringify(
        {
          ...staged,
          shots: [{ id: "sh_40", number: 1, title: "The line", description: "The lamps stay where they are." }],
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.deepEqual(await gate.recordProblems(draft.proposalId), [], "a legacy target is legible to the gate");
    const outcome = await gate.accept(draft.proposalId);
    assert.equal(outcome.status, "accepted");

    const born = await readJson(dir, draft.path);
    assert.ok("flow" in born && !("shots" in born), "a scene this build creates is born graph-backed");
    assert.equal(await schemaVersion(dir), 3, "and raises the boundary when accepted");
    await assertOneStructuralAuthority(dir);
    assert.deepEqual(
      shotsOf(SceneRecordSchema.parse(born)).map((shot) => shot.id),
      ["sh_40"],
    );
  });
});

describe("an older build refuses a schema-3 world before it reads a scene (T-6)", () => {
  it("refuses by name, reads no scene file, and modifies nothing", async () => {
    const { dir, store } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    await saveScene(store, { productionId: PRODUCTION, sceneFile: VERSE, scene: legacy, baseVersion: legacy.version });
    await store.close();
    assert.equal(await schemaVersion(dir), 3);
    const before = await fingerprint(dir);

    for (const read of [() => readWorldMeta(dir, { supports: 2 }), () => scanWorld(dir, { supports: 2 })]) {
      await assert.rejects(
        read,
        (err: unknown) =>
          err instanceof WorldOpenError && err.reason === "schema-newer" && /this build supports 2/.test(err.message),
        /*
         * The refusal, rather than a scan carrying problems, is what proves no scene was read: a
         * build that supports only 2 parses scenes with the legacy schema, so had it reached the
         * scene directory the graph scene would have come back as a per-file problem and the
         * world would have opened one scene short of itself.
         */
      );
    }
    assert.deepEqual(touched(before, await fingerprint(dir)), [], "a refusal writes nothing");
    assert.equal(await schemaVersion(dir), 3, "and above all does not lower the boundary");
  });

  it("this build opens the world it just wrote", async () => {
    const { dir, store } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    await saveScene(store, { productionId: PRODUCTION, sceneFile: VERSE, scene: legacy, baseVersion: legacy.version });

    const scan = await scanWorld(dir);
    assert.deepEqual(scan.problems, [], "the writer's own build reads what it wrote");
    assert.deepEqual(
      scan.bundle.productions.find((p) => p.meta.id === PRODUCTION)!.scenes.find((s) => s.id === "sc_04")!.shots,
      legacy.shots,
      "and hands consumers the same shots it did before the migration",
    );
  });
});

describe("a schema-3 world holds both shapes at once (T-7)", () => {
  it("opens with legacy and graph scenes side by side, and editing one leaves the others alone", async () => {
    const { dir, store } = await open();
    const verse = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    const before = await fingerprint(dir);

    await saveScene(store, {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      scene: { ...verse, title: "The verse rises again" },
      baseVersion: verse.version,
    });

    assert.ok(
      !touched(before, await fingerprint(dir)).some((path) => path === scenePath(TABLES) || path === scenePath(SLACK)),
      "the two scenes nobody edited are byte-identical — this is a lazy migration, not a sweep",
    );
    for (const stem of [TABLES, SLACK]) {
      assert.ok(!isGraphScene(await readScene(dir, stem)), `${stem} is still legacy`);
    }
    await assertOneStructuralAuthority(dir);

    const scan = await scanWorld(dir);
    assert.deepEqual(scan.problems, [], "a mixed world opens with no problems at all");
    const scenes = scan.bundle.productions.find((p) => p.meta.id === PRODUCTION)!.scenes;
    assert.deepEqual(
      scenes.map((s) => s.id),
      ["sc_02", "sc_04", "sc_06"],
      "every scene is present and in order",
    );
    assert.equal(scenes.find((s) => s.id === "sc_04")!.title, "The verse rises again");

    // And the second scene migrates on its own first write, without disturbing the first.
    const verseAfter = await readRaw(dir, scenePath(VERSE));
    const tables = SceneSchema.parse(await readJson(dir, scenePath(TABLES)));
    await saveScene(store, {
      productionId: PRODUCTION,
      sceneFile: TABLES,
      scene: { ...tables, synopsis: "The tables and the water disagree." },
      baseVersion: tables.version,
    });
    assert.ok(isGraphScene(await readScene(dir, TABLES)));
    assert.ok(!isGraphScene(await readScene(dir, SLACK)), "the third scene is still nobody's business");
    assert.equal(await readRaw(dir, scenePath(VERSE)), verseAfter, "and the first scene was not rewritten");
    await assertOneStructuralAuthority(dir);
  });

  it("reordering scenes writes `order` and leaves a legacy scene legacy (R-19)", async () => {
    // Where a scene sits among its siblings is not the scene's internal structure, and one drag
    // rewrites `order` on every scene after the moved one — migrating here would turn the first
    // reorder in a world into an eager migration of most of a production.
    const { dir, store } = await open();
    await reorderScenes(store, PRODUCTION, ["sc_06", "sc_04", "sc_02"]);

    for (const stem of [TABLES, VERSE, SLACK]) {
      assert.ok(!isGraphScene(await readScene(dir, stem)), `${stem} was reordered, not rewritten`);
    }
    assert.equal(await schemaVersion(dir), 2, "reorder crosses the boundary it always crossed, and no further");
    await assertOneStructuralAuthority(dir);
  });
});

describe("restore passes a legacy snapshot through the same migration (T-8)", () => {
  it("brings the snapshot back as a new graph version and never lowers the boundary", async () => {
    const { dir, store } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));

    await saveScene(store, {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      scene: { ...legacy, title: "A title to be regretted" },
      baseVersion: legacy.version,
    });
    assert.equal(await schemaVersion(dir), 3);

    // v2 is the legacy snapshot the migration replaced: a schema-2 record inside a schema-3 world.
    const snapshot = await readJson(dir, `.history/productions/${PRODUCTION}/scenes/${VERSE}/v${legacy.version}.json`);
    assert.ok("shots" in snapshot, "the snapshot really is the legacy shape");

    await restoreScene(store, { productionId: PRODUCTION, sceneFile: VERSE, version: legacy.version });

    const restored = await readScene(dir, VERSE);
    assert.ok(isGraphScene(restored), "restore lands a graph scene, never `shots[]` back into a schema-3 world");
    assert.deepEqual(validateSceneFlow(restored.flow), [], "and a valid one");
    assert.equal(restored.version, legacy.version + 2, "restore is a new version, not a rewind");
    assert.equal(restored.title, legacy.title, "carrying exactly the content the snapshot held");
    assert.deepEqual(shotsOf(restored), legacy.shots);
    assert.equal(await schemaVersion(dir), 3, "the boundary is never lowered");
    await assertOneStructuralAuthority(dir);
  });

  it("a restore is itself a first authored write: it migrates and raises the boundary", async () => {
    // Undo before any save. The fixture ships this scene's v2 snapshot, so the world is still at
    // schema 1 when the restore runs — and restore is a write like any other (R-11, R-15).
    const { dir, store } = await open();
    assert.equal(await schemaVersion(dir), 1);
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));

    await restoreScene(store, { productionId: PRODUCTION, sceneFile: VERSE, version: legacy.version });

    const restored = await readScene(dir, VERSE);
    assert.ok(isGraphScene(restored), "the restored version is graph-backed");
    assert.deepEqual(shotsOf(restored), legacy.shots);
    assert.equal(restored.version, legacy.version + 1);
    assert.equal(await schemaVersion(dir), 3);
    await assertOneStructuralAuthority(dir);
    await access(join(dir, ".history", "productions", PRODUCTION, "scenes", VERSE, `v${legacy.version + 1}.json`));
  });
});

describe("a graph scene keeps its own structure through a writer that has none (R-2, R-61)", () => {
  /**
   * The scene migrated, then given one authored beat by hand — the only way to have one before
   * step 6 ships group editing, and the case that decides whether the whole-scene writer can be
   * trusted with a graph it did not build. Written as an outside editor would write it, version
   * and all, so the history track stays consistent with what is on disk.
   */
  async function withGroup(dir: string, store: WorldStore) {
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    await saveScene(store, { productionId: PRODUCTION, sceneFile: VERSE, scene: legacy, baseVersion: legacy.version });
    const migrated = (await readScene(dir, VERSE)) as GraphScene;
    migrated.version += 1;
    migrated.flow.storyboardGroups = [
      { id: "sbg_the-rail", title: "At the rail", shotNodeIds: ["sfn_sh-12", "sfn_sh-13"] },
    ];
    await writeFile(join(dir, ...scenePath(VERSE).split("/")), `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    return migrated;
  }

  it("carries an authored group across an edit that only rewrites payloads", async () => {
    const { dir, store } = await open();
    const withBeat = await withGroup(dir, store);
    const scene = (await readScene(dir, VERSE)) as GraphScene;

    await saveScene(store, {
      productionId: PRODUCTION,
      sceneFile: VERSE,
      scene: { ...shotsBack(scene), title: "The verse rises, still" },
      baseVersion: scene.version,
    });

    const after = (await readScene(dir, VERSE)) as GraphScene;
    assert.deepEqual(after.flow.storyboardGroups, withBeat.flow.storyboardGroups, "the beat somebody wrote survives");
    assert.deepEqual(after.flow.nodes.map((n) => n.id), scene.flow.nodes.map((n) => n.id), "and so do the ids it names");
    assert.equal(after.title, "The verse rises, still");
  });

  it("refuses a save that would leave an authored group naming shots the scene no longer holds", async () => {
    const { dir, store } = await open();
    await withGroup(dir, store);
    const scene = (await readScene(dir, VERSE)) as GraphScene;
    const raw = await readRaw(dir, scenePath(VERSE));
    const legacyShape = shotsBack(scene);

    await assert.rejects(
      saveScene(store, {
        productionId: PRODUCTION,
        sceneFile: VERSE,
        scene: { ...legacyShape, shots: legacyShape.shots.filter((shot) => shot.id !== "sh_13") },
        baseVersion: scene.version,
      }),
      /At the rail/,
      "a beat is authored work; dropping it silently is not a repair",
    );
    assert.equal(await readRaw(dir, scenePath(VERSE)), raw, "and nothing was written");
  });
});

describe("a proposal that says what a graph scene already says is a no-op (R-3)", () => {
  it("is retired rather than committed, so it can be settled at all", async () => {
    /*
     * Arke amends scenes in the legacy shape, and the file it is amending may already be a
     * graph. Compared key by key, `flow` and `shots` never match — so an accepted proposal would
     * read as a change forever, cut a version that changed nothing, and, worse, read as stale on
     * every later attempt. The gate compares through the projection for exactly this.
     */
    const { dir, store, gate } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    await saveScene(store, { productionId: PRODUCTION, sceneFile: VERSE, scene: legacy, baseVersion: legacy.version });
    const graph = (await readScene(dir, VERSE)) as GraphScene;
    const raw = await readRaw(dir, scenePath(VERSE));

    const proposal = await gate.stage({
      kind: "scene-edit",
      summary: "Nothing at all",
      source: "chat:studio",
      targets: [{ path: scenePath(VERSE), content: `${JSON.stringify(shotsBack(graph), null, 2)}\n` }],
    });
    const outcome = await gate.accept(proposal.id);

    assert.equal(outcome.status, "no-op", "the world already says this");
    assert.equal(await readRaw(dir, scenePath(VERSE)), raw, "so the scene was not rewritten or re-versioned");
  });
});

describe("a malformed graph is named, and takes nothing else down with it (R-60)", () => {
  it("reports the scene as a per-file problem and opens the rest of the world", async () => {
    const { dir, store } = await open();
    const legacy = SceneSchema.parse(await readJson(dir, scenePath(VERSE)));
    await saveScene(store, { productionId: PRODUCTION, sceneFile: VERSE, scene: legacy, baseVersion: legacy.version });
    await store.close();

    const broken = (await readJson(dir, scenePath(VERSE))) as unknown as GraphScene;
    broken.flow.edges = broken.flow.edges.slice(1); // Scene start now leads nowhere
    await writeFile(join(dir, ...scenePath(VERSE).split("/")), JSON.stringify(broken, null, 2) + "\n", "utf8");

    const scan = await scanWorld(dir);
    assert.equal(scan.problems.length, 1, "one file, one problem");
    assert.equal(scan.problems[0]!.path, scenePath(VERSE));
    assert.match(scan.problems[0]!.message, /Scene start is not connected/);
    assert.deepEqual(
      scan.bundle.productions.find((p) => p.meta.id === PRODUCTION)!.scenes.map((s) => s.id),
      ["sc_02", "sc_06"],
      "the other scenes still open",
    );
  });
});
