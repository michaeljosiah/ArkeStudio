import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compilePasses,
  planScene,
  type ArtifactSidecar,
  type ManifestModel,
  type Scene,
  type Shot,
} from "@arke-studio/contracts";
import { composeDispatches } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The pass compiler (issue 398): one deterministic object per dispatch pass, consumed by review
 * copy, the estimate, the durable plan and the provider payload alike — never re-derived.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

const WAN_LIKE: ManifestModel = {
  id: "wan-like",
  provider: "fal",
  capability: "video",
  displayName: "Wan-like",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {
    maxDurationSec: 15,
    maxReferenceDurationSec: 10,
    durations: { "5": "5", "10": "10", "15": "15" },
    aspects: ["16:9", "9:16"],
  },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
  modes: {
    "first-frame": { route: "acme/wan-like/image-to-video", locked: ["aspect"] },
  },
};

const shot = (n: number, durationSec: number, description = `Shot ${n}`): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec,
});

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, bundle: store.getBundle() };
}

describe("the pass compiler (issue 398)", () => {
  it("compiles deterministically, and the queue request is the compiled object, field for field", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = {
      ...production.scenes[0]!,
      shots: [shot(1, 6, "@maren-kest at the rail"), shot(2, 6, "an empty pier")],
    };
    const input = {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: {},
      model: WAN_LIKE,
      aspect: "9:16",
    };
    for (const mode of ["per-shot", "whole-scene"] as const) {
      const plan = planScene(input, mode);
      const compile = () =>
        compilePasses({ productionId: production.meta.id, scene, plan, model: WAN_LIKE, world: bundle });
      assert.deepEqual(compile(), compile(), `${mode} compiles the same passes twice`);
      const passes = compile();
      const requests = composeDispatches(WORLD_ID, production.meta.id, scene, plan, WAN_LIKE, bundle);
      assert.equal(requests.length, passes.length);
      for (const [i, request] of requests.entries()) {
        assert.deepEqual(request.params, passes[i]!.params, "the payload IS the compiled bag");
        assert.deepEqual(request.target, passes[i]!.target);
        assert.equal(request.estimatedMicroUsd, passes[i]!.estimatedMicroUsd);
        assert.deepEqual(request.landing, passes[i]!.landing);
        assert.equal(request.model, passes[i]!.model.id);
      }
    }
  });

  it("resolves the route first, and the lengths follow it", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    // 12 seconds fits the 15s text route and not the 10s reference route — the route decides.
    const referenced: Scene = { ...production.scenes[0]!, shots: [shot(1, 12, "@maren-kest waits")] };
    const bare: Scene = { ...production.scenes[0]!, shots: [shot(1, 12, "an empty pier")] };
    const compiled = (scene: Scene) => {
      const plan = planScene(
        {
          world: bundle.meta,
          productionId: production.meta.id,
          sheets: bundle.sheets,
          kits: bundle.referenceKits,
          scene,
          selections: {},
          model: WAN_LIKE,
        },
        "per-shot",
      );
      return compilePasses({ productionId: production.meta.id, scene, plan, model: WAN_LIKE, world: bundle });
    };
    const [text] = compiled(bare);
    assert.equal(text!.route.kind, "text");
    assert.equal(text!.askedSec, 15, "12s rounds up to the text route's 15");
    assert.throws(
      () => compiled(referenced),
      /12s — longer than the 10s Wan-like can make on the reference route/,
      "the same seconds refuse on the reference route, by name",
    );
  });

  it("the transmitted order, the roles, the frozen versions and the prompt agree", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1, 5, "@maren-kest at the rail")] };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: WAN_LIKE,
      },
      "per-shot",
    );
    const [pass] = compilePasses({ productionId: production.meta.id, scene, plan, model: WAN_LIKE, world: bundle });
    assert.ok(pass!.references.length > 0, "the fixture kit carries a reference");
    assert.deepEqual(
      pass!.references.map((r) => r.file),
      pass!.params["references"],
      "the typed review order IS the wire order",
    );
    const prompt = String(pass!.params["prompt"]);
    for (const reference of pass!.references) {
      assert.ok(prompt.includes(`Image ${reference.index}`), "the preamble numbers the same order");
      assert.ok(reference.role.length > 0, "every carried asset has its role in words");
      const version = (pass!.params["provenance"] as { sheets: Record<string, number> }).sheets[reference.sheetId];
      assert.equal(reference.sheetVersion, version, "review and provenance freeze one version");
      assert.equal(pass!.sources.sheets[reference.sheetId], version, "and the durable sources match");
    }
    assert.equal(pass!.sources.sceneVersion, scene.version);
  });

  it("a framed pass names what stepped aside; nothing required is dropped silently", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const artifact: ArtifactSidecar = {
      id: "ar_01J8E0000000000000000000B1",
      kind: "image",
      file: "boundary-sh_1-x.png",
      hash: "sha256:0011223344556677",
      origin: { by: "system", producedBy: "boundary-frame:tk_01J8E0000000000000000000T1" },
      links: [],
      created: CLOCK(),
    };
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1, 5, "@maren-kest at the rail")] };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: { sh_1: { trimInSec: 0, startFrameArtifactId: artifact.id } },
        model: WAN_LIKE,
        artifacts: [artifact],
      },
      "per-shot",
    );
    const [pass] = compilePasses({ productionId: production.meta.id, scene, plan, model: WAN_LIKE, world: bundle });
    assert.equal(pass!.route.kind, "frame");
    assert.equal(pass!.frame?.artifactId, artifact.id, "the frame is the durable asset, never a take id");
    assert.ok(
      pass!.dropped.some((drop) => drop.sheetId === "maren-kest" && /frame route takes one image/.test(drop.reason)),
      "the reference that stepped aside is named with its reason",
    );
  });

  it("a whole-scene pass carries its shot plan stretched to the clip actually asked for", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = {
      ...production.scenes[0]!,
      shots: [shot(1, 4, "a pier"), shot(2, 4, "a bell")],
    };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: WAN_LIKE,
      },
      "whole-scene",
    );
    const [pass] = compilePasses({ productionId: production.meta.id, scene, plan, model: WAN_LIKE, world: bundle });
    assert.equal(pass!.target.kind, "scene-pass");
    assert.equal(pass!.askedSec, 10, "8s rounds up to the route's 10");
    const shotPlan = pass!.params["shotPlan"] as Array<{ endSec: number }>;
    assert.equal(shotPlan[shotPlan.length - 1]!.endSec, 10, "the plan describes the clip that was asked for");
  });

  it("a model change is a recompile, never a stale capability assumption", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1, 5, "@maren-kest waits")] };
    const planFor = (model: ManifestModel) =>
      planScene(
        {
          world: bundle.meta,
          productionId: production.meta.id,
          sheets: bundle.sheets,
          kits: bundle.referenceKits,
          scene,
          selections: {},
          model,
        },
        "per-shot",
      );
    const noReferences: ManifestModel = {
      ...WAN_LIKE,
      id: "text-only",
      displayName: "Text only",
      accepts: { ...WAN_LIKE.accepts, referenceImages: 0 },
      modes: undefined,
    };
    const [wan] = compilePasses({
      productionId: production.meta.id,
      scene,
      plan: planFor(WAN_LIKE),
      model: WAN_LIKE,
      world: bundle,
    });
    const [text] = compilePasses({
      productionId: production.meta.id,
      scene,
      plan: planFor(noReferences),
      model: noReferences,
      world: bundle,
    });
    assert.equal(wan!.route.kind, "reference");
    assert.equal(text!.route.kind, "text", "the same scene compiles to the new model's own route");
    assert.ok(
      text!.dropped.some((drop) => drop.sheetId === "maren-kest"),
      "what the new model cannot carry is named, not assumed",
    );
  });
});
