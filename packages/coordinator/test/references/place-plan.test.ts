import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  orderedShots, PLACE_PLAN_SCHEMA_VERSION, PlacePlanSchema, SceneRecordSchema,
  type ClientMessage, type DomainEvent, type PlacePlan, type PlacePlanChange, type SceneRecord, type StagingFigure, type StagingSet,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { readWorldMeta, scanWorld } from "../../src/world/scan.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A place's plan (design turn 285, issue 2302). The fixture's three scenes are all set on the
 * Vigil, which is the case the feature exists for: one room, shot in three scenes. What the tests
 * ask is whether the room stays one room. A set changed in one scene has changed in the others in
 * the same commit, a scene that never carried the place's set takes it rather than replacing it,
 * and a refusal leaves no half of a plan behind.
 */

const CLOCK = "2026-11-20T12:00:00.000Z";
const PRODUCTION = "saltlight";
const PLACE = "the-vigil";
const FIRST = { file: "04-the-verse-rises", id: "sc_04" };
const SECOND = { file: "02-the-tables-say-neap", id: "sc_02" };
const THIRD = { file: "06-slack-water", id: "sc_06" };

const DECK: StagingSet[] = [
  { name: "deck", x: 0, z: 0, w: 6, h: 3, d: 8, kit: { kind: "room" } },
  { name: "chart table", x: 1, z: -2, w: 1.2, h: .75, d: .8, kit: { kind: "table", seats: 2 } },
];
const HOLD: StagingSet[] = [{ name: "hold", x: 0, z: 0, w: 4, h: 2.2, d: 5 }];
const CAST = [{ sheetId: "maren-kest", x: -1, z: 0 }, { sheetId: "ione-vale", x: 1, z: 0 }];

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.listWorlds();
  await provider.loadWorld(WORLD_ID);
  // The world's lock beats until it is closed: left open, the file never ends.
  closeOnCleanup(() => provider.close());
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) => coordinator.dispatch(msg);
  const store = () => provider.openStore()!;
  const bundle = () => store().getBundle();
  const scene = async (which: { file: string }): Promise<SceneRecord> =>
    SceneRecordSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", PRODUCTION, "scenes", `${which.file}.json`), "utf8")));
  const planOnDisk = async (sheetId = PLACE): Promise<PlacePlan | null> => {
    try { return PlacePlanSchema.parse(JSON.parse(await readFile(join(worldDir, "references", sheetId, "plan.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  /** A Keep on the scene's first shot: shared marks and set, and a still camera. */
  const stage = async (which: { file: string; id: string }, sets: StagingSet[], extra: { position?: number; baseVersion?: number; cast?: StagingFigure[] } = {}) => {
    const current = await scene(which);
    const shot = orderedShots(current)[0]!;
    const duration = shot.durationSec ?? 4;
    const camera = { p: [0, 1.5, 3] as [number, number, number], l: [0, 1, 0] as [number, number, number] };
    await send({
      kind: "scene-command", worldId: WORLD_ID, productionId: PRODUCTION, sceneFile: which.file, sceneId: which.id, baseVersion: extra.baseVersion ?? current.version,
      command: { kind: "edit-stage", shotId: shot.id, blocking: { cast: extra.cast ?? CAST, sets },
        staging: { keys: [{ t: 0, ...camera }, { t: duration, ...camera }], ...(extra.position === undefined ? {} : { position: extra.position }) } },
    });
  };
  const change = (value: PlacePlanChange, from?: { file: string; id: string }, sheetId = PLACE) => send({
    kind: "place-plan", worldId: WORLD_ID, sheetId, change: value,
    ...(from ? { from: { productionId: PRODUCTION, sceneFile: from.file, sceneId: from.id } } : {}),
  });
  const add = (from?: { file: string; id: string }, name?: string) =>
    change({ op: "add-position", p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35, ...(name === undefined ? {} : { name }) }, from);
  const failures = () => events.filter((event): event is Extract<DomainEvent, { type: "command.failed" }> => event.type === "command.failed" && event.command === "place-plan");
  const refusals = () => events.filter((event): event is Extract<DomainEvent, { type: "scene.write-refused" }> => event.type === "scene.write-refused");
  return { worldDir, send, store, bundle, scene, planOnDisk, stage, change, add, failures, refusals };
}

describe("a place's first plan", () => {
  it("is refused while there is no set to stand a camera in, and leaves nothing behind", async () => {
    const h = await harness();
    const before = (await readWorldMeta(h.worldDir)).schemaVersion;
    await h.add();
    assert.match(h.failures().at(-1)!.reason, /no set yet/);
    await h.add(THIRD);
    assert.match(h.failures().at(-1)!.reason, /no set yet/, "a scene nobody has staged has no set to give");
    await h.change({ op: "add-position", p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35 }, FIRST, "maren-kest");
    assert.match(h.failures().at(-1)!.reason, /not a location/);
    assert.equal(await h.planOnDisk(), null);
    assert.equal((await readWorldMeta(h.worldDir)).schemaVersion, before, "a refusal raises nothing");
    assert.deepEqual(h.bundle().placePlans, []);
  });

  it("takes its set from the scene it was made in, and every other staged scene set there follows in the same commit", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.stage(SECOND, HOLD);
    const second = await h.scene(SECOND), third = await h.scene(THIRD);
    assert.deepEqual(second.blocking!.sets, HOLD, "until the place has a plan, each scene keeps its own set");

    await h.add(FIRST);
    assert.deepEqual(h.failures(), []);
    const plan = (await h.planOnDisk())!;
    assert.deepEqual(plan, { sheetId: PLACE, version: 1, sets: DECK, positions: [{ n: 1, name: "Position 1", p: [0, 1.5, 3], l: [0, 1, 0], focalMm: 35 }], next: 2 });
    assert.deepEqual(h.bundle().placePlans, [plan], "the bundle carries it");

    const followed = await h.scene(SECOND);
    assert.deepEqual(followed.blocking!.sets, DECK, "the other staged scene now stands in the place's set");
    assert.deepEqual(followed.blocking!.cast, second.blocking!.cast, "its marks are its own");
    assert.equal(followed.blocking!.version, second.blocking!.version + 1, "so a playblast of the old room reads stale");
    assert.equal(followed.version, second.version + 1, "and a Keep composed against the old room is refused");
    assert.deepEqual(await h.scene(THIRD), third, "a scene nobody has staged has nowhere to hold a set");

    assert.equal((await readWorldMeta(h.worldDir)).schemaVersion, PLACE_PLAN_SCHEMA_VERSION);
    await assert.rejects(readWorldMeta(h.worldDir, { supports: PLACE_PLAN_SCHEMA_VERSION - 1 }), /newer|version|schema/i, "a build before the Plan refuses the world by name");
    assert.deepEqual((await scanWorld(h.worldDir)).problems, []);
  });
});

describe("a place's positions", () => {
  it("are changed one at a time, numbered once, and a refusal keeps the plan as it was", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.add(FIRST, "The wide");
    await h.add(undefined, "On Maren");
    await h.add(undefined, "the  WIDE");
    assert.match(h.failures().at(-1)!.reason, /Another position is named/);
    await h.change({ op: "edit-position", n: 2, name: "On Maren, close", focalMm: 65, words: { subject: { kind: "cast", sheetId: "maren-kest" }, size: "close-up", angle: "eye", side: "front" } });
    await h.change({ op: "remove-position", n: 1 });
    await h.add();
    const plan = (await h.planOnDisk())!;
    assert.deepEqual(plan.positions.map((position) => [position.n, position.name, position.focalMm]), [[2, "On Maren, close", 65], [3, "Position 3", 35]]);
    assert.equal(plan.positions[0]!.words?.size, "close-up");
    assert.equal(plan.next, 4, "a number is never reused");
    assert.equal(plan.version, 1, "moving a camera is not a change to the set");
    assert.deepEqual((await h.scene(FIRST)).blocking!.sets, DECK);
    await h.change({ op: "edit-position", n: 1, name: "Gone" });
    assert.match(h.failures().at(-1)!.reason, /Position 1 is not on this plan/);
  });
});

describe("the place's set, once it has one", () => {
  it("moves with a Stage edit in any scene that carries it, for every scene set there", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.stage(SECOND, HOLD);
    await h.add(FIRST);
    const stale = await h.scene(SECOND);

    // The second scene carries the place's set now, so a Keep there that changes it is the place's change.
    const wider: StagingSet[] = [...DECK, { name: "binnacle", x: -1, z: 1, w: .5, h: 1.2, d: .5 }];
    await h.stage(SECOND, wider);
    assert.deepEqual(h.refusals(), []);
    const plan = (await h.planOnDisk())!;
    assert.deepEqual(plan.sets, wider);
    assert.equal(plan.version, 2, "the set's own version moved");
    assert.equal(plan.positions.length, 1, "and its positions stand where they stood");
    assert.deepEqual((await h.scene(FIRST)).blocking!.sets, wider, "the first scene follows");

    // A Keep that changes nothing about the set leaves the place alone.
    await h.stage(FIRST, wider);
    assert.equal((await h.planOnDisk())!.version, 2);

    // A Keep composed against the room as it was is refused by the scene's own version.
    const before = await h.scene(SECOND);
    await h.stage(SECOND, HOLD, { baseVersion: stale.version });
    assert.equal(h.refusals().length, 1);
    assert.deepEqual(await h.scene(SECOND), before);
    assert.deepEqual((await h.planOnDisk())!.sets, wider);
  });

  it("is not changed under a scene whose people ride a piece the new set lacks", async () => {
    const h = await harness();
    const CAR: StagingSet[] = [...DECK, { name: "launch", group: "launch", x: 2, z: 2, w: 2, h: 1, d: 4 }];
    const aboard: StagingFigure[] = [{ sheetId: "maren-kest", x: 0, z: 0, parent: "launch" }, { sheetId: "ione-vale", x: 1, z: 0 }];
    await h.stage(FIRST, DECK);
    await h.stage(SECOND, CAR, { cast: aboard });
    const second = await h.scene(SECOND);

    // The first plan would take the first scene's set, which has no launch for her to stand in.
    await h.add(FIRST);
    assert.match(h.failures().at(-1)!.reason, /rides a piece this set does not have/);
    assert.match(h.failures().at(-1)!.reason, /The tables say neap|shot \d+/i, "the scene and the shot are named");
    assert.equal(await h.planOnDisk(), null, "nothing of the plan is written");
    assert.deepEqual(await h.scene(SECOND), second, "and the other scene is as it was");

    // Made from the scene that has the launch, the plan lands, and a later edit that takes the launch away is refused.
    await h.add(SECOND);
    assert.deepEqual((await h.planOnDisk())!.sets, CAR);
    assert.deepEqual((await h.scene(FIRST)).blocking!.sets, CAR, "the first scene follows: nothing of its own rode a piece");
    const first = await h.scene(FIRST);
    await h.stage(FIRST, DECK);
    assert.equal(h.refusals().length, 1, "refused where the edit was made");
    assert.deepEqual(await h.scene(FIRST), first);
    assert.deepEqual([(await h.planOnDisk())!.version, (await h.planOnDisk())!.sets], [1, CAR]);
  });

  it("is taken by a scene that did not carry it, whatever that scene's command said about sets", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.add(FIRST);
    // The third scene was never staged: its first Keep arrives with a set of its own.
    await h.stage(THIRD, HOLD);
    assert.deepEqual(h.refusals(), []);
    const third = await h.scene(THIRD);
    assert.deepEqual(third.blocking!.sets, DECK, "the place's set, not the one the command brought");
    assert.deepEqual(third.blocking!.cast, CAST, "its marks are kept");
    const plan = (await h.planOnDisk())!;
    assert.deepEqual([plan.version, plan.sets], [1, DECK], "a scene that never carried the set cannot change it");
  });

  it("goes with a scene that is moved into the place, and stays behind when a scene leaves", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.add(FIRST);
    await h.stage(SECOND, DECK);
    const edit = async (which: { file: string; id: string }, location: string) => h.send({
      kind: "scene-command", worldId: WORLD_ID, productionId: PRODUCTION, sceneFile: which.file, sceneId: which.id, baseVersion: (await h.scene(which)).version,
      command: { kind: "edit-scene", inherits: { location } },
    });
    await edit(SECOND, "the-saltmarket");
    await h.stage(SECOND, HOLD);
    assert.deepEqual((await h.scene(SECOND)).blocking!.sets, HOLD, "elsewhere, its set is its own again");
    assert.deepEqual((await h.planOnDisk())!.sets, DECK);
    assert.equal(await h.planOnDisk("the-saltmarket"), null, "and no plan is made for a place nobody planned");

    const away = await h.scene(SECOND);
    await edit(SECOND, PLACE);
    const back = await h.scene(SECOND);
    assert.deepEqual(back.blocking!.sets, DECK, "back on the Vigil, it stands in the Vigil's set");
    assert.equal(back.blocking!.version, away.blocking!.version + 1, "the room under its marks changed");
    assert.equal((await h.planOnDisk())!.version, 1);
  });
});

describe("what an older build must not open", () => {
  it("is fenced by a shot that names a position, before any plan is written", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    assert.ok((await readWorldMeta(h.worldDir)).schemaVersion < PLACE_PLAN_SCHEMA_VERSION);
    await h.stage(FIRST, DECK, { position: 3 });
    assert.deepEqual(h.refusals(), []);
    assert.equal(orderedShots(await h.scene(FIRST))[0]!.staging!.position, 3);
    assert.equal((await readWorldMeta(h.worldDir)).schemaVersion, PLACE_PLAN_SCHEMA_VERSION);
  });

  it("lets a scene be edited while its place's plan cannot be read, and never writes over that plan", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.add(FIRST);
    const broken = "{ not a plan";
    await writeFile(join(h.worldDir, "references", PLACE, "plan.json"), broken);
    await h.stage(FIRST, HOLD);
    assert.deepEqual(h.refusals(), [], "a broken plan does not stop an edit to a scene set there");
    assert.deepEqual((await h.scene(FIRST)).blocking!.sets, HOLD);
    await h.add();
    assert.equal(h.failures().length, 1, "but a change to the plan itself is refused");
    assert.equal(await readFile(join(h.worldDir, "references", PLACE, "plan.json"), "utf8"), broken, "and the file a person may yet mend is left alone");
  });

  it("reports a plan moved by hand to another place's folder, and draws it nowhere", async () => {
    const h = await harness();
    await h.stage(FIRST, DECK);
    await h.add(FIRST);
    const raw = await readFile(join(h.worldDir, "references", PLACE, "plan.json"), "utf8");
    await mkdir(join(h.worldDir, "references", "the-saltmarket"), { recursive: true });
    await writeFile(join(h.worldDir, "references", "the-saltmarket", "plan.json"), raw);
    const scan = await scanWorld(h.worldDir);
    assert.deepEqual(scan.bundle.placePlans.map((plan) => plan.sheetId), [PLACE]);
    assert.ok(scan.problems.some((problem) => problem.path === "references/the-saltmarket/plan.json"), "named by the path a person can open");
  });
});
