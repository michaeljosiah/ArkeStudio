import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bindReferences,
  bindingPreamble,
  skillFamilyMismatch,
  boundFiles,
  composePrompt,
  derivedNegatives,
  standingConstraints,
  packScene,
  parseMentions,
  planScene,
  promptFor,
  resolveCast,
  assembleBlocks,
  assemblePrompt,
  assemblePassBlocks,
  joinBlocks,
  spatialLayoutFor,
  overrideStaleAgainst,
  SceneSchema,
  type ManifestModel,
  type ReferenceKit,
  type Scene,
  type Sheet,
  type Shot,
  type WorldMeta,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import {
  compileBoard,
  composeDispatches,
  createChapter,
  createProduction,
  draftSceneSkeleton,
  exportBoard,
  landBoard,
  reorderChapters,
  saveChapter,
  setPromptOverride,
} from "../../src/productions/ops.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { orderedShots, writerSceneView } from "@arke-studio/contracts";

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
    assert.match(prompt, /slow push-in/);
    assert.match(prompt, /the verse, under the water/);
    assert.ok(!prompt.includes("@maren-kest"), "mentions are expanded, never sent raw");
    // SPEC-019 R-8, D7: the appearance clause is stated once, in the standing block, rather
    // than inlined at every mention. No image is carried here, so the prose remains.
    assert.match(prompt, /Maren Kest — Salt-crusted braids/);
    assert.equal(
      prompt.match(/Salt-crusted braids/g)?.length,
      1,
      "an appearance is described once per clip, never once per mention",
    );
    await store.close();
  });

  it("reset restores the assembled form exactly; staleness flags and clears (R-15, R-16)", async () => {
    const { store, gate } = await open();
    let bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
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
    let liveShot = orderedShots(bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!).find((s) => s.id === target.id)!;
    assert.equal(promptFor(bundle.meta, bundle.sheets, scene, liveShot).overridden, true);
    assert.equal(
      bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!.version,
      scene.version + 1,
      "an override is authored text — it cuts a version, so the stale-token guards it (review 2026-08-22)",
    );
    assert.equal(overrideStaleAgainst(liveShot, bundle.sheets).length, 0);

    // The cited sheet advances: the override goes stale and says which sheet moved (R-16).
    const { stageSheetRename } = await import("../../src/sheets/authoring.js");
    const staged = await stageSheetRename(store, gate, { path: "characters/maren-kest.md", name: "Maren K" });
    await gate.accept(staged.id);
    bundle = store.getBundle();
    liveShot = orderedShots(bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!).find((s) => s.id === target.id)!;
    const stale = overrideStaleAgainst(liveShot, bundle.sheets);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.sheetId, "maren-kest");
    assert.ok(stale[0]!.to > stale[0]!.from);

    // Reset: the override clears; the assembled form returns exactly; canon untouched throughout.
    await setPromptOverride(store, bundle, { productionId: production.meta.id, sceneFile, shotId: target.id, text: null });
    bundle = store.getBundle();
    liveShot = orderedShots(bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!).find((s) => s.id === target.id)!;
    const restored = promptFor(bundle.meta, bundle.sheets, scene, liveShot);
    assert.equal(restored.overridden, false);
    assert.equal(
      restored.text,
      assembled.replaceAll("Maren Kest", "Maren K"),
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
    const scene = writerSceneView(production.scenes[0]!);
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
    const scene = writerSceneView(production.scenes[0]!);
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

    // ...but only for a model that would carry one. Telling someone to go and accept a frame,
    // on a route with no image input, sends them to fix something that changes nothing (#154).
    const textOnly = planScene(
      {
        world: bundle.meta,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: { ...VIDEO_MODEL, accepts: { ...VIDEO_MODEL.accepts, startFrame: false, endFrame: false } },
      },
      "per-shot",
    );
    assert.deepEqual(textOnly.warnings.shotsWithoutFrame, []);
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
    const base = writerSceneView(production.scenes[0]!);
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
    const base = writerSceneView(production.scenes[0]!);
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
    const base = writerSceneView(production.scenes[0]!);
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
    const base = writerSceneView(production.scenes[0]!);
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
    const base = writerSceneView(production.scenes[0]!);
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
      { shotId: "sh_97", number: 97, durationSec: 22, longestSec: 8, becauseReferences: false },
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
    const base = writerSceneView(production.scenes[0]!);
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
    const scene = writerSceneView(production.scenes[0]!);
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

  it("uses the production's visual language in both dispatch modes instead of the world look", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
    const styleOverride = "Bleached documentary realism with hard noon shadows.";

    for (const mode of ["per-shot", "whole-scene"] as const) {
      const plan = planScene(
        {
          world: bundle.meta,
          artDirection: bundle.artDirection,
          productionId: production.meta.id,
          production: { styleOverride, failureModes: production.meta.failureModes },
          sheets: bundle.sheets,
          kits: bundle.referenceKits,
          scene,
          selections: production.selections,
          model: VIDEO_MODEL,
        },
        mode,
      );
      const requests = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, VIDEO_MODEL, bundle);
      assert.equal(plan.effectiveStyle, styleOverride);
      assert.equal(plan.productionStyleOverride, styleOverride);
      for (const request of requests) {
        const prompt = String(request.params["prompt"]);
        assert.match(prompt, /Bleached documentary realism with hard noon shadows/);
        assert.ok(!prompt.includes(bundle.artDirection.description), `${mode} does not re-read the world look`);
        assert.deepEqual(request.params["artDirection"], {
          version: bundle.artDirection.version,
          source: "production",
          transport: "text",
          description: styleOverride,
        });
      }
    }
    await store.close();
  });

  it("keeps a full shot prompt override independent of the production look", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const override = "Hand-tuned shot prompt with its own visual treatment.";
    const scene: Scene = {
      ...production.scenes[0]!,
      shots: [
        {
          ...orderedShots(production.scenes[0]!)[0]!,
          promptOverride: { text: override, sheetVersions: {} },
        },
      ],
    };
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        production: {
          styleOverride: "Bleached documentary realism",
          failureModes: production.meta.failureModes,
        },
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    const [request] = composeDispatches(bundle.meta.worldId, production.meta.id, scene, plan, VIDEO_MODEL, bundle);
    assert.match(String(request!.params["prompt"]), /Hand-tuned shot prompt/);
    assert.ok(!String(request!.params["prompt"]).includes("Bleached documentary realism"));
    assert.equal((request!.params["artDirection"] as { source: string }).source, "generation");
    await store.close();
  });

  it("carries an attached look only inside its named production", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
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
    const scene = writerSceneView(production.scenes[0]!);
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

  /* The narrower scope wins (design 67). Both looks match the scene being planned, and the
     resolver used to answer by array order — so the production's cast row could show one
     choice while a scene quietly dispatched the other. */
  it("lets a scene's own look beat the production's, whichever order they were attached in", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
    const maren = bundle.referenceKits.find((kit) => kit.sheetId === "maren-kest")!;
    const wide = {
      id: "council-coat",
      file: "looks/council-coat.png",
      kind: "costume" as const,
      prompt: "Formal council coat",
      acceptedAt: CLOCK(),
      attachedTo: { kind: "production" as const, productionId: production.meta.id },
    };
    const narrow = {
      id: "third-verse",
      file: "looks/third-verse.png",
      kind: "condition-age" as const,
      prompt: "After the third verse",
      acceptedAt: CLOCK(),
      attachedTo: { kind: "scene" as const, productionId: production.meta.id, sceneId: scene.id },
    };
    const plan = (looks: (typeof wide | typeof narrow)[]) =>
      planScene(
        {
          world: bundle.meta,
          artDirection: bundle.artDirection,
          productionId: production.meta.id,
          sheets: bundle.sheets,
          kits: bundle.referenceKits.map((kit) =>
            kit.sheetId === maren.sheetId ? { ...maren, looks } : kit,
          ),
          scene,
          selections: production.selections,
          model: VIDEO_MODEL,
        },
        "per-shot",
      );
    for (const looks of [[wide, narrow], [narrow, wide]]) {
      const files = plan(looks).shots.flatMap((shotPlan) =>
        shotPlan.references.map((reference) => reference.file ?? ""),
      );
      assert.ok(files.some((file) => file.includes("third-verse")), "the scene's own look rides");
      assert.ok(
        files.every((file) => !file.includes("council-coat")),
        "the production-wide look stands aside inside that scene",
      );
    }
    await store.close();
  });
  /* Worlds written before attaching displaced can already hold two looks claiming one
     production, and the schema still admits them. Falling back to the first in the array picked
     the OLDEST, because acceptance appends — so an upgraded world went on dispatching the older
     appearance until somebody happened to reattach (codex round 1). */
  it("resolves a legacy same-scope collision by acceptance, not by array order", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
    const maren = bundle.referenceKits.find((kit) => kit.sheetId === "maren-kest")!;
    const older = {
      id: "council-coat",
      file: "looks/council-coat.png",
      kind: "costume" as const,
      prompt: "Formal council coat",
      acceptedAt: "2026-08-01T10:00:00.000Z",
      attachedTo: { kind: "production" as const, productionId: production.meta.id },
    };
    const newer = { ...older, id: "storm-oilskin", file: "looks/storm-oilskin.png", acceptedAt: "2026-08-09T10:00:00.000Z" };
    const files = (looks: (typeof older)[]) =>
      planScene(
        {
          world: bundle.meta,
          artDirection: bundle.artDirection,
          productionId: production.meta.id,
          sheets: bundle.sheets,
          kits: bundle.referenceKits.map((kit) => (kit.sheetId === maren.sheetId ? { ...maren, looks } : kit)),
          scene,
          selections: production.selections,
          model: VIDEO_MODEL,
        },
        "per-shot",
      ).shots.flatMap((shotPlan) => shotPlan.references.map((reference) => reference.file ?? ""));
    for (const looks of [[older, newer], [newer, older]]) {
      const carried = files(looks);
      assert.ok(carried.some((file) => file.includes("storm-oilskin")), "the later acceptance rides");
      assert.ok(carried.every((file) => !file.includes("council-coat")), "and the older one does not");
    }
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
    const scene = writerSceneView(production.scenes[0]!);
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
    // The summary follows the prose: a save recounts the words, so the chapter tree and the
    // story dashboard never report the count the chapter had when it was last stamped by hand.
    assert.equal(doc.data["words"], 6, "a save recounts the chapter's words");
    await saveChapter(store, "inkbound", a, "   ");
    const cleared = MarkdownFile.parse(
      await readFile(join(dir, "productions", "inkbound", "chapters", `${a}.md`), "utf8"),
    );
    assert.equal(cleared.data["words"], 0, "an emptied chapter counts zero, not one blank token");

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

// ---------------------------------------------------------------------------
// SPEC-019 T-2..T-8: binding, prompt structure and derived negatives
// ---------------------------------------------------------------------------

describe("SPEC-019 reference binding (R-1..R-4, D1, D2)", () => {
  it("numbers every carried asset, and the numbering is the transmitted order", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
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
    const withRefs = plan.shots.find((entry) => entry.bound.length > 0);
    assert.ok(withRefs, "the fixture carries at least one reference");

    // One structure, two renderings (R-2, D2): the array sent and the lines stated.
    const [request] = composeDispatches(
      bundle.meta.worldId,
      production.meta.id,
      scene,
      plan,
      VIDEO_MODEL,
      bundle,
    );
    const sent = (request!.params as { references: string[] }).references;
    const prompt = (request!.params as { prompt: string }).prompt;
    const firstShot = plan.shots[0]!;
    assert.deepEqual(sent, boundFiles(firstShot.bound), "sent files are the bound files, in order");
    for (const reference of firstShot.bound) {
      assert.ok(
        prompt.includes(`Image ${reference.index}: ${reference.subject}`),
        `image ${reference.index} is named in the prompt as ${reference.subject}`,
      );
      assert.equal(
        sent[reference.index - 1],
        reference.file,
        "the index the prompt states is the position the file occupies",
      );
    }
    await store.close();
  });

  it("never numbers an asset that is not sent, and states a role for each one", () => {
    const sheets = [
      { id: "a", name: "Ayo", type: "character", version: 1, sections: [] },
      { id: "hall", name: "The Hall", type: "location", version: 1, sections: [] },
    ] as unknown as Parameters<typeof bindReferences>[1];
    const bound = bindReferences(
      [
        { sheetId: "a", file: "references/a/sheet.png", mode: "designated", role: "primary", staleGap: null },
        // A sketch citation takes no slot and must not be cited as an image that is not there.
        { sheetId: "a", file: null, mode: "sketch-citation", role: "secondary", staleGap: null },
        { sheetId: "hall", file: "references/hall/look.png", mode: "designated", role: "primary", staleGap: null },
      ],
      sheets,
    );
    assert.deepEqual(bound.map((b) => b.index), [1, 2], "indices are contiguous over sent assets only");
    assert.deepEqual(bound.map((b) => b.sheetId), ["a", "hall"]);
    assert.match(bound[0]!.rolePhrase, /subject reference/);
    assert.match(bound[1]!.rolePhrase, /location reference/, "a place is not asked to be a subject (R-4)");

    const preamble = bindingPreamble(bound)!;
    assert.match(preamble, /Image 1: Ayo/);
    assert.match(preamble, /Image 2: The Hall/);
    assert.ok(!preamble.includes("Image 3"), "nothing cites an image that was not sent");
  });

  it("ties a second reference back to the subject it belongs to", () => {
    const sheets = [
      { id: "a", name: "Ayo", type: "character", version: 1, sections: [] },
    ] as unknown as Parameters<typeof bindReferences>[1];
    const bound = bindReferences(
      [
        { sheetId: "a", file: "references/a/sheet.png", mode: "designated", role: "primary", staleGap: null },
        { sheetId: "a", file: "references/a/photo.png", mode: "main-photo", role: "secondary", staleGap: null },
      ],
      sheets,
    );
    assert.equal(bound[1]!.sameSubjectAs, 1);
    assert.match(
      bindingPreamble(bound)!,
      /same subject as image 1/,
      "two images of one person are one subject, not two (R-4)",
    );
  });
});

describe("SPEC-019 prompt structure (R-5..R-8, D5..D7)", () => {
  const scene = (shots: Shot[]): Scene => ({
    id: "sc_91",
    number: 91,
    slug: "t",
    title: "T",
    status: "draft",
    version: 1,
    inherits: { location: "the-vigil", timeOfDay: "night" },
    shots,
  });

  it("emits one spatial layout per whole-scene pass and anchors each ordinary beat", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const a: Shot = { ...shot(1, 5, "@maren-kest grips the rail"), camera: "At the rail desk, facing the mouth; MCU" };
    const b: Shot = { ...shot(2, 5, "@maren-kest turns inland"), camera: "At the lamp housing, facing the stair; wide" };
    const passBlocks = assemblePassBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([a, b]),
      entries: [
        { shot: a, prompt: { text: "", overridden: false } },
        { shot: b, prompt: { text: "", overridden: false } },
      ],
      capability: "video",
    });

    assert.match(passBlocks.spatial, /^SPATIAL LAYOUT\n/, "the room belongs to the pass");
    assert.equal(
      passBlocks.beats.filter((beat) => beat.text.includes("SPATIAL LAYOUT")).length,
      0,
      "and is never restated per beat (R-6's reasoning applied to the room)",
    );
    assert.equal(
      passBlocks.beats.filter((beat) => beat.text.includes("CAMERA ANCHOR")).length,
      2,
      "each ordinary beat places its own camera, because that is what changes between them",
    );
    assert.match(passBlocks.beats[0]!.text, /At the rail desk, facing the mouth; MCU/);
    assert.match(passBlocks.beats[1]!.text, /At the lamp housing, facing the stair; wide/);
    await store.close();
  });

  it("keeps overridden prompt bodies verbatim in per-shot and pass assembly", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const override = "Whatever the director wrote, including their own room and camera.";
    const overridden: Shot = {
      ...shot(1, 5, "@maren-kest grips the rail"),
      camera: "At the rail desk, facing the mouth; MCU",
      intent: "Claustrophobic and watchful",
      beats: [{ span: "0–5s", text: "The camera hesitates" }],
      promptOverride: { text: override, sheetVersions: {} },
    };
    const ordinary: Shot = { ...shot(2, 5, "@maren-kest turns inland"), camera: "At the lamp housing; wide" };

    // Per shot: the override is the body, untouched.
    const single = promptFor(bundle.meta, bundle.sheets, scene([overridden]), overridden, undefined, undefined, "video");
    assert.equal(single.text, override, "no generated spatial or camera text is merged into an override");
    assert.ok(single.overridden);

    // In a pass: the overridden beat stays verbatim, the ordinary beat still gets its anchor,
    // and the pass keeps the room because the room is derived from the scene, not from a beat.
    const passBlocks = assemblePassBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([overridden, ordinary]),
      entries: [
        { shot: overridden, prompt: { text: override, overridden: true } },
        { shot: ordinary, prompt: { text: "", overridden: false } },
      ],
      capability: "video",
    });
    assert.equal(passBlocks.beats[0]!.text, override, "an overridden beat is emitted exactly as written");
    assert.match(passBlocks.beats[1]!.text, /CAMERA ANCHOR/);
    assert.match(passBlocks.spatial, /SPATIAL LAYOUT/, "common context survives an overridden beat, as standing does");
    await store.close();
  });

  it("emits blocks as paragraphs, never fragments glued with punctuation", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      camera: "slow push-in, MCU",
    };
    const prompt = assemblePrompt(bundle.meta, bundle.sheets, scene([s]), s);
    assert.ok(!prompt.includes(".."), "the double-period cleanup has nothing left to clean (R-7)");
    assert.ok(prompt.includes("\n\n"), "blocks are paragraphs, not one run-on (R-5)");
    await store.close();
  });

  it("omits a block with nothing to say rather than emitting it empty", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const bare: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      intent: "   ",
      beats: [{ span: "  ", text: "not emitted" }, { span: "0–2s", text: "   " }],
    };
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([bare]), shot: bare });
    assert.equal(blocks.direction, "", "blank intent and timing, no camera and no audio produce no direction block");
    const prompt = assemblePrompt(bundle.meta, bundle.sheets, scene([bare]), bare);
    assert.ok(!/\n\n\n/.test(prompt), "an omitted block leaves no blank paragraph behind");
    await store.close();
  });

  it("emits the complete location Look and an explicitly authored camera anchor for video", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      camera: "At the rail desk, facing the harbour mouth; MCU, slow push-in.",
    };
    const blocks = assembleBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([s]),
      shot: s,
      capability: "video",
    });
    const location = bundle.sheets.find((sheet) => sheet.id === "the-vigil")!;
    const look = location.sections.find((section) => section.heading === "Look")!.body.trim();

    assert.match(blocks.spatial, /^SPATIAL LAYOUT\n/, "the block names itself");
    assert.ok(
      blocks.spatial.includes(look.replace(/\s+/g, " ")),
      "the complete authored Look travels, not its first clause",
    );
    assert.equal(
      blocks.cameraAnchor,
      "CAMERA ANCHOR\nAt the rail desk, facing the harbour mouth; MCU, slow push-in.",
      "the authored camera value is carried byte-for-byte after trimming",
    );
    assert.equal(blocks.direction, "", "the camera is spoken once, in its anchor, not also trailing the beat");
    assert.ok(
      !blocks.standing.includes(location.name),
      "the room is not described twice, once abridged (acceptance: Look not repeated in standing)",
    );

    const prompt = joinBlocks(blocks);
    assert.ok(
      prompt.indexOf("SPATIAL LAYOUT") < prompt.indexOf("CAMERA ANCHOR"),
      "the room is established before the camera is placed in it",
    );
    assert.ok(prompt.indexOf("CAMERA ANCHOR") < prompt.indexOf("Maren Kest grips the rail"));
    await store.close();
  });

  it("does not infer an anchor from generic camera vocabulary", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = { ...shot(1, 6, "@maren-kest grips the rail"), camera: "MCU · slow push-in" };
    const blocks = assembleBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([s]),
      shot: s,
      capability: "video",
    });
    assert.equal(
      blocks.cameraAnchor,
      "CAMERA ANCHOR\nMCU · slow push-in",
      "generic vocabulary is carried as authored — never dressed up as a placement nobody wrote",
    );
    await store.close();
  });

  it("omits spatial blocks and preserves the old prompt when location resolution fails", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = { ...shot(1, 6, "@maren-kest grips the rail"), camera: "MCU, slow push-in" };
    const noLocation: Scene = { ...scene([s]), inherits: { timeOfDay: "night" } };

    const before = assemblePrompt(bundle.meta, bundle.sheets, noLocation, s);
    const after = assemblePrompt(bundle.meta, bundle.sheets, noLocation, s, undefined, undefined, "video");
    assert.equal(after, before, "no qualifying location means byte-for-byte the prior prompt");
    assert.ok(!after.includes("SPATIAL LAYOUT"));
    assert.ok(!after.includes("CAMERA ANCHOR"));
    assert.ok(!/\n\n\n/.test(after), "and no empty heading left behind");

    // A citation that resolves to a character rather than a location does not qualify either.
    const wrongKind: Scene = { ...scene([s]), inherits: { location: "maren-kest" } };
    assert.equal(spatialLayoutFor(wrongKind, bundle.sheets), null, "a character sheet is not a room");
    await store.close();
  });

  it("omits an empty camera heading when camera is absent", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const bare: Shot = shot(1, 6, "@maren-kest grips the rail");
    const blocks = assembleBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([bare]),
      shot: bare,
      capability: "video",
    });
    assert.match(blocks.spatial, /SPATIAL LAYOUT/, "the room still travels");
    assert.equal(blocks.cameraAnchor, "", "no authored camera means no anchor block");
    assert.ok(!joinBlocks(blocks).includes("CAMERA ANCHOR"));
    await store.close();
  });

  it("does not add spatial blocks to image planning", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = { ...shot(1, 6, "@maren-kest grips the rail"), camera: "MCU, slow push-in" };
    const stills = assemblePrompt(bundle.meta, bundle.sheets, scene([s]), s, undefined, undefined, "image");
    const unplanned = assemblePrompt(bundle.meta, bundle.sheets, scene([s]), s);
    assert.equal(stills, unplanned, "a still is byte-identical to what it was before this feature");
    assert.ok(!stills.includes("SPATIAL LAYOUT"));
    assert.match(stills, /MCU, slow push-in/, "and its camera stays where it always was");
    await store.close();
  });

  it("drops the prose appearance where the image travels, and keeps it where it does not", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = shot(1, 6, "@maren-kest grips the rail");

    const withoutImage = assemblePrompt(bundle.meta, bundle.sheets, scene([s]), s);
    assert.match(withoutImage, /Salt-crusted braids/, "a sketch citation keeps its only description");

    const withImage = assemblePrompt(
      bundle.meta,
      bundle.sheets,
      scene([s]),
      s,
      undefined,
      new Set(["maren-kest"]),
    );
    assert.ok(
      !withImage.includes("Salt-crusted braids"),
      "the image is the stronger carrier; restating competes with it (R-8, D7)",
    );
    assert.match(withImage, /Maren Kest/, "the subject is still named");
    await store.close();
  });

  it("states the art direction twice for a pass and never once per beat", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene4 = {
      ...production.scenes[0]!,
      shots: [1, 2, 3, 4].map((n) => shot(n, 3, `@maren-kest beat ${n}`)),
    };
    const model = { ...VIDEO_MODEL, limits: { maxDurationSec: 15 } };
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: scene4,
        selections: {},
        model,
      },
      "whole-scene",
    );
    const [request] = composeDispatches(
      bundle.meta.worldId,
      production.meta.id,
      scene4,
      plan,
      model,
      bundle,
    );
    const prompt = (request!.params as { prompt: string }).prompt;
    const look = bundle.artDirection.description;
    const occurrences = prompt.split(look).length - 1;
    assert.equal(occurrences, 2, "once leading the summary, once as the standing constraint (R-6)");
    assert.equal(prompt.match(/\[shot \d+ · /g)?.length, 4, "all four beats are present");
    await store.close();
  });

  it("states the pass's shape before anything else, because the cuts depend on it", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene4 = {
      ...production.scenes[0]!,
      shots: [1, 2, 3].map((n) => shot(n, 3, `@maren-kest beat ${n}`)),
    };
    const model = { ...VIDEO_MODEL, limits: { maxDurationSec: 15 } };
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: scene4,
        selections: {},
        model,
      },
      "whole-scene",
    );
    const [request] = composeDispatches(
      bundle.meta.worldId,
      production.meta.id,
      scene4,
      plan,
      model,
      bundle,
    );
    const params = request!.params as { prompt: string; durationSec?: number; shotPlan?: unknown[] };
    const first = params.prompt.split("\n\n")[0]!;
    assert.match(first, /^One continuous clip: /, "the shape leads the prompt");
    assert.match(first, /3 shots/, "the shot count is stated");
    assert.ok(
      first.includes(`${params.durationSec}s`),
      "the seconds stated are the seconds asked for, which is what shotPlan covers",
    );
    assert.equal(params.shotPlan?.length, 3, "and the boundaries it refers to are actually sent");
    await store.close();
  });

  it("says nothing about shape for a single-shot dispatch, which has no boundaries", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene1 = { ...production.scenes[0]!, shots: [shot(1, 4, "@maren-kest waits")] };
    const model = { ...VIDEO_MODEL, limits: { maxDurationSec: 15 } };
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: scene1,
        selections: {},
        model,
      },
      "per-shot",
    );
    const [request] = composeDispatches(
      bundle.meta.worldId,
      production.meta.id,
      scene1,
      plan,
      model,
      bundle,
    );
    const prompt = (request!.params as { prompt: string }).prompt;
    assert.ok(!prompt.includes("One continuous clip"), "a lone shot's length is its own parameter");
    await store.close();
  });
});

describe("SPEC-019 derived negatives (R-9..R-13, D8..D10)", () => {
  it("negates subtitles on every video dispatch and nothing on an image one", () => {
    assert.match(derivedNegatives({ capability: "video" })!, /No subtitles\./);
    assert.equal(derivedNegatives({ capability: "image" }), null);
  });

  it("negates score only where the cut composes one, and never environmental sound", () => {
    const withScore = derivedNegatives({ capability: "video", audioDesign: { scoreTrack: true } })!;
    assert.match(withScore, /No background music/);
    assert.match(withScore, /environmental and action sound only/);
    const without = derivedNegatives({ capability: "video", audioDesign: { scoreTrack: false } })!;
    assert.ok(!without.includes("No background music"), "no score track, no score negative");
  });

  it("says silence when the shot is directed silent", () => {
    const silent = derivedNegatives({
      capability: "video",
      shot: { ...shot(1, 4), audio: { kind: "silence" } },
      audioDesign: { scoreTrack: true },
    })!;
    assert.match(silent, /No audio\./);
  });

  it("says silence for a pass only when every shot in it is silent", () => {
    const quiet = { ...shot(1, 4), audio: { kind: "silence" } };
    const spoken = { ...shot(2, 6), audio: { kind: "dialogue", line: "Ring it properly." } };

    const allSilent = derivedNegatives({ capability: "video", shots: [quiet, { ...quiet, id: "sh_x" }] })!;
    assert.match(allSilent, /No audio\./, "a pass of silent shots is a silent clip and must say so");

    const mixed = derivedNegatives({ capability: "video", shots: [quiet, spoken] })!;
    assert.ok(!mixed.includes("No audio"), "one spoken beat among four is not a silent pass");
  });

  it("leaves the audio negative off when nothing directs the audio either way", () => {
    const undirected = derivedNegatives({ capability: "video", shots: [shot(1, 4), shot(2, 4)] })!;
    assert.equal(undirected, "No subtitles.", "silence is a direction, not the absence of one");
  });

  it("survives an override, because a rewritten shot is still a video dispatch", async () => {
    const { store } = await open();
    let bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = writerSceneView(production.scenes[0]!);
    const sceneFile = `${String(scene.number).padStart(2, "0")}-${scene.slug}`;
    const target = scene.shots[0]!;
    await setPromptOverride(store, bundle, {
      productionId: production.meta.id,
      sceneFile,
      shotId: target.id,
      text: "Something else entirely — my tuned wording.",
    });
    bundle = store.getBundle();
    const liveScene = bundle.productions[0]!.scenes.find((s) => s.id === scene.id)!;
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: liveScene,
        selections: production.selections,
        model: VIDEO_MODEL,
        audioDesign: { scoreTrack: true },
      },
      "per-shot",
    );
    const entry = plan.shots.find((s) => s.shot.id === target.id)!;
    assert.equal(entry.prompt.overridden, true);
    assert.equal(entry.parts.body, "Something else entirely — my tuned wording.");

    const composed = composePrompt(entry.parts);
    assert.match(composed, /Something else entirely/, "the override owns the direction");
    assert.match(composed, /No subtitles\./, "the negatives are not the override's to drop (R-13, D3)");
    assert.match(composed, /No background music/);
    if (entry.parts.preamble !== null) {
      assert.ok(
        composed.startsWith(entry.parts.preamble),
        "the preamble leads, ahead of the overridden body",
      );
    }
    await store.close();
  });
});

describe("SPEC-019 skills on the draft they shaped (R-19, R-20)", () => {
  const SKILL = { id: "seedance-scene-drafting", version: 1, family: "seedance" };

  it("records the skill on the proposal, and says which guidance drafted the scene", async () => {
    const { store, gate } = await open();
    const production = store.getBundle().productions[0]!;
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: production.meta.id,
      brief: "The tide turns at the harbour mouth",
      skill: SKILL,
    });
    assert.deepEqual(draft.skill, SKILL);
    assert.match(draft.scope, /seedance-scene-drafting@v1/);
    assert.match(draft.scope, /\(seedance\)/);

    // On the proposal itself, so it survives the session that made it (R-19).
    const staged = await gate.readManifest(draft.proposalId);
    assert.deepEqual(staged.skill, SKILL);
    await store.close();
  });

  it("says so when no skill ships for the family, rather than failing or borrowing one", async () => {
    const { store, gate } = await open();
    const production = store.getBundle().productions[0]!;
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: production.meta.id,
      brief: "A quiet scene",
      skill: null,
    });
    assert.equal(draft.skill, null);
    assert.match(draft.scope, /general — no skill ships for this model family/);

    const staged = await gate.readManifest(draft.proposalId);
    assert.equal(staged.skill, undefined, "absent is an ordinary record, not a missing field");
    // The fallback is stated but never blocking: the draft still went out.
    assert.ok(draft.instruction.includes("Fill the shots array"));
    await store.close();
  });
});

describe("SPEC-019 skill-family mismatch at dispatch (R-21, T-14)", () => {
  const drafted = { skillId: "seedance-scene-drafting", version: 1, family: "seedance" };
  const seedance = { ...VIDEO_MODEL, family: "seedance" };

  it("says nothing when the scene and the model agree", () => {
    const scene: Scene = {
      id: "sc_1", number: 1, slug: "s", title: "S", status: "draft", version: 1,
      draftedWith: drafted, shots: [shot(1, 4)],
    };
    assert.equal(skillFamilyMismatch(scene, seedance), null);
  });

  it("names the mismatch when a dispatch overrides the routed model to another family", () => {
    const scene: Scene = {
      id: "sc_1", number: 1, slug: "s", title: "S", status: "draft", version: 1,
      draftedWith: drafted, shots: [shot(1, 4)],
    };
    const other = { ...VIDEO_MODEL, id: "veo-3.1", displayName: "Veo 3.1", family: "veo" };
    assert.deepEqual(skillFamilyMismatch(scene, other), {
      draftedFor: "seedance",
      dispatchingTo: "veo",
      skillId: "seedance-scene-drafting",
    });
  });

  it("names it when the target declares no family at all", () => {
    const scene: Scene = {
      id: "sc_1", number: 1, slug: "s", title: "S", status: "draft", version: 1,
      draftedWith: drafted, shots: [shot(1, 4)],
    };
    // Shots written to one family's conventions, sent where those conventions are not known to
    // apply. Silence here would be indistinguishable from agreement.
    assert.deepEqual(skillFamilyMismatch(scene, VIDEO_MODEL), {
      draftedFor: "seedance",
      dispatchingTo: null,
      skillId: "seedance-scene-drafting",
    });
  });

  it("a scene drafted under general guidance never mismatches", () => {
    const scene: Scene = {
      id: "sc_1", number: 1, slug: "s", title: "S", status: "draft", version: 1,
      shots: [shot(1, 4)],
    };
    assert.equal(skillFamilyMismatch(scene, seedance), null, "guidance for no family is wrong for none");
    assert.equal(skillFamilyMismatch(scene, VIDEO_MODEL), null);
  });

  it("reaches the dialog through the plan, and does not block it", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene: Scene = { ...writerSceneView(production.scenes[0]!), draftedWith: drafted };
    const other = { ...VIDEO_MODEL, id: "veo-3.1", displayName: "Veo 3.1", family: "veo" };
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: other,
      },
      "per-shot",
    );
    assert.equal(plan.warnings.skillFamilyMismatch?.draftedFor, "seedance");
    assert.equal(plan.warnings.skillFamilyMismatch?.dispatchingTo, "veo");
    assert.ok(plan.shots.length > 0, "a warning names, it never blocks (SPEC-012 D12)");

    const matched = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: production.selections,
        model: { ...VIDEO_MODEL, family: "seedance" },
      },
      "per-shot",
    );
    assert.equal(matched.warnings.skillFamilyMismatch, null);
    await store.close();
  });

  it("survives the draft: the skill lands on the scene, not only on the proposal", async () => {
    const { store, gate } = await open();
    const production = store.getBundle().productions[0]!;
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: production.meta.id,
      brief: "The tide turns",
      skill: { id: "seedance-scene-drafting", version: 1, family: "seedance" },
    });
    // The proposal's target is the scene file, so what dispatch reads months later is what was
    // staged here — the proposal itself is long gone by then.
    const staged = await gate.readManifest(draft.proposalId);
    const target = staged.targets.find((entry) => entry.path === draft.path);
    assert.ok(target, "the scene file is the proposal's target");
    const content = await readFile(join(store.dir, ".proposals", draft.proposalId, ...draft.path.split("/")), "utf8");
    const parsed = SceneSchema.parse(JSON.parse(content));
    assert.deepEqual(parsed.draftedWith, { skillId: "seedance-scene-drafting", version: 1, family: "seedance" });
    await store.close();
  });
});

describe("a location sheet at dispatch (#243)", () => {
  const VIEWS = [
    { id: "lv_a", name: "Establishing view", file: "takes/tk_a/view.png" },
    { id: "lv_b", name: "Reverse angle", file: "takes/tk_b/view.png" },
    { id: "lv_c", name: "Night", file: "takes/tk_c/view.png" },
  ];
  const kitWithSheet = (): ReferenceKit => ({
    sheetId: "the-vigil",
    tiles: [],
    mainPhoto: {
      file: "main-photo.png",
      sheetVersion: 1,
      acceptedAt: "2026-08-01T12:00:00.000Z",
      source: "upload",
    },
    locationViews: VIEWS.map((view) => ({
      ...view,
      sourceTakeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC",
      sheetVersion: 1,
      artDirectionVersion: 1,
      acceptedAt: "2026-08-01T12:00:00.000Z",
      status: "active" as const,
    })),
    establishingViewId: "lv_a",
    compilations: [
      {
        file: "location-sheet-abc123def456.png",
        format: "location-sheet" as const,
        sheetVersion: 1,
        tiles: VIEWS.map((view) => view.file),
        compiledAt: "2026-08-01T12:00:00.000Z",
        source: "local" as const,
        accepted: true,
      },
    ],
  });
  const scene = (): Scene => ({
    id: "sc_243",
    number: 243,
    slug: "t",
    title: "T",
    status: "draft",
    version: 1,
    inherits: { location: "the-vigil", timeOfDay: "night" },
    shots: [shot(1, 5, "@maren-kest at the rail")],
  });
  const plan = (kits: ReferenceKit[], bundle: { meta: WorldMeta; sheets: Sheet[] }) =>
    planScene(
      { world: bundle.meta, sheets: bundle.sheets, kits, scene: scene(), selections: {}, model: VIDEO_MODEL },
      "per-shot",
    );

  it("the location sheet replaces the single view, and the panel map matches what is sent", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const others = bundle.referenceKits.filter((kit) => kit.sheetId !== "the-vigil");

    // Before: a location with only a main photo carries that one image, described generically.
    const single = plan([...others, { ...kitWithSheet(), locationViews: undefined, compilations: [] }], bundle);
    const singleVigil = single.shots[0]!.bound.find((reference) => reference.sheetId === "the-vigil")!;
    assert.equal(singleVigil.file, "references/the-vigil/main-photo.png");
    assert.match(singleVigil.rolePhrase, /^location reference/);

    // After: the same slot carries the assembled sheet instead — one image, not four fighting
    // for the same budget — and the prompt says which angle is in which band of it.
    const sheeted = plan([...others, kitWithSheet()], bundle);
    const shotPlan = sheeted.shots[0]!;
    const vigil = shotPlan.bound.find((reference) => reference.sheetId === "the-vigil")!;
    assert.equal(vigil.file, "references/the-vigil/location-sheet-abc123def456.png");
    assert.equal(
      shotPlan.bound.filter((reference) => reference.sheetId === "the-vigil").length,
      1,
      "a place takes one slot however many angles it has",
    );
    assert.equal(
      vigil.rolePhrase,
      "location sheet: panel 1 (top), Establishing view; panel 2, Reverse angle; panel 3 (bottom), Night",
    );

    // The map is only true if the numbering it uses is the numbering the request uses.
    const preamble = shotPlan.parts.preamble!;
    assert.ok(
      preamble.includes(`Image ${vigil.index}: The Vigil — ${vigil.rolePhrase}.`),
      `panel map is bound to the image it describes:\n${preamble}`,
    );
    assert.equal(
      boundFiles(shotPlan.bound)[vigil.index - 1],
      vigil.file,
      "and the numbered image is the one actually transmitted",
    );
    await store.close();
  });

  it("says nothing about panels it cannot name, rather than guessing them", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const others = bundle.referenceKits.filter((kit) => kit.sheetId !== "the-vigil");
    // A tile with no view behind it: the sheet is still carried, but a map that misnames a band
    // is worse than none — the model would trust it and bind the wrong angle.
    const kit = kitWithSheet();
    const orphaned: ReferenceKit = {
      ...kit,
      compilations: [{ ...kit.compilations[0]!, tiles: [...kit.compilations[0]!.tiles, "takes/tk_gone/view.png"] }],
    };
    const shotPlan = plan([...others, orphaned], bundle).shots[0]!;
    const vigil = shotPlan.bound.find((reference) => reference.sheetId === "the-vigil")!;
    assert.equal(vigil.file, "references/the-vigil/location-sheet-abc123def456.png");
    assert.match(vigil.rolePhrase, /^location reference/, "carried, unmapped");
    await store.close();
  });
});

describe("standing constraints (#244, design turn 59)", () => {
  const world = (music: "environmental-only" | "allow-model-score", failureModes: string[] = []) => ({
    audio: { music, subtitles: "never" as const },
    failureModes,
  });

  it("a production may tighten the world's music policy and can never loosen it", () => {
    // The type is the guard: `musicPolicy` is the single literal "environmental-only", so there
    // is no value a production could set that relaxes a strict world. What is testable is that
    // the merge honours a tightening and ignores nothing else.
    assert.equal(standingConstraints(world("allow-model-score")).music, "allow-model-score");
    assert.equal(
      standingConstraints(world("allow-model-score"), { musicPolicy: "environmental-only" }).music,
      "environmental-only",
      "a production that composes its own score tightens a permissive world",
    );
    assert.equal(
      standingConstraints(world("environmental-only"), {}).music,
      "environmental-only",
      "and a strict world stays strict when the production says nothing",
    );
  });

  it("stacks failure modes world-first, and adds rather than replaces", () => {
    const merged = standingConstraints(world("environmental-only", ["World rule."]), {
      failureModes: ["Production rule."],
    });
    assert.deepEqual(merged.failureModes, ["World rule.", "Production rule."]);
    assert.equal(merged.subtitles, "never", "one value in v1, and stated rather than assumed");
  });

  it("resolves a world that predates the policy to the defaults, not to nothing", () => {
    const merged = standingConstraints(null);
    assert.deepEqual(merged, { music: "environmental-only", subtitles: "never", failureModes: [] });
  });

  it("puts the policy into the negatives a video dispatch actually carries", () => {
    const strict = derivedNegatives({
      capability: "video",
      constraints: standingConstraints(world("environmental-only", ["Hands stay whole and countable."])),
    })!;
    assert.match(strict, /^No subtitles\./);
    assert.match(strict, /No background music — environmental and action sound only\./);
    assert.match(strict, /Hands stay whole and countable\.$/, "failure modes come last, after the audio direction");

    // A permissive world says nothing about music, which is not the same as permitting it twice.
    const permissive = derivedNegatives({ capability: "video", constraints: standingConstraints(world("allow-model-score")) })!;
    assert.ok(!permissive.includes("No background music"));

    // Stills are unaffected: these are constraints on a clip's soundtrack.
    assert.equal(derivedNegatives({ capability: "image", constraints: standingConstraints(world("environmental-only")) }), null);
  });

  it("keeps the cut's own score condition when the standing policy is permissive", () => {
    // The two reasons are an OR, not a replacement. A policy that switched itself off the moment
    // somebody added a score track would switch off exactly where it matters most.
    const withCut = derivedNegatives({
      capability: "video",
      audioDesign: { scoreTrack: true },
      constraints: standingConstraints(world("allow-model-score")),
    })!;
    assert.match(withCut, /No background music/, "a composed score still forbids a generated one");
  });

  it("reaches a real dispatch — both per-shot and whole-scene", async () => {
    // The gap the review caught: the merge existed and planScene never called it, so a policy
    // was durable, versioned, displayed — and absent from every request it was written for.
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const base = writerSceneView(production.scenes[0]!);
    const scene: Scene = { ...base, shots: [shot(1, 5, "@maren-kest at the rail"), shot(2, 5, "@maren-kest turns")] };
    const input = {
      world: bundle.meta,
      productionId: production.meta.id,
      artDirection: { ...bundle.artDirection, audio: { music: "environmental-only" as const, subtitles: "never" as const }, failureModes: ["Hands stay whole and countable."] },
      production: { failureModes: ["The lamp is always lit from the left."] },
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: {},
      model: VIDEO_MODEL,
    };

    const perShot = planScene(input, "per-shot");
    const negatives = perShot.shots[0]!.parts.negatives!;
    assert.match(negatives, /No background music/, "the world's policy reaches the request");
    assert.match(negatives, /Hands stay whole and countable\./);
    assert.match(negatives, /The lamp is always lit from the left\.$/, "and the production's, after it");

    const whole = planScene(input, "whole-scene");
    assert.match(whole.passReferences[0]!.negatives!, /No background music/, "the pass carries the same clip's constraints");
    assert.match(whole.passReferences[0]!.negatives!, /The lamp is always lit from the left\./);
    await store.close();
  });

  it("carries visual failure modes onto stills, and the soundtrack clauses only onto video", () => {
    // "Hands stay whole" is not a soundtrack rule. A world that wrote it down meant it for every
    // generation, and derivedNegatives used to return before stills could ever see it.
    const constraints = standingConstraints(world("environmental-only", ["Hands stay whole and countable."]));
    const still = derivedNegatives({ capability: "image", constraints })!;
    assert.equal(still, "Hands stay whole and countable.", "the visual rule, and nothing about audio");
    assert.ok(!still.includes("No subtitles"), "a still has no soundtrack and burns in no titles");

    // And a still with nothing to say still says nothing, exactly as before this existed.
    assert.equal(derivedNegatives({ capability: "image", constraints: standingConstraints(world("environmental-only")) }), null);
    assert.equal(derivedNegatives({ capability: "image" }), null);
  });

  it("behaves exactly as it did before the policy existed when nobody resolved one", () => {
    // A preview assembled before the world was read carries no constraints. Stating one nobody
    // asked for would be inventing policy from absence.
    assert.equal(derivedNegatives({ capability: "video" }), "No subtitles.");
  });
});

/**
 * Authored shot direction that must leave the disk and reach generation.
 *
 * `framing` appeared nowhere in `planning.ts`. A director set a size, an angle, a lens, a focus,
 * a movement, a pace, a light, a time of day and a grade on the shot sheet; all nine were
 * versioned, shown in the UI, and dropped before the prompt was assembled. `continuity.keepOut`
 * — documented in the schema as "the negative half of the same promise" — was read by nothing,
 * and so were `audio.ambience` and `audio.effects`. Every one is authored intent with no effect,
 * which is the failure this file's whole vocabulary exists to prevent.
 */
describe("the shot's cinematic intent, timing, structured camera, negatives and sound", () => {
  const scene = (shots: Shot[]): Scene => ({
    id: "sc_91",
    number: 91,
    slug: "t",
    title: "T",
    status: "draft",
    version: 1,
    inherits: { location: "the-vigil", timeOfDay: "night" },
    shots,
  });

  it("puts cinematic intent before explicit camera, then keeps authored timing in order", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      intent: "Held, not slow — she is deciding whether to have heard it.",
      camera: "slow push-in, medium close-up",
      beats: [
        { span: " 0–2s ", text: " Nothing moves. " },
        { span: "2–6s", text: "She turns toward the bell" },
      ],
    };
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([s]), shot: s });
    assert.equal(
      blocks.direction,
      "Cinematic intent (infer unset camera choices from this; explicit camera settings win): " +
        "Held, not slow — she is deciding whether to have heard it. " +
        "slow push-in, medium close-up. Shot timing 0–2s: Nothing moves. " +
        "Shot timing 2–6s: She turns toward the bell.",
    );
    await store.close();
  });

  it("keeps cinematic intent but drops temporal rows from a still prompt", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      intent: "A held breath",
      beats: [{ span: "0–6s", text: "She crosses the room" }],
    };
    const blocks = assembleBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([s]),
      shot: s,
      capability: "image",
    });
    assert.match(blocks.direction, /infer unset camera choices from this/);
    assert.ok(!blocks.direction.includes("Shot timing"), "one still cannot depict a temporal sequence");
    await store.close();
  });

  it("keeps authored question and exclamation punctuation", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      intent: "Will she run?",
      beats: [{ span: "0–6s", text: "Hold the tension!" }],
    };
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([s]), shot: s });
    assert.match(blocks.direction, /Will she run\?/);
    assert.match(blocks.direction, /Hold the tension!/);
    assert.ok(!/[?!]\./.test(blocks.direction), `authored punctuation is terminated once: ${blocks.direction}`);
    await store.close();
  });

  it("says the framing a director set, resolved against the scene's defaults", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      framing: { size: "medium close-up", angle: "low", movement: "slow push-in" },
    };
    const withDefaults = { ...scene([s]), defaults: { lens: "35mm", grade: "cold, high contrast" } };
    const blocks = assembleBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: withDefaults,
      shot: s,
      capability: "video",
    });
    const said = `${blocks.cameraAnchor} ${blocks.direction}`;
    for (const value of ["medium close-up", "low", "slow push-in"]) {
      assert.ok(said.includes(value), `the shot's own ${value} reaches the model`);
    }
    // Presence is the override flag (turn 97), so an inherited field still has to be spoken.
    assert.ok(said.includes("35mm"), "a lens inherited from the scene is still said");
    assert.ok(said.includes("cold, high contrast"), "and so is the grade");
    await store.close();
  });

  it("says nothing about a camera nobody set, rather than a default", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const bare: Shot = shot(1, 6, "@maren-kest grips the rail");
    const blocks = assembleBlocks({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: scene([bare]),
      shot: bare,
      capability: "video",
    });
    // "default lens" is a real instruction to a model that reads everything it is handed.
    assert.equal(blocks.cameraAnchor, "", "no framing and no camera is no camera block");
    await store.close();
  });

  it("keeps the authored camera and the framing as separate sentences", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      camera: "at the rail desk, facing the harbour mouth",
      framing: { size: "medium close-up" },
    };
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([s]), shot: s });
    // Without the anchor block to separate them, "facing the harbour mouth medium close-up" is
    // one garbled instruction rather than a placement and a size.
    assert.ok(
      !/harbour mouth medium close-up/.test(blocks.direction),
      `placement and size do not run together: ${blocks.direction}`,
    );
    await store.close();
  });

  it("carries keepOut into the negatives, not into the description", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      continuity: { keepOut: "No wristwatch; no plastic chairs in frame." },
    };
    const negatives = derivedNegatives({ capability: "video", shot: s });
    assert.ok(negatives, "there is something to say");
    assert.ok(negatives.includes("No wristwatch"), "what must stay out of frame is said");
    // A negative inside the prose is a noun the model has been handed.
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([s]), shot: s });
    assert.ok(!blocks.body.includes("wristwatch"), "and it is not in the description");
    await store.close();
  });

  it("puts ambience and effects beside the action that makes them", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      audio: { kind: "dialogue", line: "Count it again.", ambience: "generator two houses down", effects: "coins on tin" },
    };
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([s]), shot: s });
    assert.match(blocks.direction, /generator two houses down/);
    assert.match(blocks.direction, /coins on tin/);
    await store.close();
  });
});

/**
 * Two ways the new fields could contradict the prompt they joined (codex, 2026-08-23).
 */
describe("the plumbed fields do not fight the rest of the prompt", () => {
  const scene = (shots: Shot[]): Scene => ({
    id: "sc_92",
    number: 92,
    slug: "t",
    title: "T",
    status: "draft",
    version: 1,
    inherits: { location: "the-vigil", timeOfDay: "night" },
    shots,
  });

  it("drops ambience and effects on a shot directed silent", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    // The Sound fields stay editable after a shot goes silent, so leftovers are reachable.
    const s: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      audio: { kind: "silence", ambience: "generator two houses down", effects: "coins on tin" },
    };
    const blocks = assembleBlocks({ world: bundle.meta, sheets: bundle.sheets, scene: scene([s]), shot: s });
    assert.ok(!/generator|coins/.test(blocks.direction), `silence carries no sound: ${blocks.direction}`);
    // And the negative still says so, which is the half that would have been contradicted.
    assert.match(derivedNegatives({ capability: "video", shot: s })!, /No audio\./);
    await store.close();
  });

  it("turns a keep-out list into an instruction rather than a list of nouns", async () => {
    const { store } = await open();
    // The field's own placeholder is a noun list. Appended verbatim it names three things and
    // forbids none — the exact failure the field exists to prevent.
    const listed: Shot = {
      ...shot(1, 6, "@maren-kest grips the rail"),
      continuity: { keepOut: "Modern boats, text, lens flare" },
    };
    const negatives = derivedNegatives({ capability: "video", shot: listed })!;
    assert.match(negatives, /Do not show: Modern boats, text, lens flare\./);

    // An author who already wrote an instruction keeps their own words.
    for (const already of ["No wristwatch on Ife", "Never show the harbour.", "Avoid lens flare"]) {
      const s: Shot = { ...shot(1, 6, "x"), continuity: { keepOut: already } };
      const said = derivedNegatives({ capability: "video", shot: s })!;
      assert.ok(!said.includes("Do not show:"), `"${already}" is left as written`);
      assert.ok(said.includes(already.replace(/\.$/, "")), `and is still said: ${said}`);
    }
    await store.close();
  });
});
