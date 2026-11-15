import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  planScene,
  REFERENCES_NOT_FRAMES_LINE,
  START_FRAME_PREAMBLE,
  type ArtifactSidecar,
  type ManifestModel,
  type Scene,
  type Shot,
} from "@arke-studio/contracts";
import { createDispatchPlan } from "../../src/productions/plans.js";
import { setProductionClipsFrom, updateProductionMetadata } from "../../src/productions/ops.js";
import { CLIPS_FROM_SCHEMA_VERSION } from "../../src/world/commit.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Clips made from references rather than frames (issue 3185). A production, or one shot, can ask
 * for each clip to be composed from its cast, looks and place: no start frame travels, and no
 * whole-scene pass opens on the previous pass's last frame.
 */

const CLOCK = () => "2026-11-15T12:00:00.000Z";

/** Wan/seedance-shaped: a first-frame route, so frames travel and whole-scene passes chain. */
const MODEL: ManifestModel = {
  id: "seedance-like",
  provider: "fal",
  capability: "video",
  displayName: "Seedance-like",
  accepts: { referenceImages: 9, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 10, durations: { "5": "5", "10": "10" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
  modes: { "first-frame": { route: "acme/seedance-like/image-to-video", locked: ["aspect"] } },
};

const shot = (n: number, description: string, durationSec = 6, continuity?: Shot["continuity"]): Shot => ({
  id: `sh_${n}`, number: n, title: `Shot ${n}`, description, durationSec, ...(continuity ? { continuity } : {}),
});

/** A frame the person drew for the shot: no boundary extraction, so it travels wherever frames do. */
const drawn = (id: string): ArtifactSidecar => ({
  id, kind: "image", file: `frame-${id}.png`, hash: "sha256:0011223344556677",
  origin: { by: "user" }, links: [], created: CLOCK(),
});

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  const bundle = store.getBundle();
  return { dir, store, bundle, production: bundle.productions[0]! };
}

describe("clips from references (issue 3185)", () => {
  it("per shot, a clip from references sends its cast and the reference wording, never its frame", async () => {
    const { bundle, production } = await open();
    const frame = drawn("ar_01J8E0000000000000000000B1");
    const stale = "ar_01J8E0000000000000000000B9";
    const scene: Scene = { ...production.scenes[0]!, shots: [
      shot(1, "@maren-kest waits at the rail", 5),
      shot(2, "@maren-kest turns", 5, { clipsFrom: "frames" }),
      shot(3, "@maren-kest at the bell", 5),
    ] };
    const plan = planScene({
      world: bundle.meta, productionId: production.meta.id, sheets: bundle.sheets, kits: bundle.referenceKits, scene,
      // Shot 3's frame is not in the world: in a clip made from frames that refuses the plan.
      selections: { sh_1: { trimInSec: 0, startFrameArtifactId: frame.id }, sh_2: { trimInSec: 0, startFrameArtifactId: frame.id },
        sh_3: { trimInSec: 0, startFrameArtifactId: stale } },
      model: MODEL, artifacts: [frame], production: { clipsFrom: "references" },
    }, "per-shot");
    const [one, two, three] = plan.shots;
    assert.equal(one!.frame, undefined, "no start frame travels");
    assert.equal(one!.fromReferences, true);
    assert.ok(one!.bound.some((reference) => reference.sheetId === "maren-kest"), "the cast rides as a reference");
    assert.ok(one!.parts.preamble?.includes(REFERENCES_NOT_FRAMES_LINE), "the words say the pictures are not frames");
    assert.equal(two!.frame?.artifactId, frame.id, "a shot that asks for frames still opens on its own");
    assert.equal(two!.parts.preamble, START_FRAME_PREAMBLE);
    assert.equal(three!.frame, undefined);
    assert.deepEqual(plan.warnings.staleFrames, [], "a frame a clip never reads cannot refuse the plan");
    assert.deepEqual(plan.warnings.framedShots.map((entry) => entry.number), [2]);
    assert.deepEqual(plan.warnings.shotsWithoutFrame, [], "no frame is no gap for a clip made from references");
  });

  it("whole scene: a production that makes its clips from references chains nothing and every pass carries its references", async () => {
    const { store, bundle, production } = await open();
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1, "@maren-kest at the rail"), shot(2, "@maren-kest turns from @the-vigil")] };
    const create = (clipsFrom: "frames" | "references" | undefined, requestId: string) => createDispatchPlan(store, {
      worldId: WORLD_ID, productionId: production.meta.id, scene, model: MODEL, world: bundle, policy: "review-gated", requestId, clock: CLOCK,
      plan: planScene({ world: bundle.meta, productionId: production.meta.id, sheets: bundle.sheets, kits: bundle.referenceKits, scene,
        selections: {}, model: MODEL, ...(clipsFrom ? { production: { clipsFrom } } : {}) }, "whole-scene"),
    });

    // The baseline: the second pass opens on the first pass's last frame and its cast steps aside.
    const chained = await create(undefined, "01J8E0000000000000000000C1");
    assert.equal(chained.passes.length, 2, "6s + 6s against a 10s cap is two passes");
    assert.equal(chained.passes[1]!.compiled.route.kind, "frame");
    assert.deepEqual(chained.passes[1]!.dependsOn, [{ passIndex: 0, needs: "boundary-frame" }]);

    const plan = await create("references", "01J8E0000000000000000000C2");
    assert.deepEqual(plan.passes.map((pass) => pass.compiled.route.kind), ["reference", "reference"]);
    assert.deepEqual(plan.passes.map((pass) => pass.dependsOn), [[], []], "no pass waits on another's last frame");
    for (const pass of plan.passes) {
      assert.ok(pass.compiled.references.some((reference) => reference.sheetId === "maren-kest"), `pass ${pass.passIndex}: the cast rides`);
      assert.equal(pass.compiled.params["startFrame"], undefined);
      assert.equal(pass.compiled.dropped.length, 0, `pass ${pass.passIndex}: nothing steps aside for a frame`);
      const prompt = String(pass.compiled.params["prompt"]);
      assert.ok(prompt.includes(REFERENCES_NOT_FRAMES_LINE));
      assert.ok(!prompt.includes(START_FRAME_PREAMBLE));
      assert.equal(pass.carries?.fromReferences, true, "the card says the clip is made from references");
      assert.equal(pass.carries?.frame, undefined);
    }
  });

  it("whole scene: a shot that makes its clip from references opens its pass on nothing, and the next pass still chains", async () => {
    const { store, bundle, production } = await open();
    const scene: Scene = { ...production.scenes[0]!, shots: [
      shot(1, "@maren-kest at the rail"), shot(2, "@maren-kest turns", 6, { clipsFrom: "references" }), shot(3, "@maren-kest at the bell"),
    ] };
    const plan = await createDispatchPlan(store, {
      worldId: WORLD_ID, productionId: production.meta.id, scene, model: MODEL, world: bundle, policy: "review-gated",
      requestId: "01J8E0000000000000000000C3", clock: CLOCK,
      plan: planScene({ world: bundle.meta, productionId: production.meta.id, sheets: bundle.sheets, kits: bundle.referenceKits, scene,
        selections: {}, model: MODEL }, "whole-scene"),
    });
    assert.deepEqual(plan.passes.map((pass) => pass.compiled.route.kind), ["reference", "reference", "frame"]);
    assert.deepEqual(plan.passes.map((pass) => pass.dependsOn), [[], [], [{ passIndex: 1, needs: "boundary-frame" }]]);
    assert.deepEqual(plan.passes.map((pass) => pass.carries?.fromReferences ?? false), [false, true, false]);
  });

  it("the production's choice is a strict field, so writing it raises the world past older builds", async () => {
    const { dir, store, production } = await open();
    await setProductionClipsFrom(store, production.meta.id, "references");
    assert.equal(store.getBundle().productions[0]!.meta.clipsFrom, "references");
    const world = JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as { schemaVersion: number };
    assert.ok(world.schemaVersion >= CLIPS_FROM_SCHEMA_VERSION);
    // Arke's card writes the same field through the metadata path.
    await updateProductionMetadata(store, production.meta.id, { clipsFrom: "frames" }, {
      source: "world-chat", requestId: "act_01J8E0000000000000000000D1", precondition: () => null });
    assert.equal(store.getBundle().productions[0]!.meta.clipsFrom, "frames");
  });
});
