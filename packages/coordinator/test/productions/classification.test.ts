import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProduction } from "../../src/productions/ops.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Classification and creation (SPEC-023 R-1..R-8, issue #395): plain creations keep the world
 * openable by older builds; the first new-model creation crosses the schema boundary and makes
 * its Series and season in the same commit.
 */

const CLOCK = () => "2026-08-19T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

describe("production classification (issue 395)", () => {
  it("a plain Video creation writes only legacy keys and the world stays schema 1", async () => {
    const { dir, store } = await open();
    const slug = await createProduction(store, { title: "Slack Water", medium: "video" });
    const meta = JSON.parse(await readFile(join(dir, "productions", slug, "production.json"), "utf8"));
    assert.equal(meta.format, "video");
    assert.ok(!("medium" in meta) && !("kind" in meta), "nothing an old build cannot read");
    const { meta: world } = await scanWorld(dir);
    assert.equal(world.schemaVersion, 1, "openable by builds that predate the new model");
  });

  it("a Microdrama creation makes its Series and season in one commit and crosses the boundary", async () => {
    const { dir, store } = await open();
    const slug = await createProduction(store, {
      title: "Bell Watch — Season 1",
      medium: "video",
      productionKind: "microdrama",
      seriesTitle: "Bell Watch",
      aspect: "9:16",
      defaults: { episodeCount: 7, episodeSecondsMin: 45, episodeSecondsMax: 75, hookWindowSec: 3, episodeEnding: "cliffhanger", exportPreset: "social-1080x1920" },
    });

    const meta = JSON.parse(await readFile(join(dir, "productions", slug, "production.json"), "utf8"));
    assert.equal(meta.format, "video", "the legacy field never lies to an old reader");
    assert.equal(meta.medium, "video");
    assert.equal(meta.kind, "microdrama");
    assert.equal(meta.aspect, "9:16", "the delivery profile lands as a concrete field");

    const scan = await scanWorld(dir);
    assert.deepEqual(scan.problems, []);
    assert.equal(scan.meta.schemaVersion, 2, "the new-model write crossed the boundary");

    const season = scan.bundle.productions.find((p) => p.meta.id === slug)?.season;
    assert.ok(season, "season.json scanned beside the production");
    assert.equal(season.version, 1);
    assert.equal(season.defaults?.episodeCount, 7);
    assert.equal(season.defaults?.episodeEnding, "cliffhanger");

    assert.equal(scan.bundle.series.length, 1, "the thin Series exists");
    const series = scan.bundle.series[0]!;
    assert.equal(series.id, "bell-watch");
    assert.deepEqual(series.seasons, [slug], "season 1 is created with it");
  });

  it("a second season joins the existing Series in order", async () => {
    const { dir, store } = await open();
    const s1 = await createProduction(store, {
      title: "Bell Watch — Season 1",
      medium: "video",
      productionKind: "microdrama",
      seriesTitle: "Bell Watch",
    });
    const s2 = await createProduction(store, {
      title: "Bell Watch — Season 2",
      medium: "video",
      productionKind: "microdrama",
      seriesTitle: "Bell Watch",
    });
    const scan = await scanWorld(dir);
    assert.equal(scan.bundle.series.length, 1, "one Series, not one per season");
    assert.deepEqual(scan.bundle.series[0]!.seasons, [s1, s2], "ordered season references");
  });

  it("an Interactive-video creation records the medium and crosses the boundary", async () => {
    const { dir, store } = await open();
    const slug = await createProduction(store, { title: "The Answer From Inside", medium: "interactive-video" });
    const meta = JSON.parse(await readFile(join(dir, "productions", slug, "production.json"), "utf8"));
    assert.equal(meta.format, "video", "the legacy value the medium maps back to");
    /*
     * Since turn 100 the retired `interactive-video` medium means the video medium carrying
     * the interactive kind, and a new world records the new model — never the retired name.
     * Review 2026-08-22 found the resolve dropping the kind entirely, which silently made
     * this creation a plain film; the kind on disk is the interactivity.
     */
    assert.equal(meta.medium, "video");
    assert.equal(meta.kind, "interactive");
    const scan = await scanWorld(dir);
    assert.equal(scan.meta.schemaVersion, 2);
    assert.deepEqual(scan.problems, []);
  });

  it("the legacy fixture productions scan unchanged and unannotated", async () => {
    const { dir } = await open();
    const scan = await scanWorld(dir);
    assert.deepEqual(scan.problems, []);
    for (const p of scan.bundle.productions) {
      assert.ok(!("medium" in p.meta) || p.meta.medium === undefined, "no bulk annotation on inspect");
      assert.equal(p.season, null, "no season invented for a non-episodic production");
    }
    assert.deepEqual(scan.bundle.series, [], "no Series invented");
  });
});
