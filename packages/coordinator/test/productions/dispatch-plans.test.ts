import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteShot,
  DispatchPlanSchema,
  foldPlan,
  orderedShots,
  planScene,
  SceneRecordSchema,
  START_FRAME_PREAMBLE,
  type DispatchPlan,
  type ManifestModel,
  type PlanEventLike,
  type PlanJobFacts,
  type Scene,
  type Shot,
  type Take,
} from "@arke-studio/contracts";
import {
  advancePlan,
  appendPlanEvents,
  createDispatchPlan,
  listPlans,
  planState,
  readPlanEvents,
  type PlanDriverDeps,
} from "../../src/productions/plans.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import type { BoundaryFrameMaker } from "../../src/takes/boundary.js";
import { WorldStore } from "../../src/world/store.js";
import { sha256 } from "../../src/world/text-files.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";

/**
 * Durable scene-dispatch plans (SPEC-024; issue #402). Test names carry the adversarial matrix's
 * T-numbers: each attacks one invariant, mostly by dying in a crash window and reopening.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

/** A wan-shaped model: frame route present, so whole-scene passes chain (SPEC-024 R-5). */
const CHAINING: ManifestModel = {
  id: "wan-like",
  provider: "fal",
  capability: "video",
  displayName: "Wan-like",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 10, durations: { "5": "5", "10": "10" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
  modes: { "first-frame": { route: "acme/wan-like/image-to-video", locked: ["aspect"] } },
};

const shot = (n: number, durationSec: number, description = `Shot ${n}`): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec,
});

/** A fake queue honouring the pre-allocated-key contract the real dispatcher now has. */
function fakeQueue() {
  const jobs = new Map<string, { id: string; status: PlanJobFacts["status"]; input: EnqueueInput }>();
  const byKey = new Map<string, string>();
  let counter = 0;
  return {
    jobs,
    enqueue: async (input: EnqueueInput) => {
      const key = input.idempotencyKey!;
      const existing = byKey.get(key);
      if (existing !== undefined) return { id: existing };
      const id = `jb_fake_${++counter}`;
      byKey.set(key, id);
      jobs.set(id, { id, status: "queued", input });
      return { id };
    },
    settle: (id: string, status: PlanJobFacts["status"]) => {
      jobs.get(id)!.status = status;
    },
    facts: (ids: readonly string[]) =>
      ids.flatMap((id) => (jobs.has(id) ? [{ id, status: jobs.get(id)!.status }] : [])),
  };
}

function deps(queue: ReturnType<typeof fakeQueue>, maker?: BoundaryFrameMaker): PlanDriverDeps {
  return {
    enqueue: queue.enqueue,
    jobFacts: queue.facts,
    boundaryFrameMaker: maker,
    clock: CLOCK,
  };
}

const workingMaker: BoundaryFrameMaker = {
  write: async (_input, output) => {
    await writeFile(output, encodePng(solidImage(4, 4, [0, 255, 0, 255])));
    return { ok: true };
  },
};

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  const bundle = store.getBundle();
  const production = bundle.productions[0]!;
  const scene: Scene = { ...production.scenes[0]!, shots: [shot(1, 6, "an empty pier"), shot(2, 6, "the bell")] };
  const scenePlan = planScene(
    {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: {},
      model: CHAINING,
    },
    "whole-scene",
  );
  return { dir, store, bundle, production, scene, scenePlan };
}

async function create(fixture: Awaited<ReturnType<typeof open>>, requestId = "01J8E0000000000000000000R1") {
  return createDispatchPlan(fixture.store, {
    worldId: WORLD_ID,
    productionId: fixture.production.meta.id,
    scene: fixture.scene,
    plan: fixture.scenePlan,
    model: CHAINING,
    world: fixture.bundle,
    policy: "review-gated",
    requestId,
    clock: CLOCK,
  });
}

/** Land pass 0's take on disk and in a bundle copy, so extraction has footage to cut. */
async function landPassZero(
  fixture: Awaited<ReturnType<typeof open>>,
  jobId: string,
): Promise<typeof fixture.production> {
  const takeId = "tk_01J8E0000000000000000000Z1";
  const takeDir = join(fixture.dir, "productions", fixture.production.meta.id, "takes", takeId);
  await mkdir(takeDir, { recursive: true });
  await writeFile(join(takeDir, "clip.mp4"), Buffer.from("fake-footage"));
  const take: Take = {
    id: takeId,
    jobId,
    coversShots: ["sh_1"],
    kind: "clip",
    provider: "fal",
    model: CHAINING.id,
    provenance: { canonRevision: fixture.bundle.meta.canonRevision, sheets: {} },
    references: [],
    params: {},
    cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
    dispatchedAt: CLOCK(),
    media: "clip.mp4",
  };
  return { ...fixture.production, takes: [...fixture.production.takes, take] };
}

describe("durable scene-dispatch plans (SPEC-024; issue 402)", () => {
  it("T-1/T-2: one requestId is one plan, durable and authorized before any spend", async () => {
    const fixture = await open();
    const queue = fakeQueue();
    const first = await create(fixture);
    const second = await create(fixture);
    assert.equal(second.planId, first.planId, "redelivery finds the plan, never a second spend path");
    const raw = await readFile(
      join(fixture.dir, "productions", fixture.production.meta.id, "plans", `${first.planId}.json`),
      "utf8",
    );
    const parsed = DispatchPlanSchema.parse(JSON.parse(raw));
    assert.equal(parsed.capMicroUsd, first.passes.reduce((sum, p) => sum + p.compiled.estimatedMicroUsd, 0));
    assert.deepEqual(parsed.passes[1]!.dependsOn, [{ passIndex: 0, needs: "boundary-frame" }]);
    assert.equal(parsed.passes[1]!.compiled.route.kind, "frame", "priced on the route it will take (T-17)");
    assert.match(String(parsed.passes[1]!.compiled.params["prompt"]), new RegExp(START_FRAME_PREAMBLE.slice(0, 20)));
    const events = await readPlanEvents(fixture.store, fixture.production.meta.id, first.planId);
    assert.equal(events[0]!.kind, "authorized");
    assert.equal(queue.jobs.size, 0, "creation alone reached no provider");
  });

  it("T-3/T-4: the crash between materialised and enqueued lands on the same idempotency key", async () => {
    const fixture = await open();
    const plan = await create(fixture);
    const queue = fakeQueue();
    // First advance dies at enqueue: the materialised event stands, no job exists.
    const dying: PlanDriverDeps = { ...deps(queue), enqueue: async () => Promise.reject(new Error("killed")) };
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, dying);
    const afterCrash = await planState(fixture.store, plan, deps(queue));
    assert.equal(afterCrash.passes[0]!.state, "materialised");
    // Reopen: the same driver re-enqueues the recorded key; the queue holds exactly one job.
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue));
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue));
    assert.equal(queue.jobs.size, 1);
    const [job] = queue.jobs.values();
    assert.equal(job!.input.idempotencyKey, plan.passes[0]!.idempotencyKey);
    assert.equal(job!.input.params["planId"], plan.planId, "the job links back to its authorization (T-16)");
    assert.equal(job!.input.params["passIndex"], 0);
  });

  it("T-5/T-6/T-7: extraction failure blocks by name; success + the visible act unblock", async () => {
    const fixture = await open();
    const plan = await create(fixture);
    const queue = fakeQueue();
    const failing: BoundaryFrameMaker = { write: async () => ({ ok: false, reason: "timeout" }) };
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue, failing));
    const [jobId] = queue.jobs.keys();
    queue.settle(jobId!, "succeeded");
    const landed = await landPassZero(fixture, jobId!);

    // T-7 first: pass 0 succeeded, but a review-gated plan waits for the visible act — forever.
    let state = await advancePlan(fixture.store, landed, fixture.bundle, plan, deps(queue, failing));
    assert.deepEqual(state.next, { kind: "await-continue", passIndex: 1 });
    await appendPlanEvents(fixture.store, fixture.production.meta.id, plan.planId, [
      { kind: "continue-approved", ts: CLOCK(), planId: plan.planId, passIndex: 1 },
    ]);

    // T-5: extraction fails — the pass blocks with the reason named, and nothing dispatches.
    state = await advancePlan(fixture.store, landed, fixture.bundle, plan, deps(queue, failing));
    assert.equal(state.passes[1]!.state, "blocked");
    assert.match(state.passes[1]!.reason!, /timeout/);
    assert.equal(queue.jobs.size, 1, "no frameless fallback dispatch (R-18)");

    // T-6: a later advance with a working extractor recovers and binds the frame fields.
    state = await advancePlan(fixture.store, landed, fixture.bundle, plan, deps(queue, workingMaker));
    assert.equal(state.passes[1]!.state, "enqueued");
    assert.equal(queue.jobs.size, 2);
    const pass1 = [...queue.jobs.values()].find((job) => job.input.params["passIndex"] === 1)!;
    assert.equal(pass1.input.params["taskMode"], "first-frame");
    assert.equal(pass1.input.params["startFrame"], (pass1.input.params["references"] as string[])[0]);
    const frameArtifact = pass1.input.params["frameArtifact"] as { id: string; hash: string };
    assert.match(frameArtifact.hash, /^sha256:/, "the exact bytes are auditable (R-19)");
  });

  it("T-8/T-9: pre-authorization never exceeds the recorded cap without a fresh act", async () => {
    const fixture = await open();
    const base = await create(fixture);
    // A cap below the second pass's estimate — as if prices drifted upward after authorization.
    const capped: DispatchPlan = { ...base, policy: "pre-authorized", capMicroUsd: base.passes[0]!.compiled.estimatedMicroUsd };
    const queue = fakeQueue();
    const events: PlanEventLike[] = [
      { kind: "authorized", ts: CLOCK(), planId: base.planId },
      { kind: "pass-enqueued", ts: CLOCK(), planId: base.planId, passIndex: 0, jobId: "jb_done" },
    ];
    const facts: PlanJobFacts[] = [{ id: "jb_done", status: "succeeded" }];
    const state = foldPlan(capped, events, facts);
    assert.deepEqual(state.next, { kind: "await-reconfirm", passIndex: 1 }, "one micro-USD over is a refusal");
    const reconfirmed = foldPlan(capped, [...events, { kind: "reconfirmed", ts: CLOCK(), planId: base.planId, passIndex: 1 }], facts);
    assert.notEqual(reconfirmed.next.kind, "await-reconfirm", "the fresh act covers it");
    void queue;
  });

  it("T-10: a moved source halts materialisation by name; running work is untouched", async () => {
    const fixture = await open();
    const plan = await create(fixture);
    const queue = fakeQueue();
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue, workingMaker));
    const moved = {
      ...fixture.production,
      scenes: fixture.production.scenes.map((scene) =>
        scene.id === plan.sceneId ? { ...scene, version: scene.version + 1 } : scene,
      ),
    };
    const state = await advancePlan(fixture.store, moved, fixture.bundle, plan, deps(queue, workingMaker));
    assert.equal(state.status, "stale");
    assert.match(state.haltReason!, /the scene moved/);
    assert.equal(queue.jobs.size, 1, "pass 0 runs on; pass 1 never materialises (R-24)");
  });

  it("a moved production look halts future materialisation without changing the strict plan schema", async () => {
    const fixture = await open();
    fixture.scenePlan.effectiveStyle = "Muted winter naturalism";
    fixture.scenePlan.productionStyleOverride = "Muted winter naturalism";
    const styledProduction = {
      ...fixture.production,
      meta: { ...fixture.production.meta, styleOverride: "Muted winter naturalism" },
    };
    const plan = await create({ ...fixture, production: styledProduction });
    assert.equal(
      (plan.passes[0]!.compiled.params["artDirection"] as { source: string }).source,
      "production",
      "the open params bag freezes the source without widening the strict aggregate schema",
    );

    const queue = fakeQueue();
    await advancePlan(fixture.store, styledProduction, fixture.bundle, plan, deps(queue, workingMaker));
    const moved = { ...styledProduction, meta: { ...styledProduction.meta, styleOverride: "Hot saturated pulp" } };
    const state = await advancePlan(fixture.store, moved, fixture.bundle, plan, deps(queue, workingMaker));
    assert.equal(state.status, "stale");
    assert.match(state.haltReason!, /production look moved/);
    assert.equal(queue.jobs.size, 1, "the running pass remains; no later pass materialises");

    const legacyPlanId = `${plan.planId.slice(0, -1)}${plan.planId.endsWith("0") ? "1" : "0"}`;
    const legacy = DispatchPlanSchema.parse({
      ...plan,
      planId: legacyPlanId,
      passes: plan.passes.map((pass) => ({
        ...pass,
        compiled: {
          ...pass.compiled,
          params: Object.fromEntries(Object.entries(pass.compiled.params).filter(([key]) => key !== "artDirection")),
        },
      })),
    });
    const legacyState = await advancePlan(
      fixture.store,
      styledProduction,
      fixture.bundle,
      legacy,
      deps(fakeQueue(), workingMaker),
    );
    assert.equal(legacyState.status, "stale", "an old plan cannot spend after a production override appears");
    assert.match(legacyState.haltReason!, /production look moved \(inherited → overridden\)/);
  });

  it("T-11: cancellation stops future materialisation and marks the record, not the media", async () => {
    const fixture = await open();
    const plan = await create(fixture);
    const queue = fakeQueue();
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue, workingMaker));
    await appendPlanEvents(fixture.store, fixture.production.meta.id, plan.planId, [
      { kind: "cancelled", ts: CLOCK(), planId: plan.planId },
    ]);
    const state = await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue, workingMaker));
    assert.equal(state.status, "cancelled");
    assert.equal(state.passes[1]!.state, "halted");
    assert.equal(queue.jobs.size, 1, "nothing new was spent after the mark");
  });

  it("T-14/T-15/T-19: the fold is replay-proof, ignores the unknown, and equals itself from disk", async () => {
    const fixture = await open();
    const plan = await create(fixture);
    const queue = fakeQueue();
    await advancePlan(fixture.store, fixture.production, fixture.bundle, plan, deps(queue, workingMaker));
    const events = await readPlanEvents(fixture.store, fixture.production.meta.id, plan.planId);
    const facts = queue.facts(
      events.flatMap((event) => (event.kind === "pass-enqueued" ? [event["jobId"] as string] : [])),
    );
    const once = foldPlan(plan, events, facts);
    const replayed = foldPlan(plan, [...events, ...events], facts);
    assert.deepEqual(replayed, once, "an event applied twice changes nothing (T-14)");
    const withUnknown = foldPlan(
      plan,
      [...events, { kind: "a-kind-from-the-future", ts: CLOCK(), planId: plan.planId, passIndex: 0 }],
      facts,
    );
    assert.deepEqual(withUnknown, once, "unknown kinds are preserved on disk and ignored here (T-15)");
    // T-19: a fresh store over the same directory folds to the same state. Close first — one
    // world, one process (SPEC-002's lock), and close is idempotent under the cleanup hook.
    await fixture.store.close();
    const reopened = await WorldStore.open(fixture.dir, { clock: CLOCK });
    closeOnCleanup(() => reopened.close());
    const plans = await listPlans(reopened, fixture.production.meta.id);
    const again = await planState(reopened, plans.find((p) => p.planId === plan.planId)!, deps(queue));
    assert.deepEqual(again, once, "restart is a fold, not a memory (T-19)");
  });

  /*
   * Every shot above is an empty pier: no @mention, so no cast, so no reference — and the plan
   * schema's reference entry is strict, so a field the compiler emits that the record does not
   * admit refuses the WHOLE plan rather than trimming a key. This scene mentions somebody, and
   * dresses her in the production's own look, so the durable record has to admit what the
   * compiler actually produces (codex round 3).
   */
  it("persists a plan for a scene that carries references, look and all", async () => {
    const fixture = await open();
    const scene: Scene = { ...fixture.scene, shots: [shot(1, 6, "@maren-kest at the rail")] };
    const kits = fixture.bundle.referenceKits.map((kit) =>
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
                attachedTo: { kind: "production" as const, productionId: fixture.production.meta.id },
              },
            ],
          }
        : kit,
    );
    const world = { ...fixture.bundle, referenceKits: kits };
    const plan = await createDispatchPlan(fixture.store, {
      worldId: WORLD_ID,
      productionId: fixture.production.meta.id,
      scene,
      plan: planScene(
        {
          world: fixture.bundle.meta,
          productionId: fixture.production.meta.id,
          sheets: fixture.bundle.sheets,
          kits,
          scene,
          selections: {},
          model: CHAINING,
        },
        "whole-scene",
      ),
      model: CHAINING,
      world,
      policy: "review-gated",
      requestId: "01J8E0000000000000000000R9",
      clock: CLOCK,
    });
    const carried = plan.passes.flatMap((pass) => pass.compiled.references);
    assert.ok(carried.length > 0, "the scene really does carry a reference");
    const maren = carried.find((reference) => reference.sheetId === "maren-kest")!;
    assert.equal(maren.subject, "Maren Kest");
    assert.equal(maren.mode, "scoped-look");
    assert.ok(maren.file.includes("council-coat"));

    // And it survives the round trip the reader takes, which is a second strict parse.
    const plans = await listPlans(fixture.store, fixture.production.meta.id);
    const reread = plans.find((candidate) => candidate.planId === plan.planId);
    assert.ok(reread, "a plan the schema refuses is skipped on read, and would vanish silently");
    assert.equal(
      reread!.passes.flatMap((pass) => pass.compiled.references).find((r) => r.sheetId === "maren-kest")!.mode,
      "scoped-look",
    );
  });

  /* Plans outlive the build that wrote them. Requiring the fields an older build never wrote
     would fail the strict parse on read, and `listPlans` skips what it cannot read — so an
     unfinished chain stops being recovered, and the requestId dedup that runs through that same
     listing stops finding the plan, letting a retry author a second one and spend again
     (codex round 4). */
  it("still reads a plan written before the compiled reference carried subject and mode", async () => {
    const fixture = await open();
    const scene: Scene = { ...fixture.scene, shots: [shot(1, 6, "@maren-kest at the rail")] };
    const plan = await createDispatchPlan(fixture.store, {
      worldId: WORLD_ID,
      productionId: fixture.production.meta.id,
      scene,
      plan: planScene(
        {
          world: fixture.bundle.meta,
          productionId: fixture.production.meta.id,
          sheets: fixture.bundle.sheets,
          kits: fixture.bundle.referenceKits,
          scene,
          selections: {},
          model: CHAINING,
        },
        "whole-scene",
      ),
      model: CHAINING,
      world: fixture.bundle,
      policy: "review-gated",
      requestId: "01J8E0000000000000000000R8",
      clock: CLOCK,
    });
    assert.ok(plan.passes.flatMap((pass) => pass.compiled.references).length > 0);

    // Age the aggregate on disk: strip the two fields, exactly as an older build left it.
    const file = join(fixture.dir, "productions", fixture.production.meta.id, "plans", `${plan.planId}.json`);
    const aged = JSON.parse(await readFile(file, "utf8")) as {
      passes: { compiled: { references: Record<string, unknown>[] } }[];
    };
    for (const pass of aged.passes)
      for (const reference of pass.compiled.references) {
        delete reference["subject"];
        delete reference["mode"];
      }
    await writeFile(file, JSON.stringify(aged, null, 2));

    const plans = await listPlans(fixture.store, fixture.production.meta.id);
    assert.ok(
      plans.some((candidate) => candidate.planId === plan.planId),
      "an aggregate an older build wrote is still readable, not silently skipped",
    );
    assert.equal(
      plans.find((candidate) => candidate.planId === plan.planId)!.requestId,
      "01J8E0000000000000000000R8",
      "so the requestId dedup still finds it, and a retry cannot spend twice",
    );
  });

  it("T-20: a world holding plans still scans, and the bundle is unmoved by them", async () => {
    const fixture = await open();
    await create(fixture);
    await fixture.store.close();
    const reopened = await WorldStore.open(fixture.dir, { clock: CLOCK });
    closeOnCleanup(() => reopened.close());
    const bundle = reopened.getBundle();
    assert.ok(bundle.productions.some((p) => p.meta.id === fixture.production.meta.id));
    assert.equal(
      bundle.productions.find((p) => p.meta.id === fixture.production.meta.id)!.scenes.length,
      fixture.production.scenes.length,
      "the plans directory is invisible to the scanner",
    );
  });
});

describe("authorization is serialised with the scene's own writes (SPEC-029 R-39; issue 654)", () => {
  it("a plan priced before a shot deletion lands is refused, and nothing is written", async () => {
    /*
     * The one interleaving the deletion blocker could not see: the delete derives its R-39
     * blockers inside the gate and finds no plan; the plan, priced against the scene as it was,
     * then lands beside the world carrying a pass for the shot the delete just removed.
     *
     * Staged the way the scene-commands suite stages its accept — something else holds the
     * write queue, the deletion commits from inside it, and the plan write queues behind having
     * already read and compiled the scene.
     */
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close());
    const bundle = store.getBundle();
    const production = bundle.productions.find((p) => p.meta.id === "saltlight")!;
    const scene = production.scenes.find((s) => s.id === "sc_04")!;
    const path = "productions/saltlight/scenes/04-the-verse-rises.json";
    const scenePlan = planScene(
      {
        world: bundle.meta,
        productionId: "saltlight",
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: CHAINING,
      },
      "whole-scene",
    );

    let releaseHolder = (): void => {};
    let queued = (): void => {};
    const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
    const planQueued = new Promise<void>((resolve) => (queued = resolve));

    const holding = store.gateOp(async () => {
      await planQueued;
      const raw = await readFile(join(dir, path), "utf8");
      const deleted = deleteShot(SceneRecordSchema.parse(JSON.parse(raw)), {
        shotId: orderedShots(scene).at(-1)!.id,
      });
      await store.commitUnserialised({
        kind: "scene-command",
        source: "delete-shot",
        files: [
          { path, action: "replace", content: `${JSON.stringify(deleted, null, 2)}\n`, baseHash: sha256(raw) },
        ],
      });
      await holderMayFinish;
    });

    // Priced against the scene as read, then queued behind the holder for its write.
    const authorizing = createDispatchPlan(store, {
      worldId: WORLD_ID,
      productionId: "saltlight",
      scene,
      plan: scenePlan,
      model: CHAINING,
      world: bundle,
      policy: "review-gated",
      requestId: "01J8E0000000000000000000R9",
      clock: CLOCK,
    });
    queued();
    releaseHolder();
    await holding;

    await assert.rejects(authorizing, new RegExp(`the scene moved v${scene.version} → v${scene.version + 1}`));
    assert.deepEqual(await listPlans(store, "saltlight"), [], "no plan file appeared for the removed shot");
    const after = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === "sc_04")!;
    assert.equal(after.version, scene.version + 1, "the deletion itself landed");
  });
});
