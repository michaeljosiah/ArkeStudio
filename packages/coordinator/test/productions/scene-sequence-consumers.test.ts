import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveCut,
  linearizeSceneFlow,
  migrateLegacyScene,
  orderedShots,
  planScene,
  legacySceneView,
  type GraphScene,
  type ManifestModel,
  type ProductionBundle,
  type Scene,
  type SceneRecord,
} from "@arke-studio/contracts";
import { compileBoard } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The consumer sweep's acceptance (SPEC-029 §3.3 step 3): every ordered-shot consumer now
 * derives through `linearizeSceneFlow`, so the answers must not care which arm a scene is
 * (T-13) or what order its bytes happen to sit in (T-18/T-3) — and predecessor/next is the
 * graph's answer, stopping at the scene boundary (T-17). Proven against the consumers a
 * dispatch actually runs: the plan, the board, and the Cut, not just the walk itself.
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

async function forms(): Promise<{
  store: WorldStore;
  production: ProductionBundle;
  legacy: Scene;
  graph: GraphScene;
  permuted: GraphScene;
  planFor: (scene: SceneRecord) => ReturnType<typeof planScene>;
}> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-08-01T12:00:00.000Z" });
  closeOnCleanup(() => store.close());
  const bundle = store.getBundle();
  const production = bundle.productions.find((p) => p.meta.id === "saltlight")!;
  const legacy = legacySceneView(production.scenes.find((s) => s.id === "sc_04")!);
  const graph = migrateLegacyScene(legacy);
  // The same scene with its arrays shuffled: storage order carries no meaning (R-18).
  const permuted: GraphScene = {
    ...graph,
    flow: {
      ...graph.flow,
      nodes: [...graph.flow.nodes].reverse(),
      edges: [...graph.flow.edges].reverse(),
    },
  };
  const planFor = (scene: SceneRecord) =>
    planScene(
      {
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
      "whole-scene",
    );
  return { store, production, legacy, graph, permuted, planFor };
}

const withScene = (production: ProductionBundle, scene: SceneRecord): ProductionBundle => ({
  ...production,
  scenes: production.scenes.map((candidate) => (candidate.id === scene.id ? scene : candidate)),
});

describe("legacy and migrated forms are the same scene to every consumer (T-13)", () => {
  it("sequence, plan, board and Cut answer identically for both arms", async () => {
    const { store, production, legacy, graph, planFor } = await forms();

    assert.deepEqual(
      orderedShots(graph).map((shot) => shot.id),
      orderedShots(legacy).map((shot) => shot.id),
      "the walk is the array order the migration preserved",
    );
    assert.deepEqual(planFor(graph), planFor(legacy), "prompts, references and pass boundaries agree");
    assert.deepEqual(
      await compileBoard(store, production, graph, store.getBundle().artifacts),
      await compileBoard(store, production, legacy, store.getBundle().artifacts),
      "the board compiles to the same bytes",
    );
    assert.deepEqual(
      deriveCut(withScene(production, graph)),
      deriveCut(withScene(production, legacy)),
      "the Cut derives the same entries",
    );
  });
});

describe("storage order is not playback order, all the way to the consumers (R-18; T-3)", () => {
  it("permuting nodes[] and edges[] leaves sequence, plan, board and Cut identical", async () => {
    const { store, production, graph, permuted, planFor } = await forms();

    assert.deepEqual(
      orderedShots(permuted).map((shot) => shot.id),
      orderedShots(graph).map((shot) => shot.id),
    );
    assert.deepEqual(planFor(permuted), planFor(graph));
    assert.deepEqual(
      await compileBoard(store, production, permuted, store.getBundle().artifacts),
      await compileBoard(store, production, graph, store.getBundle().artifacts),
    );
    assert.deepEqual(deriveCut(withScene(production, permuted)), deriveCut(withScene(production, graph)));
  });
});

describe("predecessor and next follow the graph and stop at the scene boundary (T-17)", () => {
  it("each shot's predecessor is the edge's answer, and the first shot has none", async () => {
    const { legacy, permuted } = await forms();
    const sequence = linearizeSceneFlow(permuted);
    assert.ok(sequence.kind === "linear");

    // The edges decide what follows what, even with the arrays reversed on disk.
    const ids = sequence.shots.map((pair) => pair.shot.id);
    assert.deepEqual(ids, legacy.shots.map((shot) => shot.id));
    const nextOf = new Map(permuted.flow.edges.map((edge) => [edge.from.nodeId, edge.to.nodeId]));
    for (let index = 1; index < sequence.shots.length; index += 1) {
      assert.equal(
        nextOf.get(sequence.shots[index - 1]!.nodeId),
        sequence.shots[index]!.nodeId,
        `${sequence.shots[index]!.shot.id} follows exactly the shot the edge names`,
      );
    }
    // The boundary: the only thing before the first shot is the scene's own Entry — never
    // another scene's last shot, whatever the production's scene order says.
    assert.ok(sequence.shots.length > 0, "the fixture scene has shots to walk");
    const first = sequence.shots[0]!;
    const into = permuted.flow.edges.filter((edge) => edge.to.nodeId === first.nodeId);
    assert.deepEqual(
      into.map((edge) => edge.from.nodeId),
      [permuted.flow.entryNodeId],
    );
  });

  it("the sequence owns order inside the scene only — no other scene's shots appear (R-19)", async () => {
    const { production, permuted } = await forms();
    const others = new Set(
      production.scenes.filter((scene) => scene.id !== permuted.id).flatMap((scene) => orderedShots(scene).map((shot) => shot.id)),
    );
    for (const shot of orderedShots(permuted)) {
      assert.ok(!others.has(shot.id), `${shot.id} belongs to this scene alone`);
    }
  });
});
