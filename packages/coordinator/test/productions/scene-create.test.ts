import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, SceneRecordSchema, ulid, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { createScene } from "../../src/productions/ops.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The empty scene (SPEC-036 R-37): `New scene` makes it and opens it, no brief and no gate.
 *
 * What each test asks: is the scene real on disk and clean to the scanner, does it get an
 * identity nothing else holds, does it join the episode it was pressed under in the same
 * commit — and, the one that matters, does a refusal leave the world exactly as it was.
 */

const CLOCK = "2026-09-02T09:00:00.000Z";
const PRODUCTION = "saltlight";

async function open(): Promise<{ dir: string; store: WorldStore }> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return { dir: store.dir, store };
}

const scenesDir = (dir: string) => join(dir, "productions", PRODUCTION, "scenes");

async function sceneOnDisk(dir: string, path: string) {
  return SceneRecordSchema.parse(JSON.parse(await readFile(join(dir, ...path.split("/")), "utf8")));
}

const productionOf = (store: WorldStore) =>
  store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;

/** An episode on disk with no scenes yet, the way a season starts. */
async function putEpisode(store: WorldStore, id: string, stem: string): Promise<string> {
  const path = `productions/${PRODUCTION}/episodes/${stem}.json`;
  await store.commit({
    kind: "episode-edit",
    source: "test",
    files: [
      {
        path,
        action: "create",
        content: `${JSON.stringify({ id, version: 1, order: 1, title: "One", scenes: [] }, null, 2)}\n`,
        baseHash: null,
      },
    ],
  });
  return path;
}

describe("an empty scene, made live (SPEC-036 R-37)", () => {
  it("lands untitled, numbered past every scene, with nothing in it, and clean to the scanner", async () => {
    const { dir, store } = await open();
    const highest = Math.max(...productionOf(store).scenes.map((scene) => scene.number));

    const made = await createScene(store, { productionId: PRODUCTION });

    assert.equal(made.sceneId, "sc_untitled");
    assert.equal(made.path, `productions/${PRODUCTION}/scenes/untitled.json`);
    const record = await sceneOnDisk(dir, made.path);
    assert.equal(record.title, "Untitled");
    assert.equal(record.number, highest + 1, "a birth number past every scene, never a reused one");
    assert.equal(record.order, record.number);
    assert.equal(record.version, 1);
    assert.equal(record.status, "draft");
    assert.deepEqual(orderedShots(record), [], "nothing in it — the workspace is where it gets built");
    const scanned = await scanWorld(dir);
    assert.deepEqual(scanned.problems, [], "the world still scans clean");
    const after = scanned.bundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(after.sceneFiles["sc_untitled"], "untitled", "and the bundle reaches it by its stem");
  });

  it("gives a second untitled scene its own identity, and a named one its name's", async () => {
    const { store } = await open();
    const first = await createScene(store, { productionId: PRODUCTION });
    const second = await createScene(store, { productionId: PRODUCTION });
    const named = await createScene(store, { productionId: PRODUCTION, title: "  The tide answers  " });
    assert.deepEqual(
      [first.sceneId, second.sceneId, named.sceneId],
      ["sc_untitled", "sc_untitled-2", "sc_the-tide-answers"],
    );
    const production = productionOf(store);
    const numbers = [first, second, named].map(
      (made) => production.scenes.find((scene) => scene.id === made.sceneId)!.number,
    );
    assert.deepEqual(numbers, [numbers[0], numbers[0]! + 1, numbers[0]! + 2], "each takes the next number");
    assert.equal(production.scenes.find((scene) => scene.id === named.sceneId)!.title, "The tide answers");
  });

  it("joins the episode it was pressed under, in the same commit as the scene", async () => {
    const { dir, store } = await open();
    const episodePath = await putEpisode(store, "ep_one", "one");

    const made = await createScene(store, { productionId: PRODUCTION, episodeId: "ep_one" });

    const episode = JSON.parse(await readFile(join(dir, ...episodePath.split("/")), "utf8")) as { scenes: string[] };
    assert.deepEqual(episode.scenes, [made.sceneId]);
    assert.deepEqual(productionOf(store).episodes.find((candidate) => candidate.id === "ep_one")?.scenes, [made.sceneId]);
  });

  it("refuses an episode the production does not have, and writes nothing", async () => {
    const { dir, store } = await open();
    const before = (await readdir(scenesDir(dir))).sort();
    await assert.rejects(createScene(store, { productionId: PRODUCTION, episodeId: "ep_nowhere" }), /ep_nowhere/);
    assert.deepEqual((await readdir(scenesDir(dir))).sort(), before, "no scene file appeared");
  });
});

type CreateResult = Extract<DomainEvent, { type: "scene.create-result" }>;

async function harness() {
  const made = await makeTempRoot();
  const provider = new FsWorldProvider(made.root, { clock: () => CLOCK });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(made.root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const results = () => events.filter((event): event is CreateResult => event.type === "scene.create-result");
  return { ...made, send, results };
}

describe("create-scene is answered by its request id", () => {
  it("answers created, with the scene's id, once the scene is on disk", async () => {
    const h = await harness();
    const requestId = ulid();
    await h.send({ kind: "create-scene", worldId: WORLD_ID, productionId: PRODUCTION, requestId });
    const [result] = h.results();
    assert.ok(result, "one correlated result");
    assert.equal(result.requestId, requestId);
    assert.equal(result.disposition, "created");
    assert.equal(result.sceneId, "sc_untitled");
    await access(join(h.worldDir, "productions", PRODUCTION, "scenes", "untitled.json"));
  });

  it("answers failed with the reason when the episode is not there, and makes no scene", async () => {
    const h = await harness();
    const requestId = ulid();
    await h.send({
      kind: "create-scene",
      worldId: WORLD_ID,
      productionId: PRODUCTION,
      requestId,
      episodeId: "ep_nowhere",
    });
    const [result] = h.results();
    assert.ok(result, "a refusal is still an answer");
    assert.equal(result.requestId, requestId);
    assert.equal(result.disposition, "failed");
    assert.match(result.reason ?? "", /ep_nowhere/);
    await assert.rejects(access(join(h.worldDir, "productions", PRODUCTION, "scenes", "untitled.json")));
  });
});
