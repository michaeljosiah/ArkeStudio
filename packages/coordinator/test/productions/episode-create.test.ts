import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EpisodeSchema } from "@arke-studio/contracts";
import { createEpisode } from "../../src/productions/ops.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The episode made live (issue #728). `New episode` used to stage a proposal, and the rail's
 * press then read `pending` and stayed disabled for as long as that proposal sat unaccepted on
 * a screen nobody went to. What these ask: is the episode real on disk the moment it is made,
 * does a second press get an identity of its own, and does the world still scan clean.
 */

const CLOCK = "2026-09-03T09:00:00.000Z";
const PRODUCTION = "saltlight";

async function open(): Promise<{ dir: string; store: WorldStore }> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return { dir: store.dir, store };
}

const productionOf = (store: WorldStore) =>
  store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;

describe("an episode, made live (issue #728)", () => {
  it("is on disk and in the bundle on the press, with nothing left waiting to be accepted", async () => {
    const { dir, store } = await open();
    const before = productionOf(store).episodes.length;

    const made = await createEpisode(store, { productionId: PRODUCTION, title: "Episode 01", order: 1 });

    assert.equal(made.episodeId, "ep_episode-01");
    assert.equal(made.path, `productions/${PRODUCTION}/episodes/episode-01.json`);
    const record = EpisodeSchema.parse(JSON.parse(await readFile(join(dir, ...made.path.split("/")), "utf8")));
    assert.equal(record.title, "Episode 01");
    assert.equal(record.order, 1);
    assert.equal(record.version, 1);
    assert.deepEqual(record.scenes, [], "empty — the episode is where the scenes get made");
    // In the bundle, not in `.proposals/`: a staged episode would show up in neither.
    assert.equal(productionOf(store).episodes.length, before + 1);
    assert.ok(productionOf(store).episodes.some((episode) => episode.id === made.episodeId));
    const scanned = await scanWorld(dir);
    assert.deepEqual(scanned.problems, [], "the world still scans clean");
  });

  it("gives a second press of the same name an identity of its own", async () => {
    const { store } = await open();

    const first = await createEpisode(store, { productionId: PRODUCTION, title: "Episode 01" });
    const second = await createEpisode(store, { productionId: PRODUCTION, title: "Episode 01" });

    assert.equal(first.episodeId, "ep_episode-01");
    assert.equal(second.episodeId, "ep_episode-01-2", "no collision, and no press reporting one");
    assert.notEqual(first.path, second.path);
  });

  it("names the episode by its number when the press supplies none", async () => {
    const { store } = await open();
    const count = productionOf(store).episodes.length;

    const made = await createEpisode(store, { productionId: PRODUCTION });

    const record = productionOf(store).episodes.find((episode) => episode.id === made.episodeId)!;
    assert.equal(record.title, `Episode ${String(count + 1).padStart(2, "0")}`);
  });

  it("refuses a production this world does not have", async () => {
    const { store } = await open();
    await assert.rejects(createEpisode(store, { productionId: "not-here", title: "Episode 01" }), /not in this world/);
  });
});
