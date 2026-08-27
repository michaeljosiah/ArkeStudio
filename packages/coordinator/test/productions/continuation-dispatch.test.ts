import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compilePasses,
  continueDispatchFor,
  planScene,
  type ManifestModel,
  type Scene,
  type Selections,
  type Shot,
  type Take,
  type WorldBundle,
} from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Continuation dispatch (SPEC-019 R-50..R-52, T-31; issue 461).
 *
 * The issue this closes was not "the validation is missing" — the guards and the supersession
 * had been correct for a while. It was that nothing produced the edge they read, so both were
 * unreachable and looked finished from the code alone. These tests are therefore mostly about
 * REACHABILITY: a shot that asks to continue must come out of planning and compilation as a job
 * carrying `continuedFrom`, because that param is the only thing that makes the rest of the
 * capability run at all.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

const VEO_LIKE: ManifestModel = {
  id: "veo-like",
  provider: "fal",
  capability: "video",
  displayName: "Veo-like",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 8, durations: { "4": "4s", "6": "6s", "8": "8s" }, aspects: ["16:9", "9:16"] },
  pricing: { kind: "perSecond", microUsdPerSecond: 200000 },
  modes: {
    generate: { locked: [] },
    continue: { route: "acme/veo-like/extend-video", locked: ["aspect"], sentinels: { aspect: "auto" } },
  },
};

/** The same row without the sibling route: the model-side refusal (R-34) rather than a graph one. */
const TEXT_ONLY: ManifestModel = { ...VEO_LIKE, modes: { generate: { locked: [] } } };

/** A row that takes references, to prove a continuation displaces them rather than riding beside. */
const REFERENCED: ManifestModel = { ...VEO_LIKE, accepts: { referenceImages: 4, startFrame: false, endFrame: false } };

const TK_1 = "tk_01J8F0000000000000000000B1";
const TK_2 = "tk_01J8F0000000000000000000B2";
const TK_PASS = "tk_01J8F0000000000000000000B3";

const shot = (n: number, description: string, continuesPrevious = false): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec: 6,
  ...(continuesPrevious ? { continuity: { continuesPrevious: true } } : {}),
});

const take = (id: string, over: Partial<Take> = {}): Take =>
  ({
    id,
    jobId: "jb_01J8F0000000000000000000J1",
    coversShots: ["sh_1"],
    kind: "clip",
    provider: "fal",
    model: "veo-like",
    provenance: { canonRevision: 1, sheets: {} },
    references: [],
    params: {},
    media: "clip.mp4",
    cost: { estimatedMicroUsd: 0, actualMicroUsd: null },
    dispatchedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }) as unknown as Take;

/*
 * One world for the file, not one per case.
 *
 * Nothing here writes: planning and compilation are pure functions over a bundle, and the cases
 * differ only in the takes and selections they hand in. Opening a temp world per case cost ninety
 * seconds of fixture for six assertions.
 */
let world: Promise<{ store: WorldStore; bundle: WorldBundle }> | null = null;
function open() {
  world ??= (async () => {
    const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
    closeOnCleanup(() => store.close());
    return { store, bundle: store.getBundle() };
  })();
  return world;
}

/** One scene, shot 2 asking to continue shot 1, with whatever selections and takes the case needs. */
async function planFor(
  over: {
    model?: ManifestModel;
    selections?: Selections;
    takes?: readonly Take[];
    mode?: "per-shot" | "whole-scene";
    shots?: Shot[];
  } = {},
) {
  const { bundle } = await open();
  const production = bundle.productions[0]!;
  const scene: Scene = {
    ...production.scenes[0]!,
    shots: over.shots ?? [shot(1, "an empty pier"), shot(2, "the tide turns", true)],
  };
  const model = over.model ?? VEO_LIKE;
  const plan = planScene(
    {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: over.selections ?? { sh_1: { acceptedTakeId: TK_1, trimInSec: 0 } },
      takes: over.takes ?? [take(TK_1)],
      model,
      aspect: "16:9",
    },
    over.mode ?? "per-shot",
  );
  return {
    plan,
    scene,
    model,
    bundle,
    productionId: production.meta.id,
    compile: () => compilePasses({ productionId: production.meta.id, scene, plan, model, world: bundle }),
  };
}

describe("continuation dispatch (SPEC-019 T-31, issue 461)", () => {
  it("puts continuedFrom on the job, which is the whole point — nothing wrote it before", async () => {
    const { plan, compile } = await planFor();

    const continuing = plan.shots[1]!;
    assert.equal(continuing.continuation?.takeId, TK_1, "the plan resolved the exact predecessor take");
    assert.equal(continuing.continuation?.fromShotNumber, 1);

    const pass = compile()[1]!;
    assert.deepEqual(pass.route, {
      kind: "continuation",
      endpoint: "acme/veo-like/extend-video",
      predecessorTakeId: TK_1,
    });
    assert.equal(pass.params["continuedFrom"], TK_1, "the param arrival reads is actually written");
    assert.equal(pass.params["taskMode"], "continue");
    assert.equal(pass.params["route"], "acme/veo-like/extend-video");
    // The footage decides the shape, so a chosen ratio must not ride beside it (R-33).
    assert.equal(pass.params["aspect"], undefined, "the locked aspect is dropped, not sent");
    assert.deepEqual(pass.params["references"], [], "the extend route declares no image field");

    // The shot that did NOT ask is untouched — continuation is opt-in, never a default (R-50).
    const ordinary = compile()[0]!;
    assert.equal(ordinary.params["continuedFrom"], undefined);
    assert.equal(ordinary.route.kind, "text");
  });

  it("names every refusal rather than quietly generating from scratch (R-51, R-52, R-34)", async () => {
    const reasonFor = async (over: Parameters<typeof planFor>[0]) => {
      const { plan } = await planFor(over);
      const named = plan.warnings.continuationUnavailable;
      assert.equal(named.length, 1, "the refusal is stated once, against the shot that asked");
      assert.equal(plan.shots[1]?.continuation, undefined, "and nothing resolved");
      return named[0]!.reason;
    };

    // R-51: the dependency is on a specific take and there is not one yet.
    assert.match(await reasonFor({ selections: {} }), /shot 1 has no accepted take/);
    assert.match(await reasonFor({ takes: [] }), /no longer available/);

    // R-52: the one hop, which is the decision this refusal exists to hold to something testable.
    assert.match(
      await reasonFor({ takes: [take(TK_1, { continuedFrom: TK_2 })] }),
      /stops at one hop/,
    );

    // R-34: the model, not the graph. Offered-and-disabled with a reason teaches something.
    assert.match(await reasonFor({ model: TEXT_ONLY }), /Veo-like has no continue route/);

    // A pass covers several shots at once; extension takes one clip.
    assert.match(await reasonFor({ mode: "whole-scene" }), /whole-scene pass/);

    // Nothing to continue: the first shot in the scene asked.
    assert.match(
      await reasonFor({ shots: [shot(1, "an empty pier", true), shot(2, "the tide turns")] }),
      /nothing before it/,
    );

    // Footage that was never delivered cannot be extended, however sound the graph is.
    const noMedia = take(TK_1);
    delete (noMedia as { media?: string }).media;
    assert.match(await reasonFor({ takes: [noMedia] }), /no footage to extend/);
  });

  it("displaces the references and says so, rather than thinning them in silence", async () => {
    const { plan, compile } = await planFor({
      model: REFERENCED,
      shots: [shot(1, "an empty pier"), shot(2, "@maren-kest at the rail", true)],
    });

    const continuing = plan.shots[1]!;
    assert.ok(continuing.budget.carried.length > 0, "the subject would otherwise have carried a reference");
    assert.deepEqual(continuing.bound, [], "and nothing rides on the extend route");

    const named = plan.warnings.continuedShots;
    assert.equal(named.length, 1);
    assert.equal(named[0]!.fromTakeId, TK_1);
    assert.ok(named[0]!.setAside.includes("maren-kest"), "the subject that stepped aside is named");

    const dropped = compile()[1]!.dropped;
    assert.ok(
      dropped.some((entry) => /extend route takes one video/.test(entry.reason)),
      "and the compiled object carries the same reason",
    );
  });

  it("carries a pass segment's range, so the dispatch cuts before it sends (R-50, T-32)", async () => {
    /*
     * A segment owns a range into media holding several shots (SPEC-013 R-3). Sending the backing
     * file would extend whatever sits at its end, which is usually a different shot entirely.
     *
     * The segment deliberately carries NO `media` of its own, because arrival writes that field
     * onto the pass take alone. A fixture that gave the segment one would let a resolver reading
     * `predecessor.media` pass here and refuse every real segment in the product — which is how
     * `materialiseForContinuation` carried the same mistake for as long as nothing called it.
     */
    const segment = take(TK_1, {
      segment: { passTakeId: TK_PASS, inSec: 6, outSec: 12 },
    } as Partial<Take>);
    delete (segment as { media?: string }).media;
    const pass = take(TK_PASS, { coversShots: ["sh_1", "sh_2"] } as Partial<Take>);
    const { plan } = await planFor({ takes: [segment, pass] });

    const resolved = plan.shots[1]!.continuation!;
    assert.equal(resolved.takeId, TK_1, "the edge names the segment, which is what was selected");
    assert.equal(resolved.mediaTakeId, TK_PASS, "but the bytes live with the pass that produced it");
    assert.equal(resolved.media, "clip.mp4", "read off the pass, never off the segment");
    assert.deepEqual(resolved.segment, { inSec: 6, outSec: 12 });
  });

  it("refuses a segment whose pass is gone rather than composing a path out of nothing", async () => {
    const orphan = take(TK_1, { segment: { passTakeId: TK_PASS, inSec: 6, outSec: 12 } } as Partial<Take>);
    delete (orphan as { media?: string }).media;
    const { plan } = await planFor({ takes: [orphan] });
    assert.match(plan.warnings.continuationUnavailable[0]!.reason, /no footage to extend/);
  });

  it("a continued shot is not also a shot missing its start frame", async () => {
    // Both warnings would otherwise fire on the same shot, telling the user to fix a gap in an
    // input this route does not have.
    const { plan } = await planFor();
    assert.ok(
      !plan.warnings.shotsWithoutFrame.some((entry) => entry.shotId === "sh_2"),
      "it opens on footage, so there is no frame-shaped hole in it",
    );
  });

  it("one query answers route and locks, or refuses — the pre-submit gate", () => {
    assert.deepEqual(continueDispatchFor(VEO_LIKE), {
      route: "acme/veo-like/extend-video",
      field: "video_url",
      locked: ["aspect"],
    });
    assert.equal(continueDispatchFor(TEXT_ONLY), null, "a generate-only row refuses before submit");
  });
});
