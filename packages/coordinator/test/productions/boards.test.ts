import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EpisodeSchema, SeasonSchema } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { proposeEpisode, proposeSeason, reorderEpisodes } from "../../src/productions/ops.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The board operations beneath issue #397: season and episode records staged through the gate,
 * reorder as an order-only rewrite — the same discipline chapters and scenes learned.
 */

const CLOCK = () => "2026-08-19T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store) };
}

describe("season and episode boards (issue 397)", () => {
  it("a season proposal stages, accepts, and versions season.json", async () => {
    const { dir, store, gate } = await open();
    const { proposalId } = await proposeSeason(store, gate, {
      productionId: "saltlight",
      source: "form",
      season: { question: "Who is ringing the drowned bell?", ending: "Maren answers it herself." },
    });
    const accepted = await gate.accept(proposalId);
    assert.equal(accepted.status, "accepted");
    const scan = await scanWorld(dir);
    const season = scan.bundle.productions.find((p) => p.meta.id === "saltlight")!.season!;
    assert.equal(season.question, "Who is ringing the drowned bell?");
    SeasonSchema.parse(season);
    assert.deepEqual(scan.problems, []);
  });

  it("episode create mints a stable identity; amend keeps it and merges fields", async () => {
    const { dir, store, gate } = await open();
    const created = await proposeEpisode(store, gate, {
      productionId: "saltlight",
      source: "form",
      episode: { title: "The missing night", promise: { opens: "The page is gone." } },
    });
    assert.equal(created.path, "productions/saltlight/episodes/the-missing-night.json");
    assert.equal((await gate.accept(created.proposalId)).status, "accepted");

    const amended = await proposeEpisode(store, gate, {
      productionId: "saltlight",
      source: "form",
      episodeId: "ep_the-missing-night",
      episode: { promise: { opens: "The page is gone.", closes: "The bell rings once." } },
    });
    assert.equal((await gate.accept(amended.proposalId)).status, "accepted");

    const raw = await readFile(join(dir, created.path.replace(/\//g, "/")), "utf8");
    const episode = EpisodeSchema.parse(JSON.parse(raw));
    assert.equal(episode.id, "ep_the-missing-night");
    assert.equal(episode.version, 2, "the amend cut a version");
    assert.equal(episode.promise?.closes, "The bell rings once.");
  });

  it("reordering episodes rewrites order only", async () => {
    const { dir, store, gate } = await open();
    for (const title of ["First", "Second", "Third"]) {
      const { proposalId } = await proposeEpisode(store, gate, {
        productionId: "saltlight",
        source: "form",
        episode: { title },
      });
      assert.equal((await gate.accept(proposalId)).status, "accepted");
    }
    const episodeDir = join(dir, "productions", "saltlight", "episodes");
    const namesBefore = (await readdir(episodeDir)).sort();

    await reorderEpisodes(store, "saltlight", ["ep_third", "ep_first", "ep_second"]);

    assert.deepEqual((await readdir(episodeDir)).sort(), namesBefore, "no file renamed");
    const scan = await scanWorld(dir);
    const episodes = scan.bundle.productions.find((p) => p.meta.id === "saltlight")!.episodes;
    assert.deepEqual(episodes.map((e) => e.id), ["ep_third", "ep_first", "ep_second"], "the bundle follows order");
    assert.deepEqual(episodes.map((e) => e.version), [1, 1, 1], "reorder cuts no version");
  });
});
