import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  packScene,
  parseMentions,
  planScene,
  promptFor,
  resolveCast,
  assemblePrompt,
  overrideStaleAgainst,
  SceneSchema,
  type ManifestModel,
  type Scene,
  type Shot,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import {
  compileBoard,
  composeDispatches,
  createChapter,
  createProduction,
  exportBoard,
  landBoard,
  reorderChapters,
  saveChapter,
  setPromptOverride,
} from "../../src/productions/ops.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store, gate: new ProposalManager(store) };
}

const VIDEO_MODEL: ManifestModel = {
  id: "seedance-2.0",
  provider: "fal",
  capability: "video",
  displayName: "Seedance 2.0",
  accepts: { referenceImages: 2, startFrame: true, endFrame: true },
  limits: { maxDurationSec: 15 },
  pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
};

const shot = (n: number, durationSec: number, description = `Shot ${n}`): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec,
});

describe("pass packing (R-18, R-19, D9, D10, §3.2)", () => {
  it("a scene under the cap is one pass; 19.5s against 15 is two, contents stated", () => {
    const single = packScene([shot(1, 6), shot(2, 7)], 15);
    assert.ok(single.ok && single.passes.length === 1);

    const packed = packScene([shot(1, 6.5), shot(2, 6.5), shot(3, 6.5)], 15);
    assert.ok(packed.ok);
    assert.equal(packed.passes.length, 2);
    assert.deepEqual(packed.passes[0]!.plan.map((p) => p.number), [1, 2], "greedy keeps the first pass longest");
    assert.deepEqual(packed.passes[1]!.plan.map((p) => p.number), [3]);
    assert.equal(packed.totalSec, 19.5);
  });

  it("a shot is never split, order is preserved, and boundaries sum to the pass duration", () => {
    const packed = packScene([shot(1, 8), shot(2, 8), shot(3, 4), shot(4, 6)], 15);
    assert.ok(packed.ok);
    for (const pass of packed.passes) {
      let cursor = 0;
      for (const entry of pass.plan) {
        assert.equal(entry.startSec, cursor, "boundaries are contiguous — computed before dispatch (R-19)");
        cursor = entry.endSec;
      }
      assert.equal(cursor, pass.durationSec);
      assert.ok(pass.durationSec <= 15);
    }
    const order = packed.passes.flatMap((p) => p.plan.map((e) => e.number));
    assert.deepEqual(order, [1, 2, 3, 4], "order preserved across passes");
  });

  it("a single oversize shot disables whole-scene and names the shot (D10)", () => {
    const packed = packScene([shot(1, 6), shot(2, 22)], 15);
    assert.ok(!packed.ok);
    assert.equal(packed.oversizeShot.number, 2);
    assert.equal(packed.oversizeShot.durationSec, 22);
    assert.equal(packed.oversizeShot.capSec, 15);
  });
});

describe("mentions (R-9, D5, §3.2)", () => {
  it("cast derives from mentions alone, in order of first appearance", async () => {
    const { store } = await open();
    const sheets = store.getBundle().sheets;
    const { cast, unknown } = resolveCast("@bray-half-hitch waits while @maren-kest listens. @maren-kest nods.", sheets);
    assert.deepEqual(cast.map((c) => c.sheet.id), ["bray-half-hitch", "maren-kest"]);
    assert.deepEqual(unknown, []);
    await store.close();
  });

  it("a renamed sheet still resolves — ids are stable (SPEC-007 payoff)", async () => {
    const { store, gate } = await open();
    const { stageSheetRename } = await import("../../src/sheets/authoring.js");
    const staged = await stageSheetRename(store, gate, { path: "characters/maren-kest.md", name: "Maren Kestrel" });
    await gate.accept(staged.id);
    const { cast } = resolveCast("@maren-kest at the rail", store.getBundle().sheets);
    assert.equal(cast[0]?.sheet.name, "Maren Kestrel", "the mention resolves to the renamed sheet");
    await store.close();
  });

  it("a retired sheet resolves and is named at dispatch; an unknown mention is reported", async () => {
    const { store } = await open();
    await store.retire("characters/the-chorister.md", "test");
    const bundle = store.getBundle();
    const scene: Scene = {
      id: "sc_90",
      number: 90,
      slug: "test",
      title: "Test",
      status: "draft",
      version: 1,
      shots: [shot(1, 6, "@the-chorister hums while @nobody-real watches")],
    };
    const plan = planScene(
      { world: bundle.meta, sheets: bundle.sheets, kits: bundle.referenceKits, scene, selections: {}, model: VIDEO_MODEL },
      "per-shot",
    );
    assert.deepEqual(plan.warnings.retiredCitations, ["The Chorister"]);
    assert.deepEqual(plan.warnings.unknownMentions, ["nobody-real"], "never silently dropped");
    await store.close();
  });

  it("parseMentions dedupes and keeps order", () => {
    assert.deepEqual(parseMentions("@a then @b then @a again"), ["a", "b"]);
  });
});

describe("prompt assembly and overrides (R-14..R-16, D6, D7, §3.2)", () => {
  const makeScene = (shots: Shot[]): Scene => ({
    id: "sc_91",
    number: 91,
    slug: "t",
    title: "T",
    status: "draft",
    version: 1,
    inherits: { location: "the-vigil", timeOfDay: "night" },
    shots,
  });

  it("assembles from the world: tone, location look, mentions expanded, camera and audio", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      camera: "slow push-in, MCU",
      audio: { kind: "vo", speaker: "maren-kest", line: "the verse, under the water" },
    };
    const prompt = assemblePrompt(bundle.meta, bundle.sheets, makeScene([s]), s);
    assert.match(prompt, /quiet dread/);
    assert.match(prompt, /Maren Kest \(Salt-crusted braids/);
    assert.match(prompt, /slow push-in/);
    assert.match(prompt, /the verse, under the water/);
    assert.ok(!prompt.includes("@maren-kest"), "mentions are expanded, never sent raw");
    await store.close();
  });

  it("reset restores the assembled form exactly; staleness flags and clears (R-15, R-16)", async () => {
    const { store, gate } = await open();
    let bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const sceneFile = `${String(scene.number).padStart(2, "0")}-${scene.slug}`;
    const target = scene.shots[0]!;
    const assembled = assemblePrompt(bundle.meta, bundle.sheets, scene, target);

    await setPromptOverride(store, bundle, {
      productionId: production.meta.id,
      sceneFile,
      shotId: target.id,
      text: "Something else entirely — my tuned wording.",
    });
    bundle = store.getBundle();
    let liveShot = bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!.shots.find((s) => s.id === target.id)!;
    assert.equal(promptFor(bundle.meta, bundle.sheets, scene, liveShot).overridden, true);
    assert.equal(
      bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!.version,
      scene.version,
      "an override is production output — no version cut (R-5 discipline)",
    );
    assert.equal(overrideStaleAgainst(liveShot, bundle.sheets).length, 0);

    // The cited sheet advances: the override goes stale and says which sheet moved (R-16).
    const { stageSheetRename } = await import("../../src/sheets/authoring.js");
    const staged = await stageSheetRename(store, gate, { path: "characters/maren-kest.md", name: "Maren K" });
    await gate.accept(staged.id);
    bundle = store.getBundle();
    liveShot = bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!.shots.find((s) => s.id === target.id)!;
    const stale = overrideStaleAgainst(liveShot, bundle.sheets);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.sheetId, "maren-kest");
    assert.ok(stale[0]!.to > stale[0]!.from);

    // Reset: the override clears; the assembled form returns exactly; canon untouched throughout.
    await setPromptOverride(store, bundle, { productionId: production.meta.id, sceneFile, shotId: target.id, text: null });
    bundle = store.getBundle();
    liveShot = bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!.shots.find((s) => s.id === target.id)!;
    const restored = promptFor(bundle.meta, bundle.sheets, scene, liveShot);
    assert.equal(restored.overridden, false);
    assert.equal(
      restored.text,
      assembled.replace("Maren Kest", "Maren K"),
      "the assembled form re-derives from the world as it is now",
    );
    assert.equal(bundle.meta.canonRevision >= 42, true, "canon advanced only by the gated rename, never the prompt");
    await store.close();
  });
});

describe("boards (R-11..R-13, D8, §3.2)", () => {
  it("identical scene state compiles byte-identically; export files exactly one artifact", async () => {
    const { dir, store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const a = await compileBoard(store, production, scene);
    const b = await compileBoard(store, production, scene);
    assert.deepEqual(Buffer.from(a), Buffer.from(b), "local, free, repeatable (R-11)");

    const sceneFile = `${String(scene.number).padStart(2, "0")}-${scene.slug}`;
    const artifactsBefore = (await readdir(join(dir, "artifacts")).catch(() => [] as string[])).sort();
    await landBoard(store, production.meta.id, sceneFile, a, CLOCK);
    await landBoard(store, production.meta.id, sceneFile, a, CLOCK);
    await landBoard(store, production.meta.id, sceneFile, a, CLOCK);
    const afterRecompiles = (await readdir(join(dir, "artifacts")).catch(() => [] as string[])).sort();
    assert.deepEqual(afterRecompiles, artifactsBefore, "recompiling files no artifacts (R-13)");

    const landed = store.getBundle().productions[0]!.scenes.find((s) => s.id === scene.id)!;
    assert.ok(landed.board);
    assert.equal(landed.board.version, scene.version, "records the scene version it was compiled from (R-12)");

    await exportBoard(store, production.meta.id, scene, a, CLOCK);
    const afterExport = await readdir(join(dir, "artifacts"));
    const added = afterExport.filter((f) => !artifactsBefore.includes(f));
    assert.equal(added.filter((f) => f.endsWith(".png")).length, 1);
    assert.equal(added.filter((f) => f.endsWith(".json")).length, 1, "exactly one, with its sidecar");
    await store.close();
  });
});

describe("the dispatch dialog warnings (R-20, D12, §3.2)", () => {
  it("each warning names its entity; a clean dispatch produces none", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    // The fixture scene: maren (locked, has designated compilation) + the-vigil location.
    const plan = planScene(
      {
        world: bundle.meta,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    // sh_12 has a start frame in fixture selections; any others may not.
    for (const w of plan.warnings.shotsWithoutFrame) assert.ok(w.number > 0, "named by number");
    assert.ok(!plan.warnings.shotsWithoutFrame.some((w) => w.shotId === "sh_12"), "sh_12 has its frame");
    // The one-reference cap drops someone, and says who.
    const tight = planScene(
      {
        world: bundle.meta,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: { ...VIDEO_MODEL, accepts: { ...VIDEO_MODEL.accepts, referenceImages: 0 } },
      },
      "per-shot",
    );
    assert.ok(tight.warnings.droppedReferences.length > 0);
    assert.ok(tight.warnings.droppedReferences.every((d) => d.sheetId.length > 0));
    await store.close();
  });
});

describe("whole-scene reference budgeting", () => {
  it("uses one authoritative budget for warnings and each submitted pass", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [
        { ...base.shots[0]!, id: "sh_90", number: 90, description: "@maren-kest at the rail", durationSec: 4 },
        { ...base.shots[0]!, id: "sh_91", number: 91, description: "@the-chorister at the bell", durationSec: 4 },
      ],
    };
    const model = { ...VIDEO_MODEL, accepts: { ...VIDEO_MODEL.accepts, referenceImages: 1 } };
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model,
      },
      "whole-scene",
    );
    const [request] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, model, bundle);
    const references = request!.params["references"] as string[];
    assert.equal(references.length, 1);
    assert.equal(plan.passReferences[0]!.references[0]!.file, references[0]);
    assert.deepEqual(plan.warnings.droppedReferences, plan.passReferences[0]!.budget.dropped);
    assert.equal(Object.keys((request!.params["provenance"] as { sheets: object }).sheets).length, 1);
    await store.close();
  });

  it("dispatches at the size the plan priced, in both modes", async () => {
    // The failure this prevents: the dialog prices 1080p, the queued job carries no resolution,
    // and the provider runs its own default — the estimate and the request disagreeing about
    // the same job, with the difference landing on the bill.
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [{ ...base.shots[0]!, id: "sh_94", number: 94, description: "@maren-kest", durationSec: 6 }],
    };
    const model: ManifestModel = {
      ...VIDEO_MODEL,
      pricing: { kind: "perSecond", microUsdPerSecond: 21667, byResolution: { "1080p": 43333 } },
    };
    const input = {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: {},
      model,
      resolution: "1080p",
    };
    for (const mode of ["per-shot", "whole-scene"] as const) {
      const plan = planScene(input, mode);
      const [request] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, model, bundle);
      assert.equal(request!.params["resolution"], "1080p", `${mode} carries the size`);
      assert.equal(request!.estimatedMicroUsd, 43333 * 6, `${mode} is priced at that size`);
    }
    // And a plan with no chosen size carries none, rather than inventing one.
    const bare = planScene({ ...input, resolution: undefined }, "per-shot");
    const [plain] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, bare, model, bundle);
    assert.equal(plain!.params["resolution"], undefined);
    await store.close();
  });

  it("a stills tier becomes real dimensions, because the clients ignore a bare size word", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [{ ...base.shots[0]!, id: "sh_95", number: 95, description: "@maren-kest" }],
    };
    const stills: ManifestModel = {
      id: "flux-2-pro",
      provider: "fal",
      capability: "image",
      displayName: "Flux 2 Pro",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { tiers: { "1K": "1MP", "4K": "4MP" } },
      pricing: { kind: "perMegapixel", microUsdPerMegapixel: 30_000 },
    };
    const input = {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: {},
      model: stills,
    };
    for (const mode of ["per-shot", "whole-scene"] as const) {
      // Whole scene priced a pass of stills as if it were footage — no megapixels, no reference
      // input — which on a per-megapixel model is a queued job estimated at zero.
      const plan = planScene({ ...input, tier: "4K" as const }, mode);
      const [request] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, stills, bundle);
      assert.ok(request!.params["output"] !== undefined, `${mode} carries the frame`);
      assert.ok(request!.estimatedMicroUsd > 0, `${mode} is priced`);
      // And no bare size word beside it: the image clients ignore it and fal forwards it anyway.
      assert.equal(request!.params["resolution"], undefined, `${mode} sends dimensions, not a word`);
    }
    const oneK = planScene({ ...input, tier: "1K" as const }, "per-shot");
    const fourK = planScene({ ...input, tier: "4K" as const }, "per-shot");
    const [small] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, oneK, stills, bundle);
    const [large] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, fourK, stills, bundle);
    const size = (request: (typeof small)) => request!.params["output"] as { width: number; height: number };
    assert.ok(size(large).width > size(small).width, "4K asks for more pixels than 1K");
    // And the money follows: a per-megapixel model priced from no megapixels came out at zero.
    assert.ok(oneK.totalEstimatedMicroUsd > 0, "an estimate, not a zero");
    assert.ok(fourK.totalEstimatedMicroUsd > oneK.totalEstimatedMicroUsd);
    await store.close();
  });

  it("stretches the shot plan to the clip that was actually asked for", async () => {
    // A pass snapped from 5s to 6s used to send the longer clip with a 0–5s plan behind it:
    // segmentation reads those boundaries, so the last second was in nobody's take and the
    // per-shot charge split was prorated over the wrong total.
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [{ ...base.shots[0]!, id: "sh_96", number: 96, description: "@maren-kest", durationSec: 5 }],
    };
    // Veo takes 4s, 6s or 8s: a 5s pass is asked for as 6s.
    const veo: ManifestModel = {
      ...VIDEO_MODEL,
      id: "veo-3.1",
      displayName: "Veo 3.1",
      accepts: { ...VIDEO_MODEL.accepts, referenceImages: 0 },
      limits: { maxDurationSec: 8, durations: { "4": "4s", "6": "6s", "8": "8s" } },
    };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: veo,
      },
      "whole-scene",
    );
    const [request] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, veo, bundle);
    assert.equal(request!.params["durationSec"], 6, "the clip asked for");
    const shotPlan = request!.params["shotPlan"] as Array<{ startSec: number; endSec: number }>;
    assert.equal(shotPlan[shotPlan.length - 1]!.endSec, 6, "and the plan covers all of it");
    await store.close();
  });

  it("refuses a shot longer than the model can make, rather than quietly shortening it", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [{ ...base.shots[0]!, id: "sh_97", number: 97, description: "@maren-kest", durationSec: 22 }],
    };
    const veo: ManifestModel = {
      ...VIDEO_MODEL,
      id: "veo-3.1",
      displayName: "Veo 3.1",
      limits: { maxDurationSec: 8, durations: { "4": "4s", "6": "6s", "8": "8s" } },
    };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: veo,
      },
      "per-shot",
    );
    // Named before anyone presses...
    assert.deepEqual(plan.warnings.overlongShots, [
      { shotId: "sh_97", number: 97, durationSec: 22, longestSec: 8 },
    ]);
    // ...and refused if a frame arrives anyway. An 8s clip billed against a 22s shot is money
    // spent on footage that cannot cover it.
    assert.throws(
      () => composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, veo, bundle),
      /longer than the 8s Veo 3\.1 can make/,
    );
    await store.close();
  });

  it("budgets every packed pass independently and honors zero-reference models", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [
        { ...base.shots[0]!, id: "sh_92", number: 92, description: "@maren-kest", durationSec: 10 },
        { ...base.shots[0]!, id: "sh_93", number: 93, description: "@the-chorister", durationSec: 10 },
      ],
    };
    const model = { ...VIDEO_MODEL, accepts: { ...VIDEO_MODEL.accepts, referenceImages: 0 } };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model,
      },
      "whole-scene",
    );
    assert.equal(plan.passReferences.length, 2);
    const requests = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, model, bundle);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => (request.params["references"] as string[]).length === 0));
    assert.ok(plan.passReferences.every((pass) => pass.budget.carried.length === 0));
    await store.close();
  });
});

describe("SPEC-017 art direction and scoped looks", () => {
  it("uses the resolved world direction in production prompts", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.match(plan.shots[0]!.prompt.text, /Painterly, tidal, restrained/);
    await store.close();
  });

  it("carries an attached look only inside its named production", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const maren = bundle.referenceKits.find((kit) => kit.sheetId === "maren-kest")!;
    const withLook = {
      ...maren,
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
    };
    const inside = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits.map((kit) => (kit.sheetId === maren.sheetId ? withLook : kit)),
        scene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.ok(inside.shots.some((shotPlan) => shotPlan.references.some((reference) => reference.file?.includes("council-coat"))));

    const outside = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: "another-production",
        sheets: bundle.sheets,
        kits: bundle.referenceKits.map((kit) => (kit.sheetId === maren.sheetId ? withLook : kit)),
        scene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.ok(outside.shots.every((shotPlan) => shotPlan.references.every((reference) => !reference.file?.includes("council-coat"))));
    await store.close();
  });

  it("carries a scene-attached look only in that scene", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const maren = bundle.referenceKits.find((kit) => kit.sheetId === "maren-kest")!;
    const withLook = {
      ...maren,
      looks: [
        {
          id: "third-verse",
          file: "looks/third-verse.png",
          kind: "condition-age" as const,
          prompt: "After the third verse",
          acceptedAt: CLOCK(),
          attachedTo: { kind: "scene" as const, productionId: production.meta.id, sceneId: scene.id },
        },
      ],
    };
    const kits = bundle.referenceKits.map((kit) => (kit.sheetId === maren.sheetId ? withLook : kit));
    const inside = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits,
        scene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.ok(inside.shots.some((shotPlan) => shotPlan.references.some((reference) => reference.file?.includes("third-verse"))));

    const otherScene = { ...scene, id: "sc_other" };
    const outside = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits,
        scene: otherScene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.ok(outside.shots.every((shotPlan) => shotPlan.references.every((reference) => !reference.file?.includes("third-verse"))));
    await store.close();
  });
});

describe("inheritance (R-1, D1, §3.2): a production is a lens, not a container", () => {
  it("no production file contains a copy of a world entity; a sheet advance is visible at next plan", async () => {
    const { dir, store, gate } = await open();
    // 1 — no copies: scan every production file for sheet body text.
    const marenEssence = "hears the verse under the harbour";
    const prodDir = join(dir, "productions", "saltlight");
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (/\.(json|md|jsonl)$/.test(entry.name)) files.push(p);
      }
    };
    await walk(prodDir);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      assert.ok(!text.includes(marenEssence), `${file} holds a copy of sheet prose`);
    }

    // 2 — the sheet advances; the next plan reads the new name with no migration.
    const { stageSheetRename } = await import("../../src/sheets/authoring.js");
    const staged = await stageSheetRename(store, gate, { path: "characters/maren-kest.md", name: "Maren the Late" });
    await gate.accept(staged.id);
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const plan = planScene(
      { world: bundle.meta, sheets: bundle.sheets, kits: bundle.referenceKits, scene, selections: production.selections, model: VIDEO_MODEL },
      "per-shot",
    );
    const mentioning = plan.shots.find((s) => s.shot.description.includes("@maren-kest"));
    assert.ok(mentioning && mentioning.prompt.text.includes("Maren the Late"), "seen at next dispatch, no migration");
    await store.close();
  });
});

describe("chapters (R-4, R-5, D3, §3.2)", () => {
  it("direct saves cut no version; reordering renames no file", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    const a = await createChapter(store, "inkbound", { title: "The First Tide", order: 1 });
    const b = await createChapter(store, "inkbound", { title: "Undertow", order: 2 });

    await saveChapter(store, "inkbound", a, "She counted the bells twice.");
    await saveChapter(store, "inkbound", a, "She counted the bells three times.");
    const raw = await readFile(join(dir, "productions", "inkbound", "chapters", `${a}.md`), "utf8");
    const doc = MarkdownFile.parse(raw);
    assert.equal(doc.data["version"], 1, "direct authoring saves without cutting a version (R-5)");
    assert.match(doc.body, /three times/);

    const before = (await readdir(join(dir, "productions", "inkbound", "chapters"))).sort();
    await reorderChapters(store, "inkbound", [b, a]);
    const after = (await readdir(join(dir, "productions", "inkbound", "chapters"))).sort();
    assert.deepEqual(after, before, "no file renamed (R-4, D3)");
    const rawB = await readFile(join(dir, "productions", "inkbound", "chapters", `${b}.md`), "utf8");
    assert.equal(MarkdownFile.parse(rawB).data["order"], 1, "order lives in frontmatter");
    await store.close();
  });
});

describe("scene schema round-trip with overrides", () => {
  it("a scene with a prompt override parses and re-serialises", () => {
    const scene: Scene = {
      id: "sc_05",
      number: 5,
      slug: "x",
      title: "X",
      status: "draft",
      version: 1,
      shots: [
        {
          ...shot(1, 6, "@maren-kest"),
          promptOverride: { text: "tuned", sheetVersions: { "maren-kest": 4 } },
        },
      ],
    };
    assert.deepEqual(SceneSchema.parse(JSON.parse(JSON.stringify(scene))), scene);
  });
});
