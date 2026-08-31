import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { legacySceneView, planScene, type ManifestModel, type Scene } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Board boundaries reaching the dispatch plan (SPEC-035 R-13), against the real fixture world.
 *
 * The unit tests prove `packScene` honours a forced break; this proves `planScene` computes
 * the boundaries in the first place — which is the whole of the change — and that it computes
 * them from the same world a dispatch would run against.
 */

const MODEL: ManifestModel = {
  id: "wide-video",
  provider: "fal",
  capability: "video",
  displayName: "Wide Video",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 30 },
  pricing: { kind: "perSecond", microUsdPerSecond: 1000 },
};

async function sceneOf(): Promise<{
  store: WorldStore;
  scene: Scene;
  base: Parameters<typeof planScene>[0];
}> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-08-01T12:00:00.000Z" });
  // The closer, not the store: an open WorldStore holds SQLite open and hangs the runner.
  closeOnCleanup(() => store.close());
  const bundle = store.getBundle();
  const production = bundle.productions.find((p) => p.meta.id === "saltlight")!;
  const scene = legacySceneView(production.scenes.find((s) => s.id === "sc_04")!);
  return {
    store,
    scene,
    base: {
      world: bundle.meta,
      artDirection: bundle.artDirection,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: production.selections,
      takes: production.takes,
      model: MODEL,
    },
  };
}

const passShots = (plan: ReturnType<typeof planScene>): string[][] => {
  assert.ok(plan.pack.ok, "expected a packable scene");
  return plan.pack.passes.map((pass) => pass.plan.map((entry) => entry.shotId));
};

describe("board boundaries reach the dispatch plan", () => {
  it("leaves a scene in one place as one pass, whatever its prose names", async () => {
    /*
     * Scene 4 is four shots — 19.5s under a 30s cap — set entirely in the Vigil. Its shots
     * mention `@the-vigil` and `@the-saltmarket`, which are locations, and an earlier cut of
     * this change counted them as cast: the scene packed into three boards and three passes on
     * location mentions alone. Cast is characters (R-3), so it is one pass.
     */
    const { base } = await sceneOf();
    assert.deepEqual(passShots(planScene(base, "whole-scene")), [["sh_12", "sh_13", "sh_14", "sh_15"]]);
  });

  it("splits the pass where the author put a seam", async () => {
    const { base, scene } = await sceneOf();
    const withSplit: Scene = { ...scene, boards: { splits: ["sh_14"], merges: [] } };
    assert.deepEqual(passShots(planScene({ ...base, scene: withSplit }, "whole-scene")), [
      ["sh_12", "sh_13"],
      ["sh_14", "sh_15"],
    ]);
  });

  it("splits where the shots themselves change time of day", async () => {
    const { base, scene } = await sceneOf();
    // The scene inherits night; framing one shot at dawn is a continuity break nobody authored,
    // and the boards — and so the passes — must find it without being told.
    const shots = scene.shots.map((s) =>
      s.id === "sh_14" || s.id === "sh_15" ? { ...s, framing: { ...s.framing, timeOfDay: "dawn" } } : s,
    );
    assert.deepEqual(passShots(planScene({ ...base, scene: { ...scene, shots } }, "whole-scene")), [
      ["sh_12", "sh_13"],
      ["sh_14", "sh_15"],
    ]);
  });

  it("holds one pass across that break when the author merges it, warning on the board", async () => {
    const { base, scene } = await sceneOf();
    const shots = scene.shots.map((s) =>
      s.id === "sh_14" || s.id === "sh_15" ? { ...s, framing: { ...s.framing, timeOfDay: "dawn" } } : s,
    );
    const merged: Scene = { ...scene, shots, boards: { splits: [], merges: ["sh_14"] } };
    assert.deepEqual(passShots(planScene({ ...base, scene: merged }, "whole-scene")), [
      ["sh_12", "sh_13", "sh_14", "sh_15"],
    ]);
  });

  it("keeps the author's seam whole however hard the cap cuts", async () => {
    /*
     * A tight cap breaks this scene into a pass per shot — and none of those passes runs
     * through sh_14, where the seam is. Provider limits are execution policy: they subdivide
     * authored structure and never rewrite it.
     *
     * Note what this does NOT claim. Boards are packed at the same text cap the passes are, so
     * a cap break is already a board break and there is nothing left for `packScene` to
     * subdivide on that cap. The one genuine subdivision is the shorter REFERENCE ceiling,
     * which a pass carrying references is held to retroactively (issue 390) — proven where it
     * can be controlled, in the packScene unit tests.
     */
    const { base, scene } = await sceneOf();
    const withSplit: Scene = { ...scene, boards: { splits: ["sh_14"], merges: [] } };
    const narrow: ManifestModel = { ...MODEL, limits: { maxDurationSec: 6 } };
    const passes = passShots(planScene({ ...base, scene: withSplit, model: narrow }, "whole-scene"));
    assert.ok(passes.length >= 3, `a 6s cap cuts a 19.5s scene into several passes, got ${passes.length}`);
    for (const pass of passes) {
      assert.ok(!(pass.includes("sh_13") && pass.includes("sh_14")), "no pass spans the seam");
    }
  });

  it("still refuses a scene holding a shot no cap can carry", async () => {
    const { base, scene } = await sceneOf();
    const shots = scene.shots.map((s) => (s.id === "sh_13" ? { ...s, durationSec: 45 } : s));
    const plan = planScene({ ...base, scene: { ...scene, shots } }, "whole-scene");
    assert.equal(plan.pack.ok, false);
    assert.ok(!plan.pack.ok);
    assert.equal(plan.pack.oversizeShot.shotId, "sh_13");
  });
});
