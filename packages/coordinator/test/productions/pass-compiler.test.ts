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

  it("provider padding does not extend the last content segment", async () => {
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
    assert.equal(shotPlan[shotPlan.length - 1]!.endSec, 8, "the content ends at its authored boundary");
    assert.equal(pass!.params["providerPaddingSec"], 2);
  });

  it("keeps authored timing inside each shot prompt and out of the machine shot plan", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const first: Shot = {
      ...shot(1, 5, "a pier in fog"),
      intent: "Uncertain but committed",
      beats: [
        { span: "0–2s", text: "The rope stays taut" },
        { span: "2–5s", text: "A hand lets go" },
      ],
    };
    const second: Shot = {
      ...shot(2, 5, "a bell above the water"),
      intent: "Release",
      beats: [{ span: "throughout", text: "The bell recedes into haze" }],
    };
    const scene: Scene = { ...production.scenes[0]!, shots: [first, second] };
    const planFor = (mode: "per-shot" | "whole-scene") =>
      planScene(
        {
          world: bundle.meta,
          productionId: production.meta.id,
          sheets: bundle.sheets,
          kits: bundle.referenceKits,
          scene,
          selections: {},
          model: WAN_LIKE,
        },
        mode,
      );

    const perShot = compilePasses({
      productionId: production.meta.id,
      scene,
      plan: planFor("per-shot"),
      model: WAN_LIKE,
      world: bundle,
    });
    assert.equal(perShot.length, 2);
    const firstPrompt = String(perShot[0]!.params["prompt"]);
    const secondPrompt = String(perShot[1]!.params["prompt"]);
    assert.match(firstPrompt, /infer unset camera choices from this; explicit camera settings win/);
    assert.match(firstPrompt, /Shot timing 0–2s: The rope stays taut\./);
    assert.match(firstPrompt, /Shot timing 2–5s: A hand lets go\./);
    assert.ok(!firstPrompt.includes("The bell recedes"), "one shot never receives another shot's timing");
    assert.match(secondPrompt, /Shot timing throughout: The bell recedes into haze\./);
    assert.ok(!secondPrompt.includes("The rope stays taut"), "the isolation works in both directions");

    const [wholeScene] = compilePasses({
      productionId: production.meta.id,
      scene,
      plan: planFor("whole-scene"),
      model: WAN_LIKE,
      world: bundle,
    });
    const wholePrompt = String(wholeScene!.params["prompt"]);
    for (const authored of ["Uncertain but committed", "The rope stays taut", "A hand lets go", "Release", "The bell recedes into haze"]) {
      assert.ok(wholePrompt.includes(authored), `the whole-scene prompt carries: ${authored}`);
    }
    const shotRows = wholePrompt.match(/^\[shot \d+ ·[^\n]*$/gm) ?? [];
    assert.equal(shotRows.length, 2, "authored timing adds no shot wrapper");
    assert.match(shotRows[0]!, /Uncertain but committed.*The rope stays taut.*A hand lets go/);
    assert.ok(!shotRows[0]!.includes("The bell recedes"), "shot 1 contains only shot 1's timing");
    assert.match(shotRows[1]!, /Release.*The bell recedes into haze/);
    assert.ok(!shotRows[1]!.includes("The rope stays taut"), "shot 2 contains only shot 2's timing");
    const shotPlan = wholeScene!.params["shotPlan"] as Array<{ shotId: string }>;
    assert.deepEqual(shotPlan.map((entry) => entry.shotId), [first.id, second.id], "authored timing adds no boundary");
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

  /* The dispatch dialog states who rides and who rides in a look (design 67). It reads the
     compiled reference, so the compiled reference has to carry the attachment structurally —
     the role phrase says the same thing in the prompt's words, and a screen matching that prose
     would be reading a sentence written for a model as if it were an enum. */
  it("carries the subject's name and its attachment mode onto every compiled reference", async () => {
    const { store, bundle } = await open();
    void store;
    const production = bundle.productions[0]!;
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1, 6, "@maren-kest at the rail")] };
    const compile = (kits: typeof bundle.referenceKits) =>
      compilePasses({
        productionId: production.meta.id,
        scene,
        plan: planScene(
          {
            world: bundle.meta,
            productionId: production.meta.id,
            sheets: bundle.sheets,
            kits,
            scene,
            selections: {},
            model: WAN_LIKE,
          },
          "per-shot",
        ),
        model: WAN_LIKE,
        world: bundle,
      });

    const plain = compile(bundle.referenceKits)[0]!.references.find((r) => r.sheetId === "maren-kest")!;
    assert.equal(plain.subject, "Maren Kest", "a name, never a slug");
    assert.notEqual(plain.mode, "scoped-look");

    const withLook = bundle.referenceKits.map((kit) =>
      kit.sheetId === "maren-kest"
        ? {
            ...kit,
            looks: [
              {
                id: "council-coat",
                file: "looks/council-coat.png",
                kind: "costume" as const,
                prompt: "Formal council coat",
                acceptedAt: CLOCK(),
                attachedTo: { kind: "production" as const, productionId: production.meta.id },
              },
            ],
          }
        : kit,
    );
    const carried = compile(withLook)[0]!.references.find((r) => r.sheetId === "maren-kest")!;
    assert.equal(carried.mode, "scoped-look", "the production's own look is legible without parsing prose");
    assert.equal(carried.subject, "Maren Kest");
    assert.ok(carried.file.includes("council-coat"), "and it is the look that actually travels");
  });
});
