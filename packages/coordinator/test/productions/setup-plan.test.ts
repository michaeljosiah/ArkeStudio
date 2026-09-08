import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionSetupDraftSchema, orderedShots, ulid, type ProductionSetupDraft } from "@arke-studio/contracts";
import { createProduction, createProductionFromPlan } from "../../src/productions/ops.js";
import { planProductionSetup, setupSourceDigest } from "../../src/productions/setup-plan.js";
import { WorldStore } from "../../src/world/store.js";
import { scanWorld } from "../../src/world/scan.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const CLOCK = "2026-09-08T09:00:00.000Z";
function draft(episodic = false): ProductionSetupDraft {
  return ProductionSetupDraftSchema.parse({
    schemaVersion: 1, setupId: `cv_${ulid()}`, worldId: WORLD_ID, revision: 1,
    title: "The crossing", kind: episodic ? "microdrama" : "film", aspect: episodic ? "9:16" : "16:9", frameRate: 24,
    narrative: { direction: "The return changes everything.", ending: "They choose to leave." },
    arcs: episodic ? [{ id: "home", title: "Home", setup: "episode-0", turn: "episode-1", payoff: "episode-2" }] : [],
    references: [], openQuestions: ["What happens next?"],
    episodes: episodic ? Array.from({ length: 3 }, (_, i) => ({
      key: `episode-${i}`, title: `Episode ${i + 1}`, promise: { opens: "A return.", turn: "A revelation.", closes: "A choice." },
      scenes: [0, 1, 2].map(n => `scene-${i * 3 + n}`),
    })) : [],
    scenes: Array.from({ length: episodic ? 9 : 3 }, (_, i) => ({
      key: `scene-${i}`, title: `Scene ${i + 1}`, synopsis: `The arrival, beat ${i}.`,
      scriptBlocks: [{ id: "blk_arrival", kind: "action", text: "A boat emerges from the fog." }],
    })),
  });
}
async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

describe("reviewed initial production content (issue #976)", () => {
  it("joins the reviewed Series, preserves its authored context, and refuses moved membership", async () => {
    const store = await open();
    await createProduction(store, { title: "Earlier season", medium: "video", productionKind: "microdrama", seriesTitle: "The crossings" });
    const series = store.getBundle().series.find(item => item.title === "The crossings")!;
    const path = `series/${series.id}.json`;
    const raw = await readFile(join(store.dir, path), "utf8");
    const { sha256 } = await import("../../src/world/text-files.js");
    await store.commit({ kind: "test-series", source: "test", files: [{ path, action: "replace", baseHash: sha256(raw),
      content: JSON.stringify({ ...series, engine: "A different crossing each season.", continuity: "The bell always rings." }) }] });
    const outline = { ...draft(true), series: { title: series.title } };
    const plan = planProductionSetup(store.getBundle(), outline, CLOCK);
    assert.equal(plan.series.operation, "join");
    if (plan.series.operation !== "join") throw new Error("Expected a Series join");
    assert.equal(plan.series.record.engine, "A different crossing each season.");
    assert.equal(plan.series.record.continuity, "The bell always rings.");
    const digest = setupSourceDigest(store.getBundle());
    await createProduction(store, { title: "Concurrent season", medium: "video", productionKind: "microdrama", seriesTitle: series.title });
    await assert.rejects(createProductionFromPlan(store, plan, { source: "test", requestId: ulid(),
      precondition: () => setupSourceDigest(store.getBundle()) === digest ? null : "Series moved." }), /base moved|Series moved/);
    assert.equal(store.getBundle().productions.some(p => p.meta.id === plan.production.id), false);
    const next = planProductionSetup(store.getBundle(), outline, CLOCK);
    await createProductionFromPlan(store, next, { source: "test", requestId: ulid(), precondition: () => null });
    assert.deepEqual(store.getBundle().series.find(item => item.id === series.id)!.seasons,
      ["earlier-season", "concurrent-season", "the-crossing"]);
  });

  for (const episodic of [false, true]) it(episodic ? "creates three episodes and nine accessible graph scenes" : "preserves a film's arc and three scripted scenes through reopen", async () => {
    const store = await open();
    const outline = draft(episodic);
    const plan = planProductionSetup(store.getBundle(), outline, CLOCK);
    const digest = setupSourceDigest(store.getBundle());
    const requestId = ulid();
    await createProductionFromPlan(store, plan, {
      source: "test", requestId,
      precondition: () => setupSourceDigest(store.getBundle()) === digest ? null : "World sources moved.",
    });
    const scan = await scanWorld(store.dir);
    assert.deepEqual(scan.problems, []);
    assert.equal(scan.meta.schemaVersion, 19);
    const production = scan.bundle.productions.find(p => p.meta.id === plan.production.id)!;
    assert.equal(production.scenes.length, episodic ? 9 : 3);
    assert.equal(production.episodes.length, episodic ? 3 : 0);
    for (const scene of production.scenes) {
      assert.deepEqual(orderedShots(scene), []);
      assert.ok(production.sceneFiles[scene.id]);
      assert.equal(scene.script?.blocks[0]?.text, "A boat emerges from the fog.");
      assert.match(scene.synopsis!, /arrival/);
    }
    if (episodic) {
      assert.equal(production.narrative, null);
      assert.equal(production.season!.arcs![0]!.payoff, "ep_episode-2");
      assert.deepEqual(production.episodes.flatMap(e => e.scenes), production.scenes.map(s => s.id));
    } else {
      assert.equal(production.season, null);
      assert.equal(production.narrative!.direction, outline.narrative.direction);
      const history = JSON.parse(await readFile(join(store.dir, ".history/productions/the-crossing/narrative/v1.json"), "utf8"));
      assert.equal(history.ending, outline.narrative.ending);
    }
    const link = JSON.parse(await readFile(join(store.dir, "productions", production.meta.id, "setup-origin.json"), "utf8"));
    assert.equal(link.productionId, production.meta.id);
    assert.equal(link.requestId, requestId);
  });

  it("refuses a changed source or wrong world instead of silently replanning", async () => {
    const store = await open();
    const plan = planProductionSetup(store.getBundle(), draft(), CLOCK);
    await assert.rejects(createProductionFromPlan(store, plan, { source: "test", requestId: ulid(), precondition: () => "Sources moved." }), /Sources moved/);
    assert.ok(!store.getBundle().productions.some(p => p.meta.id === plan.production.id));
    assert.throws(() => planProductionSetup(store.getBundle(), { ...draft(), worldId: ulid() }, CLOCK), /another world/);
  });
});
