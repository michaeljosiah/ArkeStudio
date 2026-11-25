import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { legacySceneView, newId, planScene, type ManifestModel, type Scene } from "@arke-studio/contracts";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { currentWorldObservation } from "../../src/world-chat/actions.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
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

  it("cuts the passes to the scene's board target under a longer cap", async () => {
    // 19.5s under a 30s cap is one pass; a 10s target is the author asking for shorter clips, and
    // the passes follow the boards it packs rather than the route's cap.
    const { base, scene } = await sceneOf();
    const aimed: Scene = { ...scene, boards: { splits: [], merges: [], targetSec: 10 } };
    const passes = passShots(planScene({ ...base, scene: aimed }, "whole-scene"));
    assert.ok(passes.length >= 2, `a 10s target splits a 19.5s scene, got ${passes.length}`);
    const seconds = new Map(scene.shots.map((s) => [s.id, s.durationSec ?? 4]));
    for (const pass of passes) {
      const length = pass.reduce((sum, id) => sum + seconds.get(id)!, 0);
      assert.ok(pass.length === 1 || length <= 10, `pass ${pass.join(",")} runs ${length}s`);
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

describe("Arke reads the boards as they are packed", () => {
  type Packed = { model: string; capSec: number; targetSec: number | null;
    boards?: Array<{ letter: string; shots: Array<{ shotId: string; number: number | null }>; seconds: number; startsBecause: string | null }> };
  const lease = () => new QueryLeaseRegistry(() => WORLD_ID).mint({ worldId: WORLD_ID, conversationId: newId("cv"), runId: newId("run") });

  it("shows each board's shots, seconds and reason under the scene's target", async () => {
    const { store } = await sceneOf();
    const bundle = store.getBundle();
    // The record on disk is untouched: the read is handed a bundle whose scene carries a target.
    const aimed = {
      ...bundle,
      productions: bundle.productions.map((p) => p.meta.id !== "saltlight" ? p : {
        ...p,
        scenes: p.scenes.map((s) => s.id === "sc_04" ? { ...s, boards: { splits: [], merges: [], targetSec: 10 } } : s),
      }),
    };
    const reads = new WorldChatTargetReads({ getBoardLimits: async () => ({ model: MODEL.id, capSec: 30 }) });
    const page = await reads.call(lease(), aimed, "get_scene_boards", { productionId: "saltlight", sceneId: "sc_04" });
    const packed = (page.result.items[0] as { packed: Packed }).packed;
    assert.equal(packed.capSec, 30);
    assert.equal(packed.targetSec, 10);
    assert.ok(packed.boards && packed.boards.length >= 2, "a 10s target splits the 19.5s scene");
    assert.deepEqual(packed.boards.flatMap((board) => board.shots.map((entry) => entry.shotId)), ["sh_12", "sh_13", "sh_14", "sh_15"]);
    assert.ok(packed.boards.slice(1).some((board) => board.startsBecause === "target length"));

    const bare = await new WorldChatTargetReads().call(lease(), bundle, "get_scene_boards", { productionId: "saltlight", sceneId: "sc_04" });
    assert.equal((bare.result.items[0] as { packed: unknown }).packed, null, "no host routes, no packing guessed");
    const unrouted = await new WorldChatTargetReads({ getBoardLimits: async () => null })
      .call(lease(), bundle, "get_scene_boards", { productionId: "saltlight", sceneId: "sc_04" });
    assert.match((unrouted.result.items[0] as { packed: { unavailable: string } }).packed.unavailable, /No video route/);
  });

  it("a change that cites the boards, shots or stage read is checked against the same fence (0.5.140)", async () => {
    // Arke read Gold on Gold's boards, prepared the target, a split and three shot rewrites, and lost
    // the turn: nothing could say whether a cited boards, shots or stage read was still current.
    const { store } = await sceneOf();
    const reads = new WorldChatTargetReads({ getBoardLimits: async () => ({ model: MODEL.id, capSec: 30 }) });
    for (const tool of ["get_scene_boards", "get_scene_shots", "get_scene_stage"] as const) {
      const read = (await reads.call(lease(), store.getBundle(), tool, { productionId: "saltlight", sceneId: "sc_04" })).result;
      const now = currentWorldObservation(store, read.target.requirement, read.target.id);
      assert.ok(now, `${tool} has a fence to check against`);
      assert.equal(now!.target, read.target.id);
      assert.equal(now!.fence, read.observedRevisionOrDigest, `${tool}: unchanged, so current`);
    }
    // The route's limits shape the packed boards, not the fence: a cap the check cannot see changes nothing.
    const narrower = (await new WorldChatTargetReads({ getBoardLimits: async () => ({ model: MODEL.id, capSec: 8 }) })
      .call(lease(), store.getBundle(), "get_scene_boards", { productionId: "saltlight", sceneId: "sc_04" })).result;
    assert.equal(currentWorldObservation(store, "boards", narrower.target.id)!.fence, narrower.observedRevisionOrDigest);
    assert.equal(currentWorldObservation(store, "boards", "saltlight:sc_04:shots"), null, "a target of another kind is not this one");
  });

  it("packs to the route's sheet panel count, as the frame run cuts its sheets", async () => {
    const { store } = await sceneOf();
    const reads = new WorldChatTargetReads({ getBoardLimits: async () => ({ model: MODEL.id, capSec: 30, panelCap: 2 }) });
    const page = await reads.call(lease(), store.getBundle(), "get_scene_boards", { productionId: "saltlight", sceneId: "sc_04" });
    const packed = (page.result.items[0] as { packed: Packed & { panelCap?: number } }).packed;
    assert.equal(packed.panelCap, 2);
    assert.ok(packed.boards!.every((board) => board.shots.length <= 2));
    assert.equal(packed.boards![1]!.startsBecause, "panel limit");
  });
});
