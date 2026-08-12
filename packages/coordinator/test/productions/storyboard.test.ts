import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chooseReferenceSteering,
  planStoryboard,
  storyboardUsable,
  SceneSchema,
  type Job,
  type ManifestModel,
  type Scene,
  type Shot,
} from "@arke-studio/contracts";
import { acceptStoryboard, recordStoryboard, storyboardRequest } from "../../src/productions/storyboard.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { atomicWriteFile } from "../../src/world/atomic.js";

/**
 * SPEC-019 T-15, T-16: a storyboard drawn to be read — dispatched, priced and landed like any
 * other generation, and accepted before it may steer one.
 */

const CLOCK = () => "2026-08-09T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store };
}

const TARGET: ManifestModel = {
  id: "seedance-2.0",
  provider: "fal",
  capability: "video",
  displayName: "Seedance 2.0",
  family: "seedance",
  accepts: { referenceImages: 2, startFrame: true, endFrame: true },
  limits: { maxDurationSec: 15, storyboardPanels: 3 },
  pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
};

const DRAWER: ManifestModel = {
  id: "flux-2-pro",
  provider: "fal",
  capability: "image",
  displayName: "Flux 2 Pro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
};

const shot = (n: number, description: string): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec: 4,
});

const sceneWith = (shots: Shot[], version = 1): Scene => ({
  id: "sc_01",
  number: 1,
  slug: "the-turn",
  title: "The turn",
  status: "draft",
  version,
  inherits: { location: "the-vigil", timeOfDay: "night" },
  shots,
});

describe("storyboard planning (R-23, R-24)", () => {
  it("draws panels from the same descriptions the prompt is assembled from", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const scene = sceneWith([shot(1, "@maren-kest grips the rail"), shot(2, "she turns away")]);
    const plan = planStoryboard({ world: bundle.meta, sheets: bundle.sheets, scene, target: TARGET });
    assert.equal(plan.panels.length, 2);
    // Mentions are resolved the same way assembly resolves them, so the board and the prompt
    // cannot describe two different things (R-24, D28).
    assert.match(plan.panels[0]!.text, /Maren Kest grips the rail/);
    assert.ok(!plan.panels[0]!.text.includes("@maren-kest"));
    await store.close();
  });

  it("states line art and forbids text in the image, every time", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const plan = planStoryboard({
      world: bundle.meta,
      sheets: bundle.sheets,
      scene: sceneWith([shot(1, "a figure at the rail")]),
      target: TARGET,
      artDirection: "salt-bleached neo-noir",
    });
    assert.match(plan.prompt, /line art/i);
    assert.match(plan.prompt, /No text anywhere in the image/);
    // The world's look names the subject matter and must not become a rendering instruction:
    // a board rendered in the world's style stops being line art.
    assert.match(plan.prompt, /salt-bleached neo-noir/);
    assert.match(plan.prompt, /never how it is drawn/);
    await store.close();
  });

  it("caps panels at what the reading model handles, and names what it left out", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const scene = sceneWith([1, 2, 3, 4, 5].map((n) => shot(n, `beat ${n}`)));
    const plan = planStoryboard({ world: bundle.meta, sheets: bundle.sheets, scene, target: TARGET });
    assert.equal(plan.panels.length, 3, "the cap belongs to the model that reads the board");
    assert.deepEqual(plan.dropped.map((entry) => entry.number), [4, 5]);
    assert.match(plan.notice!, /leaving out 4, 5/);
    await store.close();
  });

  it("draws every shot when the reading model states no cap", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const scene = sceneWith([1, 2, 3, 4, 5].map((n) => shot(n, `beat ${n}`)));
    const uncapped = { ...TARGET, limits: { maxDurationSec: 15 } };
    const plan = planStoryboard({ world: bundle.meta, sheets: bundle.sheets, scene, target: uncapped });
    assert.equal(plan.panels.length, 5);
    assert.equal(plan.notice, null);
    await store.close();
  });
});

describe("storyboard dispatch (R-25)", () => {
  it("is priced and composed like any other generation, carrying no references in", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const scene = sceneWith([shot(1, "@maren-kest grips the rail")]);
    const request = storyboardRequest(bundle, bundle.productions[0]!.meta.id, scene, DRAWER, TARGET);
    assert.ok(request.estimatedMicroUsd > 0, "a board costs money and says how much before it is drawn");
    assert.equal(request.input.capability, "image");
    assert.equal(request.input.target.kind, "storyboard");
    assert.equal(request.input.target.id, "sc_01");
    assert.deepEqual(request.input.params["references"], [], "a conditioned board stops being line art");
    const provenance = request.input.params["provenance"] as { sceneVersion: number };
    assert.equal(provenance.sceneVersion, 1, "frozen at dispatch, so staleness is computable later");
    await store.close();
  });

  it("a board obeys the standing failure modes too — the world's and the production's (#244)", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const constrained = {
      ...bundle,
      artDirection: { ...bundle.artDirection, failureModes: ["Hands stay whole and countable."] },
      productions: bundle.productions.map((production) => ({
        ...production,
        meta: { ...production.meta, failureModes: ["The lamp is always lit from the left."] },
      })),
    };
    const request = storyboardRequest(
      constrained,
      bundle.productions[0]!.meta.id,
      sceneWith([shot(1, "@maren-kest grips the rail")]),
      DRAWER,
      TARGET,
    );
    const prompt = String(request.input.params["prompt"]);
    assert.match(prompt, /Hands stay whole and countable\./, "the world's rule reaches line art");
    assert.match(prompt, /The lamp is always lit from the left\.$/, "the production's after it, world first");
    assert.equal(request.plan.prompt, prompt, "the plan a reviewer reads is the prompt the model gets");
    await store.close();
  });

  it("refuses to be drawn by a model that cannot draw, and refuses an empty scene", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!.meta.id;
    assert.throws(
      () => storyboardRequest(bundle, production, sceneWith([shot(1, "x")]), TARGET, TARGET),
      /not an image model/,
    );
    assert.throws(() => storyboardRequest(bundle, production, sceneWith([]), DRAWER, TARGET), /no shots to draw/);
    await store.close();
  });
});

describe("storyboard landing and acceptance (R-25, R-27)", () => {
  async function landOne(store: WorldStore, productionId: string, sceneId: string, sceneVersion: number) {
    const landed = `productions/${productionId}/storyboards/incoming/${sceneId}.png`;
    await atomicWriteFile(join(store.dir, ...landed.split("/")), Uint8Array.from([137, 80, 78, 71]));
    const job = {
      id: "jb_0001",
      target: { kind: "storyboard", id: sceneId },
      landedFiles: [landed],
      params: { provenance: { sceneVersion, panels: ["sh_1"] } },
    } as unknown as Job;
    return recordStoryboard(store, productionId, job);
  }

  it("lands unaccepted, and cannot steer until someone accepts it", async () => {
    const { store } = await open();
    const production = store.getBundle().productions[0]!;
    const sceneId = production.scenes[0]!.id;
    const version = production.scenes[0]!.version;

    const landed = await landOne(store, production.meta.id, sceneId, version);
    assert.equal(landed?.accepted, false, "landing is not approval (R-25)");

    const beforeScene = store.getBundle().productions[0]!.scenes.find((s) => s.id === sceneId)!;
    assert.equal(storyboardUsable(beforeScene).usable, false);
    assert.match(storyboardUsable(beforeScene).reason!, /not been accepted/);

    await acceptStoryboard(store, production.meta.id, sceneId);
    const afterScene = store.getBundle().productions[0]!.scenes.find((s) => s.id === sceneId)!;
    assert.equal(afterScene.storyboard?.accepted, true);
    assert.equal(storyboardUsable(afterScene).usable, true);
    await store.close();
  });

  it("lands once per job, and re-delivery never re-opens an acceptance", async () => {
    const { store } = await open();
    const production = store.getBundle().productions[0]!;
    const sceneId = production.scenes[0]!.id;
    const version = production.scenes[0]!.version;
    await landOne(store, production.meta.id, sceneId, version);
    await acceptStoryboard(store, production.meta.id, sceneId);

    // The same completion arriving twice is an ordinary queue event, and it must not undo a
    // decision the user already made.
    await landOne(store, production.meta.id, sceneId, version);
    const scene = store.getBundle().productions[0]!.scenes.find((s) => s.id === sceneId)!;
    assert.equal(scene.storyboard?.accepted, true, "re-delivery is idempotent");
    await store.close();
  });

  it("refuses to accept a board drawn from a scene that has moved on", async () => {
    const { store } = await open();
    const production = store.getBundle().productions[0]!;
    const sceneId = production.scenes[0]!.id;
    // Drawn from a version the scene is not at: the panels describe shots that have since been
    // edited, which is the contradiction R-24 exists to prevent, arriving by hand.
    await landOne(store, production.meta.id, sceneId, production.scenes[0]!.version + 1);
    await assert.rejects(() => acceptStoryboard(store, production.meta.id, sceneId), /redraw it/);
    await store.close();
  });

  it("records the board on the scene without cutting a version", async () => {
    const { store } = await open();
    const production = store.getBundle().productions[0]!;
    const scene = production.scenes[0]!;
    await landOne(store, production.meta.id, scene.id, scene.version);
    const file = `productions/${production.meta.id}/scenes/${String(scene.number).padStart(2, "0")}-${scene.slug}.json`;
    const parsed = SceneSchema.parse(JSON.parse(await readFile(join(store.dir, ...file.split("/")), "utf8")));
    assert.equal(parsed.version, scene.version, "a board is production output, not a gated change");
    assert.equal(parsed.storyboard?.sourceJobId, "jb_0001", "its cost stays findable in the ledger");
    await store.close();
  });

  it("says a scene with no board cannot steer one", () => {
    assert.equal(storyboardUsable(sceneWith([shot(1, "x")])).usable, false);
    assert.match(storyboardUsable(sceneWith([shot(1, "x")])).reason!, /no storyboard/);
  });
});

describe("which pictures steer the dispatch (R-26, R-27, T-17, T-18)", () => {
  const board = (accepted: boolean, sceneVersion: number) => ({
    file: "storyboards/sc_01-v1.png",
    sceneVersion,
    panels: ["sh_1", "sh_2"],
    drawnAt: CLOCK(),
    sourceJobId: "jb_0001",
    accepted,
  });
  const twoShots = [shot(1, "a"), shot(2, "b")];
  const framed = { sh_1: { startFrameTakeId: "tk_1" }, sh_2: { acceptedTakeId: "tk_2" } } as never;

  it("prefers keyframes when every shot has a frame and the whole sequence fits", () => {
    const scene = sceneWith(twoShots);
    const choice = chooseReferenceSteering({ scene, selections: framed, model: TARGET });
    assert.equal(choice.mode, "keyframes");
    assert.equal(choice.mode === "keyframes" && choice.frames.length, 2);
    // A pinned start frame wins over the currently accepted take, matching the board compiler.
    assert.equal(choice.mode === "keyframes" && choice.frames[0]!.takeId, "tk_1");
    assert.match(choice.statement, /keyframes/);
  });

  it("falls back to the storyboard when a shot has no frame, and says which", () => {
    const scene: Scene = { ...sceneWith(twoShots), storyboard: board(true, 1) };
    const partial = { sh_1: { startFrameTakeId: "tk_1" } } as never;
    const choice = chooseReferenceSteering({ scene, selections: partial, model: TARGET });
    assert.equal(choice.mode, "storyboard");
    assert.match(choice.statement, /shot 2 has no frame/);
    assert.match(choice.statement, /incomplete/);
  });

  it("refuses keyframes when the sequence would be truncated by the budget", () => {
    // The gap that is easy to miss: a frame per shot, and still more shots than the cap. A
    // partial sequence is worse than none — the model aligns to what it got and invents the rest.
    const many = [1, 2, 3, 4].map((n) => shot(n, `beat ${n}`));
    const scene: Scene = { ...sceneWith(many), storyboard: board(true, 1) };
    const all = Object.fromEntries(many.map((s) => [s.id, { startFrameTakeId: `tk_${s.number}` }])) as never;
    const choice = chooseReferenceSteering({ scene, selections: all, model: TARGET });
    assert.equal(choice.mode, "storyboard", "TARGET accepts 2 reference images; 4 shots cannot all travel");
    assert.match(choice.statement, /4 shots exceed/);
    assert.match(choice.statement, /truncated/);
  });

  it("blocks a stale board from steering and says to redraw it", () => {
    // T-17: the scene moved on, so the panels describe shots that have been edited.
    const scene: Scene = { ...sceneWith(twoShots, 3), storyboard: board(true, 1) };
    const choice = chooseReferenceSteering({ scene, selections: {}, model: TARGET });
    assert.equal(choice.mode, "none");
    assert.match(choice.statement, /drawn from v1 and the scene is at v3/);
    assert.match(choice.statement, /redraw it/);
  });

  it("blocks an unaccepted board, and states both reasons when nothing can steer", () => {
    const scene: Scene = { ...sceneWith(twoShots), storyboard: board(false, 1) };
    const choice = chooseReferenceSteering({ scene, selections: {}, model: TARGET });
    assert.equal(choice.mode, "none");
    assert.match(choice.statement, /no frame/, "why keyframes were not available");
    assert.match(choice.statement, /not been accepted/, "and why the board was not either");
  });

  it("reaches the dialog through the plan", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const { planScene } = await import("@arke-studio/contracts");
    const plan = planScene(
      {
        world: bundle.meta,
        artDirection: bundle.artDirection,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: production.scenes[0]!,
        selections: production.selections,
        model: TARGET,
      },
      "per-shot",
    );
    assert.ok(plan.steering.statement.length > 0, "the choice is always stated");
    await store.close();
  });
});
