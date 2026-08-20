import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packScene, planScene, type ManifestModel, type Scene, type Shot } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Route-aware planning (issue #390): the plan prices, packs, warns, and dispatches against the
 * route each shot or pass will actually take — a reference-carrying dispatch lands on the
 * shorter reference route, and discovering that at the provider is the failure this exists to
 * prevent.
 */

const WAN_LIKE: ManifestModel = {
  id: "wan-like",
  provider: "fal",
  capability: "video",
  displayName: "Wan-like",
  accepts: { referenceImages: 2, startFrame: false, endFrame: false },
  limits: {
    maxDurationSec: 15,
    maxReferenceDurationSec: 10,
    durations: { "5": "5", "10": "10", "15": "15" },
  },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
};

const shot = (n: number, durationSec: number, description = `Shot ${n}`): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec,
});

const scene = (shots: Shot[]): Scene => ({
  id: "sc_90",
  number: 90,
  slug: "route-aware",
  title: "Route aware",
  status: "draft",
  version: 1,
  shots,
});

describe("route-aware packing and warnings (issue 390)", () => {
  it("the pack holds a reference-carrying pass to the reference ceiling, deterministically", () => {
    const carries = (shotId: string) => shotId === "sh_2";
    const packed = packScene([shot(1, 6), shot(2, 6), shot(3, 6)], 15, {
      referenceCapSec: 10,
      shotCarriesReferences: carries,
    });
    assert.ok(packed.ok);
    // Shot 1 opens the pass at 6s; shot 2 carries references, so the pass's cap drops to 10 —
    // 12s would exceed it, and the pass closes before shot 2 joins.
    assert.deepEqual(
      packed.passes.map((p) => p.plan.map((e) => e.number)),
      [[1], [2], [3]],
      "the reference ceiling closes passes retroactively; 6+6 never rides a 10s route",
    );
  });

  it("a mixed scene without the option packs exactly as before", () => {
    const packed = packScene([shot(1, 6), shot(2, 6), shot(3, 6)], 15);
    assert.ok(packed.ok);
    assert.deepEqual(packed.passes.map((p) => p.plan.map((e) => e.number)), [[1, 2], [3]]);
  });

  it("a single shot over the reference route alone refuses whole-scene, naming that cap", () => {
    const packed = packScene([shot(1, 12)], 15, {
      referenceCapSec: 10,
      shotCarriesReferences: () => true,
    });
    assert.ok(!packed.ok);
    assert.equal(packed.oversizeShot.capSec, 10, "the cap named is the route's, not the text route's");
  });

  it("a 12s shot with references is over-cap on the route it will take; without them it is fine", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    closeOnCleanup(() => store.close());
    const bundle = store.getBundle();

    const withRefs = planScene(
      {
        world: bundle.meta,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: scene([shot(1, 12, "@maren-kest waits at the rail")]),
        selections: {},
        model: WAN_LIKE,
        productionId: "saltlight",
      },
      "per-shot",
    );
    assert.ok(
      withRefs.shots[0]!.bound.length > 0,
      "the fixture kit carries a reference for the mentioned character",
    );
    assert.equal(withRefs.warnings.overlongShots.length, 1, "12s does not fit the 10s reference route");
    assert.equal(withRefs.warnings.overlongShots[0]!.longestSec, 10);
    assert.equal(withRefs.warnings.overlongShots[0]!.becauseReferences, true, "the words can say which route");

    const withoutRefs = planScene(
      {
        world: bundle.meta,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: scene([shot(1, 12, "an empty pier at slack water")]),
        selections: {},
        model: WAN_LIKE,
        productionId: "saltlight",
      },
      "per-shot",
    );
    assert.equal(withoutRefs.warnings.overlongShots.length, 0, "the text route makes 15s, so 12s is fine");
  });

  it("whole-scene passes with references never pack past the usable ceiling", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    closeOnCleanup(() => store.close());
    const bundle = store.getBundle();

    const plan = planScene(
      {
        world: bundle.meta,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: scene([
          shot(1, 6, "@maren-kest at the rail"),
          shot(2, 6, "@maren-kest turns"),
          shot(3, 6, "@maren-kest answers"),
        ]),
        selections: {},
        model: WAN_LIKE,
        productionId: "saltlight",
      },
      "whole-scene",
    );
    assert.ok(plan.pack.ok);
    for (const pass of plan.pack.passes) {
      assert.ok(pass.durationSec <= 10, `pass ${pass.index} (${pass.durationSec}s) respects the reference route`);
    }
    assert.deepEqual(plan.warnings.overlongPasses, [], "a route-aware pack leaves nothing to warn about");
  });
});
