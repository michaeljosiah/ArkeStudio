import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  newId,
  type Job,
  type ConversationId,
  type ManifestModel,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
  orderedShots,
  computeNeedsYou,
} from "@arke-studio/contracts";
import {
  advanceFrameRun,
  cancelFrameRun,
  dismissFrameRun,
  frameRunState,
  listFrameRuns,
  pauseFrameRun,
  quoteFrameRun,
  recordFrameLandingOutcome,
  readFrameRun,
  resumeFrameRun,
  retryFrameStep,
  retryFrameCell,
  abortFrameRunStart,
  recordBoardSheetFromJob,
  startFrameRun,
  type FrameRunDriverDeps,
} from "../../src/productions/frame-run.js";
import { recordFrameRunOutcome } from "../../src/productions/frame-run-outcome.js";
import { Coordinator } from "../../src/coordinator.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import type { WorldProvider } from "../../src/world-provider.js";
import { ReadModel } from "../../src/read-model.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { acceptTake } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta, WorldOpenError } from "../../src/world/scan.js";
import { discoverConversations } from "../../src/world-chat/discover.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const CLOCK = () => "2026-08-30T12:00:00.000Z";
const IMAGE: ManifestModel = {
  id: "frame-image",
  provider: "fal",
  capability: "image",
  displayName: "Frame Image",
  accepts: { referenceImages: 8, startFrame: false, endFrame: false },
  limits: { storyboardPanels: 6 },
  pricing: { kind: "perImage", microUsdPerImage: 1000, microUsdPerReferenceImage: 10 },
};
const ENUMERATED_IMAGE: ManifestModel = {
  id: "enumerated-frame-image",
  provider: "openai",
  capability: "image",
  displayName: "Enumerated Frame Image",
  accepts: { referenceImages: 8, startFrame: false, endFrame: false },
  limits: { storyboardPanels: 6, aspects: ["16:9"] },
  pricing: { kind: "perMegapixel", microUsdPerMegapixel: 1000 },
};

async function fixture() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  const world = store.getBundle();
  const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
  return { dir, store, world, production, scene };
}

function queue() {
  const jobs = new Map<string, Job>();
  const inputs: EnqueueInput[] = [];
  let sequence = 0;
  const enqueue = async (input: EnqueueInput) => {
    inputs.push(input);
    const id = `jb_${String(++sequence).padStart(26, "0")}`;
    jobs.set(id, {
      id,
      idempotencyKey: String(sequence + 100).padStart(26, "0"),
      worldId: input.worldId,
      ...(input.productionId !== undefined ? { productionId: input.productionId } : {}),
      target: input.target,
      capability: input.capability,
      provider: input.provider,
      model: input.model,
      params: input.params,
      estimatedMicroUsd: input.estimatedMicroUsd,
      status: "queued",
      providerJobId: null,
      attempt: 0,
      ...(input.landing !== undefined ? { landing: input.landing } : {}),
      error: null,
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    });
    return { id };
  };
  const deps: FrameRunDriverDeps = {
    enqueue,
    jobById: (id) => jobs.get(id),
  };
  return {
    jobs,
    inputs,
    deps,
    settle: (id: string, status: Job["status"], failureClass?: Job["failureClass"]) => {
      const job = jobs.get(id)!;
      jobs.set(id, { ...job, status, ...(failureClass !== undefined ? { failureClass } : {}) });
    },
  };
}

async function start(
  value: Awaited<ReturnType<typeof fixture>>,
  mode: "per-shot" | "board",
  scope: "missing" | "all" = "all",
  production: ProductionBundle = value.production,
  world: WorldBundle = value.world,
  model: ManifestModel = IMAGE,
  shotId?: string,
  onQuote?: (quote: Awaited<ReturnType<typeof quoteFrameRun>>) => void,
) {
  const compile = {
    worldId: WORLD_ID,
    productionId: production.meta.id,
    scene: value.scene as SceneRecord,
    production,
    world,
    model,
    mode,
    scope,
    ...(shotId !== undefined ? { shotId } : {}),
    boardCapSec: 30,
    boardPanelCap: 6,
    eligible: true,
    clock: CLOCK,
  };
  const quote = await quoteFrameRun(value.store, {
    requestId: "01J8E0000000000000000000Q1",
    quoteId: "01J8E0000000000000000000Q2",
    worldId: WORLD_ID,
    productionId: production.meta.id,
    sceneId: value.scene.id,
    mode,
    modelId: model.id,
    scope,
    ...(shotId !== undefined ? { shotId } : {}),
    clock: CLOCK,
    compile: () => compile,
  });
  onQuote?.(quote);
  return startFrameRun(value.store, {
    quotedMicroUsd: quote.estimatedMicroUsd!,
    quoteSignature: quote.signature!,
    jobs: () => [],
    consumeQuote: () => quote,
    compile: () => compile,
  });
}

async function finishRun(
  value: Awaited<ReturnType<typeof fixture>>,
  status: "succeeded" | "failed",
) {
  const q = queue();
  const started = await start(value, "per-shot");
  let current = (await advanceFrameRun(value.store, value.production.meta.id, started.id, q.deps))!;
  while (true) {
    const unsettled = current.steps.find((step) => {
      if (step.jobId === null) return false;
      return !["succeeded", "failed", "cancelled"].includes(q.jobs.get(step.jobId)?.status ?? "");
    });
    if (unsettled === undefined) break;
    q.settle(unsettled.jobId!, status, status === "failed" ? "terminal" : undefined);
    current = (await advanceFrameRun(value.store, value.production.meta.id, started.id, q.deps))!;
  }
  return {
    q,
    run: current,
    state: await frameRunState(value.store, value.production.meta.id, current, [...q.jobs.values()]),
  };
}

describe("frame-run coordinator service", () => {
  it("refuses a missing-only run with zero work and writes no record", async () => {
    const f = await fixture();
    const shots = orderedShots(f.scene);
    const artifacts = shots.map((shot, index) => ({
      id: `ar_${String(index + 1).padStart(26, "0")}`,
      kind: "image" as const,
      file: `frame-${index}.png`,
      hash: "sha256:0000000000000000" as const,
      origin: { by: "user" as const },
      links: [shot.id],
      created: CLOCK(),
    }));
    const production = {
      ...f.production,
      selections: Object.fromEntries(
        shots.map((shot, index) => [shot.id, { trimInSec: 0, startFrameArtifactId: artifacts[index]!.id }]),
      ),
    };
    await assert.rejects(() => start(f, "per-shot", "missing", production, { ...f.world, artifacts }), /zero shots/);
    assert.deepEqual(await listFrameRuns(f.store, production.meta.id), []);
  });

  it("quotes the exact aggregate and refuses stale authorization before persistence", async () => {
    const f = await fixture();
    const compile = {
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      scene: f.scene as SceneRecord,
      production: f.production,
      world: f.world,
      model: IMAGE,
      mode: "per-shot" as const,
      scope: "all" as const,
      boardCapSec: 30,
      boardPanelCap: 6,
      eligible: true,
      clock: CLOCK,
    };
    const quote = await quoteFrameRun(f.store, {
      requestId: "01J8E0000000000000000000Q5",
      quoteId: "01J8E0000000000000000000Q6",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      sceneId: f.scene.id,
      mode: "per-shot",
      modelId: IMAGE.id,
      scope: "all",
      clock: CLOCK,
      compile: () => compile,
    });
    assert.equal(quote.estimatedMicroUsd, quote.steps.reduce((sum, step) => sum + step.estimatedMicroUsd, 0));
    assert.equal(quote.includedCount, orderedShots(f.scene).length);
    await assert.rejects(
      () => startFrameRun(f.store, {
        quotedMicroUsd: quote.estimatedMicroUsd!,
        quoteSignature: quote.signature!,
        jobs: () => [],
        consumeQuote: () => quote,
        compile: () => ({ ...compile, scene: { ...compile.scene, version: compile.scene.version + 1 } }),
      }),
      /stale/,
    );
    assert.deepEqual(await listFrameRuns(f.store, f.production.meta.id), []);
  });

  it("quotes the exact references frozen into each step", async () => {
    const f = await fixture();
    let quotedReferences: unknown = null;
    const run = await start(f, "per-shot", "all", f.production, f.world, IMAGE, undefined, (quote) => {
      quotedReferences = quote.steps.map((step) => step.references);
    });
    const frozenReferences = run.steps.map((step) => step.request.references);
    assert.ok(frozenReferences.some((references) => references.length > 0));
    assert.deepEqual(quotedReferences, frozenReferences);
  });

  it("refuses a quote for shot A when start asks for shot B", async () => {
    const f = await fixture();
    const [shotA, shotB] = orderedShots(f.scene);
    assert.ok(shotA && shotB);
    const compile = {
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      scene: f.scene as SceneRecord,
      production: f.production,
      world: f.world,
      model: IMAGE,
      mode: "per-shot" as const,
      scope: "all" as const,
      shotId: shotA.id,
      boardCapSec: 30,
      boardPanelCap: 6,
      eligible: true,
      clock: CLOCK,
    };
    const quote = await quoteFrameRun(f.store, {
      requestId: "01J8E0000000000000000000QB",
      quoteId: "01J8E0000000000000000000QC",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      sceneId: f.scene.id,
      mode: "per-shot",
      modelId: IMAGE.id,
      scope: "all",
      shotId: shotA.id,
      clock: CLOCK,
      compile: () => compile,
    });

    await assert.rejects(
      () => startFrameRun(f.store, {
        quotedMicroUsd: quote.estimatedMicroUsd!,
        quoteSignature: quote.signature!,
        jobs: () => [],
        consumeQuote: () => quote,
        compile: () => ({ ...compile, shotId: shotB.id }),
      }),
      /options do not match the quote/,
    );
    assert.deepEqual(await listFrameRuns(f.store, f.production.meta.id), []);
  });

  it("serializes start behind a scene write and recompiles the fresh bundle before persistence", async () => {
    const f = await fixture();
    const compile = () => {
      const world = f.store.getBundle();
      const production = world.productions.find((candidate) => candidate.meta.id === f.production.meta.id)!;
      const scene = production.scenes.find((candidate) => candidate.id === f.scene.id)!;
      return {
        worldId: WORLD_ID,
        productionId: production.meta.id,
        scene,
        production,
        world,
        model: IMAGE,
        mode: "per-shot" as const,
        scope: "all" as const,
        boardCapSec: 30,
        boardPanelCap: 6,
        eligible: true,
        clock: CLOCK,
      };
    };
    const quote = await quoteFrameRun(f.store, {
      requestId: "01J8E0000000000000000000Q7",
      quoteId: "01J8E0000000000000000000Q8",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      sceneId: f.scene.id,
      mode: "per-shot",
      modelId: IMAGE.id,
      scope: "all",
      clock: CLOCK,
      compile,
    });
    let release!: () => void;
    let held!: () => void;
    const entered = new Promise<void>((resolve) => { held = resolve; });
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const write = f.store.gateOp(async () => {
      held();
      await blocker;
      const path = join(f.dir, "productions", f.production.meta.id, "scenes", "04-the-verse-rises.json");
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      raw["version"] = Number(raw["version"]) + 1;
      const shots = raw["shots"] as Array<Record<string, unknown>>;
      shots[0]!["description"] = "changed while authorization waited";
      await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
    });
    await entered;
    const start = startFrameRun(f.store, {
      quotedMicroUsd: quote.estimatedMicroUsd!,
      quoteSignature: quote.signature!,
      jobs: () => [],
      consumeQuote: () => quote,
      compile,
    });
    release();
    await write;
    await assert.rejects(start, /stale/);
    assert.deepEqual(await listFrameRuns(f.store, f.production.meta.id), []);
  });

  it("serializes active-run admission so concurrent starts create only one record", async () => {
    const f = await fixture();
    const compile = {
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      scene: f.scene as SceneRecord,
      production: f.production,
      world: f.world,
      model: IMAGE,
      mode: "per-shot" as const,
      scope: "all" as const,
      boardCapSec: 30,
      boardPanelCap: 6,
      eligible: true,
      clock: CLOCK,
    };
    const quote = await quoteFrameRun(f.store, {
      requestId: "01J8E0000000000000000000Q9",
      quoteId: "01J8E0000000000000000000QA",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      sceneId: f.scene.id,
      mode: "per-shot",
      modelId: IMAGE.id,
      scope: "all",
      clock: CLOCK,
      compile: () => compile,
    });
    const input = () => ({
      quotedMicroUsd: quote.estimatedMicroUsd!,
      quoteSignature: quote.signature!,
      jobs: () => [] as Job[],
      consumeQuote: () => quote,
      compile: () => compile,
    });
    const settled = await Promise.allSettled([startFrameRun(f.store, input()), startFrameRun(f.store, input())]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await listFrameRuns(f.store, f.production.meta.id)).length, 1);
  });

  it("removes an unqueued provisional start after first-step admission fails", async () => {
    const f = await fixture();
    const run = await start(f, "per-shot");
    const removed = await abortFrameRunStart(f.store, f.production.meta.id, run.id, () => []);
    assert.equal(removed, null);
    assert.equal(await readFrameRun(f.store, f.production.meta.id, run.id), null);
  });

  it("persists frozen per-shot steps and enqueues exactly one image job per shot, stepwise", async () => {
    const f = await fixture();
    const run = await start(f, "per-shot");
    const q = queue();
    await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps);
    assert.equal(q.inputs.length, 1);
    assert.deepEqual(q.inputs[0]!.target, { kind: "shot", id: "sh_12", coversShots: ["sh_12"] });
    assert.equal(q.inputs[0]!.capability, "image");
    assert.match(q.inputs[0]!.idempotencyKey!, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(q.inputs[0]!.params["landing"], "frame-slot");
    assert.deepEqual((q.inputs[0]!.params["request"] as { slotAtAuthorization: unknown }).slotAtAuthorization, { sh_12: null });
    const first = (await readFrameRun(f.store, f.production.meta.id, run.id))!;
    assert.deepEqual(q.inputs[0]!, {
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      target: first.steps[0]!.dispatch.target,
      capability: first.steps[0]!.dispatch.capability,
      provider: first.steps[0]!.dispatch.provider,
      model: first.steps[0]!.dispatch.model,
      params: first.steps[0]!.dispatch.params,
      estimatedMicroUsd: first.steps[0]!.dispatch.estimatedMicroUsd,
      landing: first.steps[0]!.dispatch.landing,
      idempotencyKey: first.steps[0]!.dispatch.idempotencyKey,
    }, "enqueue is a direct mapping of durable facts");
    assert.equal(first.cursor, 1);
    assert.equal(first.steps[0]!.jobId, q.jobs.keys().next().value);
    assert.equal(first.steps[1]!.jobId, null);
    const raw = JSON.parse(await readFile(join(f.dir, "productions", f.production.meta.id, "runs", `${run.id}.json`), "utf8"));
    assert.deepEqual(raw.steps, first.steps);
    q.settle(first.steps[0]!.jobId!, "succeeded");
    await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps);
    assert.equal(q.inputs.length, 2, "one terminal wakeup enqueues one next shot");
  });

  it("continues to the next step when local finalization fails", async () => {
    const f = await fixture();
    const run = await start(f, "per-shot");
    const q = queue();
    const current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const firstJobId = current.steps[0]!.jobId!;
    const firstJob = q.jobs.get(firstJobId)!;
    q.jobs.set(firstJobId, {
      ...firstJob,
      status: "succeeded",
      finalization: { status: "failed", error: "the frame could not be prepared", updatedAt: CLOCK() },
    });

    const advanced = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    assert.equal(q.inputs.length, 2, "a local failure does not strand the remaining authorized spend");
    assert.ok(advanced.steps[1]!.jobId);
    const state = await frameRunState(f.store, f.production.meta.id, advanced, [...q.jobs.values()]);
    assert.equal(state.steps[0]!.status, "failed");
    assert.equal(state.steps[0]!.error, "the frame could not be prepared");
    assert.equal(state.steps[0]!.canRetry, false);
  });

  it("quotes and persists a targeted one-shot run, and refuses a shot outside the scene", async () => {
    const f = await fixture();
    const shot = orderedShots(f.scene)[1]!;
    let quote: Awaited<ReturnType<typeof quoteFrameRun>> | undefined;
    const run = await start(
      f,
      "per-shot",
      "all",
      f.production,
      f.world,
      IMAGE,
      shot.id,
      (value) => { quote = value; },
    );

    assert.ok(quote);
    assert.equal(quote.shotId, shot.id);
    assert.equal(quote.includedCount, 1);
    assert.equal(quote.steps.length, 1);
    assert.deepEqual(quote.steps[0]!.requestShotIds, [shot.id]);
    assert.deepEqual(quote.steps[0]!.updateShotIds, [shot.id]);

    const persisted = await listFrameRuns(f.store, f.production.meta.id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.id, run.id);
    assert.equal(persisted[0]!.mode, "per-shot");
    assert.equal(persisted[0]!.steps.length, 1);
    assert.deepEqual(persisted[0]!.steps[0]!.requestShotIds, [shot.id]);
    assert.deepEqual(persisted[0]!.steps[0]!.updateShotIds, [shot.id]);
    assert.deepEqual(persisted[0]!.steps[0]!.dispatch.target, {
      kind: "shot",
      id: shot.id,
      coversShots: [shot.id],
    });

    const outside = await fixture();
    await assert.rejects(
      () => start(
        outside,
        "per-shot",
        "all",
        outside.production,
        outside.world,
        IMAGE,
        "sh_999",
      ),
      /shot sh_999 is not in this scene/,
    );
    assert.deepEqual(await listFrameRuns(outside.store, outside.production.meta.id), []);
  });

  it("board mode enqueues one sheet for all members and freezes fixed/update roles", async () => {
    const f = await fixture();
    const shots = orderedShots(f.scene);
    const framed = shots[1]!;
    const artifact = {
      id: "ar_00000000000000000000000001",
      kind: "image" as const,
      file: "fixed.png",
      hash: "sha256:0000000000000000" as const,
      origin: { by: "user" as const },
      links: [framed.id],
      created: CLOCK(),
    };
    const production = {
      ...f.production,
      selections: { ...f.production.selections, [framed.id]: { trimInSec: 0, startFrameArtifactId: artifact.id } },
    };
    const run = await start(f, "board", "missing", production, { ...f.world, artifacts: [...f.world.artifacts, artifact] });
    assert.equal(run.steps.length, 1);
    const layout = run.steps[0]!.request.layout!;
    assert.equal(layout.columns, 2);
    assert.equal(layout.rows, 2);
    assert.equal(layout.canvasWidth, run.steps[0]!.dispatch.output.width);
    assert.equal(layout.canvasHeight, run.steps[0]!.dispatch.output.height);
    assert.equal(layout.regions.length, 4);
    assert.ok(layout.regions.every((region) => region.width * 9 === region.height * 16));
    assert.equal(run.steps[0]!.dispatch.output.aspect, "16:9", "the route-valid canvas aspect is unchanged");
    assert.deepEqual(run.steps[0]!.dispatch.routeOutput, { width: 1536, height: 864, aspect: "16:9" });
    assert.notDeepEqual(run.steps[0]!.dispatch.cellOutput, run.steps[0]!.dispatch.routeOutput, "crop geometry is not a provider output");
    assert.ok(layout.regions.some((region) => region.x > 0 || region.y > 0), "blank canvas margins are explicit");
    assert.deepEqual(run.steps[0]!.requestShotIds, shots.map((shot) => shot.id));
    assert.deepEqual(run.steps[0]!.updateShotIds, shots.filter((shot) => shot.id !== framed.id).map((shot) => shot.id));
    assert.deepEqual(run.steps[0]!.request.panels[1], {
      panel: 2,
      shotId: framed.id,
      role: "fixed",
      fixedImage: { source: "artifact", id: artifact.id, path: "artifacts/fixed.png" },
    });
    const q = queue();
    await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps);
    assert.equal(q.inputs.length, 1);
    assert.deepEqual(q.inputs[0]!.target, { kind: "board-sheet", coversShots: shots.map((shot) => shot.id) });
    assert.deepEqual((q.inputs[0]!.params["request"] as { panels: unknown }).panels, run.steps[0]!.request.panels);
    assert.ok((q.inputs[0]!.params["references"] as string[]).includes("artifacts/fixed.png"));
  });

  it("uses a singular fixed-frame reference in a blocked board quote", async () => {
    const f = await fixture();
    const framed = orderedShots(f.scene)[1]!;
    const artifact = {
      id: "ar_00000000000000000000000001",
      kind: "image" as const,
      file: "fixed.png",
      hash: "sha256:0000000000000000" as const,
      origin: { by: "user" as const },
      links: [framed.id],
      created: CLOCK(),
    };
    const production = {
      ...f.production,
      selections: { ...f.production.selections, [framed.id]: { trimInSec: 0, startFrameArtifactId: artifact.id } },
    };
    const model = { ...IMAGE, accepts: { ...IMAGE.accepts, referenceImages: 0 } };
    const quote = await quoteFrameRun(f.store, {
      requestId: "01J8E0000000000000000000QD",
      quoteId: "01J8E0000000000000000000QE",
      worldId: WORLD_ID,
      productionId: production.meta.id,
      sceneId: f.scene.id,
      mode: "board",
      modelId: model.id,
      scope: "missing",
      clock: CLOCK,
      compile: () => ({
        worldId: WORLD_ID,
        productionId: production.meta.id,
        scene: f.scene,
        production,
        world: { ...f.world, artifacts: [...f.world.artifacts, artifact] },
        model,
        mode: "board",
        scope: "missing",
        boardCapSec: 30,
        boardPanelCap: 6,
        eligible: true,
        clock: CLOCK,
      }),
    });

    assert.equal(quote.blockedReason, "board A needs 1 fixed frame reference, but Frame Image accepts 0");
  });

  it("uses three columns beyond four panels and preserves each child's production aspect", async () => {
    const f = await fixture();
    const shots = orderedShots(f.scene);
    const scene: SceneRecord = {
      ...f.scene,
      shots: [
        ...shots,
        { id: "sh_16", number: 16, title: "Five", description: "Fifth panel", durationSec: 4 },
      ],
    } as SceneRecord;
    const compile = {
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      scene,
      production: f.production,
      world: f.world,
      model: IMAGE,
      mode: "board" as const,
      scope: "all" as const,
      boardCapSec: 60,
      boardPanelCap: 6,
      eligible: true,
      clock: CLOCK,
    };
    const quote = await quoteFrameRun(f.store, {
      requestId: "01J8E0000000000000000000Q3",
      quoteId: "01J8E0000000000000000000Q4",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      sceneId: scene.id,
      mode: "board",
      modelId: IMAGE.id,
      scope: "all",
      clock: CLOCK,
      compile: () => compile,
    });
    const run = await startFrameRun(f.store, {
      quotedMicroUsd: quote.estimatedMicroUsd!,
      quoteSignature: quote.signature!,
      jobs: () => [],
      consumeQuote: () => quote,
      compile: () => compile,
    });
    const step = run.steps[0]!;
    assert.equal(step.request.layout?.columns, 3);
    assert.equal(step.request.layout?.rows, 2);
    assert.equal(step.request.layout?.canvasWidth, step.dispatch.output.width);
    assert.equal(step.request.layout?.canvasHeight, step.dispatch.output.height);
    assert.ok(step.request.layout!.regions.every((region) => region.width * 9 === region.height * 16));
    assert.deepEqual(step.dispatch.routeOutput, { width: 1536, height: 864, aspect: "16:9" });
    assert.equal(step.dispatch.cellOutput.aspect, "16:9");
  });

  it("freezes an enumerated provider size for cell retry and prices that size", async () => {
    const f = await fixture();
    const run = await start(f, "board", "all", f.production, f.world, ENUMERATED_IMAGE);
    const step = run.steps[0]!;
    const accepted = [
      { width: 1024, height: 1024 },
      { width: 1536, height: 1024 },
      { width: 1024, height: 1536 },
    ];
    assert.ok(accepted.some((size) => size.width === step.dispatch.routeOutput.width && size.height === step.dispatch.routeOutput.height));
    assert.notDeepEqual(step.dispatch.routeOutput, step.dispatch.cellOutput);
    assert.equal(
      step.dispatch.cellEstimatedMicroUsd,
      Math.ceil((step.dispatch.routeOutput.width * step.dispatch.routeOutput.height) / 1000),
      "the retry quote uses route output megapixels, not crop area",
    );

    const q = queue();
    const attempted = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const sourceJobId = attempted.steps[0]!.jobId!;
    q.settle(sourceJobId, "succeeded");
    const parentId = "tk_01J8E0000000000000000000PE";
    const parentDir = join(f.dir, "productions", f.production.meta.id, "takes", parentId);
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, "board.png"), encodePng(solidImage(16, 9, [1, 2, 3, 255])));
    const parent = {
      id: parentId,
      jobId: sourceJobId,
      boardSheetParent: true as const,
      coversShots: step.requestShotIds,
      kind: "frame" as const,
      provider: ENUMERATED_IMAGE.provider,
      model: ENUMERATED_IMAGE.id,
      provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: step.dispatch.estimatedMicroUsd, actualMicroUsd: null },
      dispatchedAt: CLOCK(),
      media: "board.png",
    };
    const production = { ...f.production, takes: [...f.production.takes, parent] };
    const retried = (await retryFrameCell(
      f.store,
      f.production.meta.id,
      run.id,
      0,
      step.updateShotIds[0]!,
      () => production,
      q.deps.jobById,
    ))!.steps.at(-1)!;
    assert.deepEqual(retried.dispatch.output, step.dispatch.routeOutput);
    assert.deepEqual(retried.dispatch.params["output"], step.dispatch.routeOutput);
    assert.equal(retried.dispatch.estimatedMicroUsd, step.dispatch.cellEstimatedMicroUsd);
  });

  it("preserves the board parent and extracts only update panels as deterministic child takes", async () => {
    const f = await fixture();
    const shots = orderedShots(f.scene);
    const request = {
      prompt: "One board",
      panels: [
        { panel: 1, shotId: shots[0]!.id, role: "update" as const },
        {
          panel: 2,
          shotId: shots[1]!.id,
          role: "fixed" as const,
          fixedImage: { source: "artifact" as const, id: "ar_00000000000000000000000001", path: "artifacts/fixed.png" },
        },
        { panel: 3, shotId: shots[2]!.id, role: "update" as const },
        { panel: 4, shotId: shots[3]!.id, role: "update" as const },
      ],
      references: [],
      provenance: {
        canonRevision: f.world.meta.canonRevision,
        artDirectionVersion: f.world.artDirection.version,
      },
      droppedReferences: [],
      layout: {
        columns: 2 as const,
        rows: 2,
        canvasWidth: 32,
        canvasHeight: 18,
        regions: [
          { panel: 1, x: 0, y: 0, width: 16, height: 9 },
          { panel: 2, x: 16, y: 0, width: 16, height: 9 },
          { panel: 3, x: 0, y: 9, width: 16, height: 9 },
          { panel: 4, x: 16, y: 9, width: 16, height: 9 },
        ],
      },
      aspect: "16:9",
      slotAtAuthorization: { [shots[0]!.id]: null, [shots[2]!.id]: null, [shots[3]!.id]: null },
    };
    const incoming = `productions/${f.production.meta.id}/incoming/board.jpg`;
    await mkdir(join(f.dir, "productions", f.production.meta.id, "incoming"), { recursive: true });
    await writeFile(join(f.dir, incoming), Buffer.from("immutable-provider-parent"));
    const job: Job = {
      id: "jb_00000000000000000000000001",
      idempotencyKey: "00000000000000000000000002",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      target: { kind: "board-sheet", coversShots: shots.map((shot) => shot.id) },
      capability: "image",
      provider: IMAGE.provider,
      model: IMAGE.id,
      params: {
        prompt: request.prompt,
        references: [],
        provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
        landing: "frame-slot",
        request,
      },
      estimatedMicroUsd: 999,
      status: "succeeded",
      providerJobId: "remote-board",
      attempt: 1,
      landedFiles: [incoming],
      finalization: { status: "pending", error: null, updatedAt: CLOCK() },
      error: null,
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    };
    const converter = {
      write: async (_input: string, output: string) => {
        await writeFile(output, encodePng(solidImage(32, 18, [40, 80, 120, 255])));
        return { ok: true as const };
      },
    };
    const takes = await recordBoardSheetFromJob(f.store, f.production, job, 900, "provider-reported", converter);
    assert.equal(takes.length, 4, "one parent plus three update children; the fixed panel lands nothing");
    const [parent, ...children] = takes;
    assert.deepEqual(parent!.coversShots, shots.map((shot) => shot.id));
    assert.equal(parent!.boardSheetParent, true);
    assert.equal(parent!.panel, undefined);
    assert.ok(children.every((take) => take.boardSheetParent === undefined));
    assert.deepEqual(children.map((take) => take.coversShots[0]), [shots[0]!.id, shots[2]!.id, shots[3]!.id]);
    assert.deepEqual(children.map((take) => take.panel?.index), [1, 3, 4]);
    assert.ok(children.every((take) => take.panel?.parentTakeId === parent!.id));
    assert.ok(children.every((take) => take.panel?.parentHash !== take.panel?.cropSourceHash));
    assert.ok(children.every((take) => take.panel?.crop.width === 16 && take.panel.crop.height === 9));
    assert.equal(children.reduce((sum, take) => sum + take.cost.estimatedMicroUsd, 0), 999);
    assert.equal(children.reduce((sum, take) => sum + (take.cost.actualMicroUsd ?? 0), 0), 900);
    const bundle = f.store.getBundle();
    const production = bundle.productions.find((candidate) => candidate.meta.id === f.production.meta.id)!;
    assert.ok(production.reviews.some((review) => review.takeId === parent!.id && review.decision === "accept"));
    const state = new ReadModel("test");
    state.setWorld(bundle);
    assert.ok(
      !computeNeedsYou(state.getState()).some((entry) => entry.kind === "unreviewed-take" && entry.ref === parent!.id),
      "the accepted board parent never appears as an ordinary unreviewed take",
    );
    assert.equal(production.selections[shots[1]!.id]?.startFrameArtifactId, undefined, "fixed panel is untouched");
    for (const shot of [shots[0]!, shots[2]!, shots[3]!]) {
      assert.match(production.selections[shot.id]!.startFrameArtifactId!, /^ar_/);
    }
    const replayed = await recordBoardSheetFromJob(f.store, production, job, 900, "provider-reported", converter);
    assert.equal(replayed.length, 4);
    assert.equal(
      replayed.slice(1).reduce((sum, take) => sum + take.cost.estimatedMicroUsd, 0),
      999,
      "existing children remain in the allocation on replay",
    );
  });

  it("serializes an ordinary take review with a board parent review", async () => {
    const f = await fixture();
    const boardShot = orderedShots(f.scene)[2]!;
    const request = {
      prompt: "One mixed-writer board",
      panels: [{ panel: 1, shotId: boardShot.id, role: "update" as const }],
      references: [],
      provenance: {
        canonRevision: f.world.meta.canonRevision,
        artDirectionVersion: f.world.artDirection.version,
      },
      droppedReferences: [],
      layout: {
        columns: 2 as const,
        rows: 1,
        canvasWidth: 16,
        canvasHeight: 9,
        regions: [{ panel: 1, x: 0, y: 0, width: 16, height: 9 }],
      },
      aspect: "16:9",
      slotAtAuthorization: { [boardShot.id]: null },
    };
    const incoming = `productions/${f.production.meta.id}/incoming/mixed-board.jpg`;
    await mkdir(join(f.dir, "productions", f.production.meta.id, "incoming"), { recursive: true });
    await writeFile(join(f.dir, incoming), Buffer.from("immutable-mixed-writer-parent"));
    const job: Job = {
      id: "jb_00000000000000000000000011",
      idempotencyKey: "00000000000000000000000012",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      target: { kind: "board-sheet", coversShots: [boardShot.id] },
      capability: "image",
      provider: IMAGE.provider,
      model: IMAGE.id,
      params: {
        prompt: request.prompt,
        references: [],
        provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
        landing: "frame-slot",
        request,
      },
      estimatedMicroUsd: 1000,
      status: "succeeded",
      providerJobId: "remote-mixed-board",
      attempt: 1,
      landedFiles: [incoming],
      finalization: { status: "pending", error: null, updatedAt: CLOCK() },
      error: null,
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    };
    const converter = {
      write: async (_input: string, output: string) => {
        await writeFile(output, encodePng(solidImage(16, 9, [40, 80, 120, 255])));
        return { ok: true as const };
      },
    };
    const [parent] = await recordTakesFromJob(f.store, job, 900);
    assert.ok(parent, "the parent is durable before its replayed finalization records the review");

    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const inside = new Promise<void>((resolve) => { holderEntered = resolve; });
    const gateOp = f.store.gateOp.bind(f.store);
    const commit = f.store.commit.bind(f.store);
    const holder = gateOp(async () => {
      holderEntered();
      await held;
    });
    await inside;

    let queued = 0;
    let bothQueued!: () => void;
    const queuedTogether = new Promise<void>((resolve) => { bothQueued = resolve; });
    const noteQueued = (): void => {
      queued += 1;
      if (queued === 2) bothQueued();
    };
    f.store.gateOp = <T>(operation: () => Promise<T>): Promise<T> => {
      noteQueued();
      return gateOp(operation);
    };
    f.store.commit = (input, hooks) => {
      noteQueued();
      return commit(input, hooks);
    };

    const current = f.store.getBundle().productions.find((candidate) => candidate.meta.id === f.production.meta.id)!;
    const ordinaryTakeId = "tk_01J8D0000000000000000000D4";
    const writes = Promise.all([
      acceptTake(f.store, current, { takeId: ordinaryTakeId, shotId: "sh_13", by: "user" }),
      recordBoardSheetFromJob(f.store, current, job, 900, "provider-reported", converter),
    ]);
    await queuedTogether;
    releaseHolder();
    await Promise.all([holder, writes]);

    const reviews = (await readFile(join(f.dir, "productions", f.production.meta.id, "reviews.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { takeId: string });
    assert.ok(reviews.some((review) => review.takeId === ordinaryTakeId), "the ordinary review remains");
    assert.ok(reviews.some((review) => review.takeId === parent.id), "the board parent review remains");
  });

  it("pauses terminal advancement, resumes it, cancels live work, and appends retries", async () => {
    const f = await fixture();
    const run = await start(f, "per-shot");
    const q = queue();
    let current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const firstJob = current.steps[0]!.jobId!;
    await pauseFrameRun(f.store, f.production.meta.id, run.id);
    q.settle(firstJob, "succeeded");
    await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps);
    assert.equal(q.inputs.length, 1);
    await resumeFrameRun(f.store, f.production.meta.id, run.id);
    current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    assert.equal(q.inputs.length, 2);
    const cancelled: string[] = [];
    await cancelFrameRun(f.store, f.production.meta.id, run.id, {
      jobById: q.deps.jobById,
      cancel: async (id) => { cancelled.push(id); q.settle(id, "cancelled"); },
    });
    assert.deepEqual(cancelled, [current.steps[1]!.jobId]);
    assert.equal((await readFrameRun(f.store, f.production.meta.id, run.id))!.cancelled, true);

    const retryRun = await start(f, "per-shot");
    const retryQueue = queue();
    const attempted = (await advanceFrameRun(f.store, f.production.meta.id, retryRun.id, retryQueue.deps))!;
    retryQueue.settle(attempted.steps[0]!.jobId!, "failed", "transient");
    await pauseFrameRun(f.store, f.production.meta.id, retryRun.id);
    const retried = (await retryFrameStep(
      f.store,
      f.production.meta.id,
      retryRun.id,
      0,
      () => f.production,
      retryQueue.deps.jobById,
    ))!;
    assert.equal(retried.steps.length, retryRun.steps.length + 1);
    assert.equal(retried.steps.at(-1)!.jobId, null);
    assert.equal(retried.steps.at(-1)!.retryOf, 0);
    assert.equal(retried.steps.at(-1)!.sourceStepIndex, 0);
    assert.equal(retried.paused, false, "the Retry press resumes a settled paused run so its appended step can enqueue");
    await assert.rejects(
      () => retryFrameStep(f.store, f.production.meta.id, retryRun.id, 0, () => f.production, retryQueue.deps.jobById),
      /already has a newer retry attempt/,
    );
    retryQueue.settle(attempted.steps[0]!.jobId!, "failed", "terminal");
    await assert.rejects(
      () => retryFrameStep(f.store, f.production.meta.id, retryRun.id, 0, () => f.production, retryQueue.deps.jobById),
      /terminal failure/,
    );
  });

  it("allows independent board-cell retries and reserves the parent reference first", async () => {
    const f = await fixture();
    const run = await start(f, "board");
    const q = queue();
    const attempted = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const sourceJobId = attempted.steps[0]!.jobId!;
    q.settle(sourceJobId, "succeeded");
    const parentId = "tk_01J8E0000000000000000000P1";
    const parentDir = join(f.dir, "productions", f.production.meta.id, "takes", parentId);
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, "board.png"), encodePng(solidImage(16, 9, [1, 2, 3, 255])));
    const parent = {
      id: parentId,
      jobId: sourceJobId,
      boardSheetParent: true as const,
      coversShots: attempted.steps[0]!.requestShotIds,
      kind: "frame" as const,
      provider: IMAGE.provider,
      model: IMAGE.id,
      provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
      dispatchedAt: CLOCK(),
      media: "board.png",
    };
    const production = { ...f.production, takes: [...f.production.takes, parent] };
    const shotIds = attempted.steps[0]!.updateShotIds;
    const first = (await retryFrameCell(f.store, f.production.meta.id, run.id, 0, shotIds[0]!, () => production, q.deps.jobById))!;
    const firstRetry = first.steps.at(-1)!;
    assert.equal(firstRetry.grain, "cell-retry");
    assert.deepEqual(firstRetry.dispatch.output, attempted.steps[0]!.dispatch.routeOutput, "retry uses a supported single-image output");
    assert.notDeepEqual(firstRetry.dispatch.output, attempted.steps[0]!.dispatch.cellOutput, "retry never submits crop dimensions");
    assert.equal(firstRetry.dispatch.references.at(-1), `productions/${f.production.meta.id}/takes/${parentId}/board.png`);
    assert.ok(firstRetry.dispatch.references.length <= firstRetry.dispatch.referenceCapacity);
    const second = (await retryFrameCell(f.store, f.production.meta.id, run.id, 0, shotIds[1]!, () => production, q.deps.jobById))!;
    assert.equal(second.steps.at(-1)!.updateShotIds[0], shotIds[1], "another cell remains independently retryable");
    const cellJobIds = ["jb_01J8E0000000000000000000C1", "jb_01J8E0000000000000000000C2"];
    const withSettledCells = {
      ...second,
      steps: second.steps.map((step, index) => index === 1 || index === 2 ? { ...step, jobId: cellJobIds[index - 1]! } : step),
    };
    await writeFile(
      join(f.dir, "productions", f.production.meta.id, "runs", `${run.id}.json`),
      JSON.stringify(withSettledCells, null, 2) + "\n",
    );
    for (const [index, jobId] of cellJobIds.entries()) {
      q.jobs.set(jobId, {
        ...q.jobs.get(sourceJobId)!,
        id: jobId,
        status: "succeeded",
        target: withSettledCells.steps[index + 1]!.dispatch.target,
      });
    }
    await assert.rejects(
      () => retryFrameCell(f.store, f.production.meta.id, run.id, 0, shotIds[0]!, () => production, q.deps.jobById),
      /newer retry attempt/,
    );
    const wholeRetry = (await retryFrameStep(f.store, f.production.meta.id, run.id, 0, () => production, q.deps.jobById))!;
    assert.equal(wholeRetry.steps.at(-1)!.grain, "step-retry", "settled cell retries do not prevent a later whole-board pass");
    await cancelFrameRun(f.store, f.production.meta.id, run.id, { jobById: q.deps.jobById, cancel: async () => {} });

    const zeroRun = {
      ...attempted,
      id: "fr_01J8E0000000000000000000Z1",
      steps: attempted.steps.map((step) => ({
        ...step,
        dispatch: { ...step.dispatch, referenceCapacity: 0, references: [] },
        request: { ...step.request, references: [], droppedReferences: [] },
      })),
    };
    zeroRun.steps[0]!.dispatch.params = {
      ...zeroRun.steps[0]!.dispatch.params,
      references: [],
      request: zeroRun.steps[0]!.request,
    };
    await writeFile(
      join(f.dir, "productions", f.production.meta.id, "runs", `${zeroRun.id}.json`),
      JSON.stringify(zeroRun, null, 2) + "\n",
    );
    await assert.rejects(
      () => retryFrameCell(f.store, f.production.meta.id, zeroRun.id, 0, shotIds[0]!, () => production, q.deps.jobById),
      /accepts no image references/,
    );
  });

  it("refuses a retained-run retry while another run owns the scene", async () => {
    const f = await fixture();
    const active = await start(f, "board");
    const q = queue();
    const activeRun = (await advanceFrameRun(f.store, f.production.meta.id, active.id, q.deps))!;
    const retainedJobId = "jb_01J8E0000000000000000000RT";
    const retained = {
      ...activeRun,
      id: "fr_01J8E0000000000000000000RT",
      dismissed: true as const,
      steps: activeRun.steps.map((step) => ({ ...step, jobId: retainedJobId })),
    };
    q.jobs.set(retainedJobId, { ...q.jobs.get(activeRun.steps[0]!.jobId!)!, id: retainedJobId, status: "succeeded" });
    await writeFile(
      join(f.dir, "productions", f.production.meta.id, "runs", `${retained.id}.json`),
      JSON.stringify(retained, null, 2) + "\n",
    );
    await assert.rejects(
      () => retryFrameStep(f.store, f.production.meta.id, retained.id, 0, () => f.production, q.deps.jobById),
      /scene already has an active frame run/,
    );
    assert.equal((await readFrameRun(f.store, f.production.meta.id, retained.id))!.dismissed, true);
  });

  it("refuses a stale board ancestor after its newest retry is terminal", async () => {
    const f = await fixture();
    const run = await start(f, "board");
    const q = queue();
    let current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    q.settle(current.steps[0]!.jobId!, "succeeded");
    current = (await retryFrameStep(f.store, f.production.meta.id, run.id, 0, () => f.production, q.deps.jobById))!;
    current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    q.settle(current.steps[1]!.jobId!, "failed", "terminal");
    await assert.rejects(
      () => retryFrameStep(f.store, f.production.meta.id, run.id, 0, () => f.production, q.deps.jobById),
      /already has a newer retry attempt/,
    );
    await assert.rejects(
      () => retryFrameStep(f.store, f.production.meta.id, run.id, 1, () => f.production, q.deps.jobById),
      /terminal failure/,
    );
  });

  it("refuses a stale cell ancestor after its newest retry is terminal", async () => {
    const f = await fixture();
    const run = await start(f, "board");
    const q = queue();
    const attempted = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const sourceJobId = attempted.steps[0]!.jobId!;
    q.settle(sourceJobId, "succeeded");
    const parentId = "tk_01J8E0000000000000000000CT";
    const parentDir = join(f.dir, "productions", f.production.meta.id, "takes", parentId);
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, "board.png"), encodePng(solidImage(16, 9, [1, 2, 3, 255])));
    const production = {
      ...f.production,
      takes: [...f.production.takes, {
        id: parentId,
        jobId: sourceJobId,
        boardSheetParent: true as const,
        coversShots: attempted.steps[0]!.requestShotIds,
        kind: "frame" as const,
        provider: IMAGE.provider,
        model: IMAGE.id,
        provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
        references: [],
        params: {},
        cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
        dispatchedAt: CLOCK(),
        media: "board.png",
      }],
    };
    let current = (await retryFrameCell(
      f.store,
      f.production.meta.id,
      run.id,
      0,
      attempted.steps[0]!.updateShotIds[0]!,
      () => production,
      q.deps.jobById,
    ))!;
    current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    q.settle(current.steps[1]!.jobId!, "failed", "terminal");
    await assert.rejects(
      () => retryFrameCell(
        f.store,
        f.production.meta.id,
        run.id,
        0,
        attempted.steps[0]!.updateShotIds[0]!,
        () => production,
        q.deps.jobById,
      ),
      /already has a newer retry attempt/,
    );
    await assert.rejects(
      () => retryFrameCell(
        f.store,
        f.production.meta.id,
        run.id,
        1,
        attempted.steps[0]!.updateShotIds[0]!,
        () => production,
        q.deps.jobById,
      ),
      /terminal failure/,
    );
  });

  it("requires the immutable parent before retrying a fixed board cell", async () => {
    const f = await fixture();
    const shots = orderedShots(f.scene);
    const framed = shots[1]!;
    const artifact = {
      id: "ar_00000000000000000000000011",
      kind: "image" as const,
      file: "fixed-retry.png",
      hash: "sha256:0000000000000011" as const,
      origin: { by: "user" as const },
      links: [framed.id],
      created: CLOCK(),
    };
    const production = {
      ...f.production,
      selections: { ...f.production.selections, [framed.id]: { trimInSec: 0, startFrameArtifactId: artifact.id } },
    };
    const run = await start(f, "board", "missing", production, { ...f.world, artifacts: [...f.world.artifacts, artifact] });
    const q = queue();
    const attempted = (await advanceFrameRun(f.store, production.meta.id, run.id, q.deps))!;
    q.settle(attempted.steps[0]!.jobId!, "succeeded");
    const before = await readFile(join(f.dir, "productions", production.meta.id, "runs", `${run.id}.json`), "utf8");
    await assert.rejects(
      () => retryFrameCell(f.store, production.meta.id, run.id, 0, framed.id, () => production, q.deps.jobById),
      /board sheet for this cell is unavailable/,
    );
    const after = await readFile(join(f.dir, "productions", production.meta.id, "runs", `${run.id}.json`), "utf8");
    assert.equal(after, before);
    assert.equal(q.inputs.length, 1, "the stale crafted command creates no paid job");

    const parentId = "tk_01J8E0000000000000000000PF";
    const parentDir = join(f.dir, "productions", production.meta.id, "takes", parentId);
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, "board.png"), encodePng(solidImage(16, 9, [1, 2, 3, 255])));
    const withParent = {
      ...production,
      takes: [...production.takes, {
        id: parentId,
        jobId: attempted.steps[0]!.jobId!,
        boardSheetParent: true as const,
        coversShots: attempted.steps[0]!.requestShotIds,
        kind: "frame" as const,
        provider: IMAGE.provider,
        model: IMAGE.id,
        provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
        references: [],
        params: {},
        cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
        dispatchedAt: CLOCK(),
        media: "board.png",
      }],
    };
    const retried = (await retryFrameCell(f.store, production.meta.id, run.id, 0, framed.id, () => withParent, q.deps.jobById))!;
    assert.deepEqual(retried.steps.at(-1)!.updateShotIds, [framed.id], "the Retry press is fresh authorization for this fixed cell");
  });

  it("uses the latest successful whole-board retry as cell context", async () => {
    const f = await fixture();
    const run = await start(f, "board");
    const q = queue();
    let current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const initialJobId = current.steps[0]!.jobId!;
    q.settle(initialJobId, "failed", "transient");
    current = (await retryFrameStep(f.store, f.production.meta.id, run.id, 0, () => f.production, q.deps.jobById))!;
    current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const retryJobId = current.steps[1]!.jobId!;
    q.settle(retryJobId, "succeeded");
    const retryParentId = "tk_01J8E0000000000000000000P2";
    const retryParentDir = join(f.dir, "productions", f.production.meta.id, "takes", retryParentId);
    await mkdir(retryParentDir, { recursive: true });
    await writeFile(join(retryParentDir, "retry-board.png"), encodePng(solidImage(16, 9, [4, 5, 6, 255])));
    const retryParent = {
      id: retryParentId,
      jobId: retryJobId,
      boardSheetParent: true as const,
      coversShots: current.steps[1]!.requestShotIds,
      kind: "frame" as const,
      provider: IMAGE.provider,
      model: IMAGE.id,
      provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
      dispatchedAt: CLOCK(),
      media: "retry-board.png",
    };
    const production = { ...f.production, takes: [...f.production.takes, retryParent] };
    const cell = (await retryFrameCell(
      f.store,
      f.production.meta.id,
      run.id,
      1,
      current.steps[1]!.updateShotIds[0]!,
      () => production,
      q.deps.jobById,
    ))!.steps.at(-1)!;
    assert.equal(
      cell.dispatch.references.at(-1),
      `productions/${f.production.meta.id}/takes/${retryParentId}/retry-board.png`,
    );
  });

  it("never borrows a successful board parent from a sibling retry branch", async () => {
    const f = await fixture();
    const run = await start(f, "board");
    const q = queue();
    let current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const initialJobId = current.steps[0]!.jobId!;
    q.settle(initialJobId, "failed", "transient");
    current = (await retryFrameStep(f.store, f.production.meta.id, run.id, 0, () => f.production, q.deps.jobById))!;
    const siblingBoard = current.steps[1]!;
    const siblingJobId = "jb_00000000000000000000000091";
    const namedCellJobId = "jb_00000000000000000000000092";
    const shotId = current.steps[0]!.updateShotIds[0]!;
    const namedCell = {
      ...siblingBoard,
      label: "failed cell branch",
      requestShotIds: [shotId],
      updateShotIds: [shotId],
      request: {
        ...siblingBoard.request,
        panels: [{ panel: 1, shotId, role: "update" as const }],
        layout: undefined,
        slotAtAuthorization: { [shotId]: null },
      },
      dispatch: {
        ...siblingBoard.dispatch,
        target: { kind: "shot", id: shotId, coversShots: [shotId] },
        output: siblingBoard.dispatch.routeOutput,
        references: siblingBoard.request.references.map((reference) => reference.path),
        params: {},
        idempotencyKey: "01J8E0000000000000000000B1",
      },
      grain: "cell-retry" as const,
      retryOf: 0,
      jobId: namedCellJobId,
    };
    namedCell.dispatch.params = {
      ...siblingBoard.dispatch.params,
      output: namedCell.dispatch.output,
      references: namedCell.dispatch.references,
      request: namedCell.request,
      frameRunStep: 2,
    };
    const branched = {
      ...current,
      steps: [current.steps[0]!, { ...siblingBoard, jobId: siblingJobId }, namedCell],
      cursor: 3,
    };
    await writeFile(
      join(f.dir, "productions", f.production.meta.id, "runs", `${run.id}.json`),
      JSON.stringify(branched, null, 2) + "\n",
    );
    q.jobs.set(siblingJobId, {
      ...q.jobs.get(initialJobId)!,
      id: siblingJobId,
      status: "succeeded",
      target: siblingBoard.dispatch.target,
    });
    q.jobs.set(namedCellJobId, {
      ...q.jobs.get(initialJobId)!,
      id: namedCellJobId,
      status: "failed",
      failureClass: "transient",
      target: namedCell.dispatch.target,
    });
    const parentId = "tk_01J8E0000000000000000000P9";
    const parentDir = join(f.dir, "productions", f.production.meta.id, "takes", parentId);
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, "sibling.png"), encodePng(solidImage(16, 9, [1, 1, 1, 255])));
    const production = {
      ...f.production,
      takes: [...f.production.takes, {
        id: parentId,
        jobId: siblingJobId,
        boardSheetParent: true as const,
        coversShots: siblingBoard.requestShotIds,
        kind: "frame" as const,
        provider: IMAGE.provider,
        model: IMAGE.id,
        provenance: { canonRevision: f.world.meta.canonRevision, sheets: {} },
        references: [],
        params: {},
        cost: { estimatedMicroUsd: 1, actualMicroUsd: null },
        dispatchedAt: CLOCK(),
        media: "sibling.png",
      }],
    };
    await assert.rejects(
      () => retryFrameCell(f.store, f.production.meta.id, run.id, 2, shotId, () => production, q.deps.jobById),
      /successful board-sheet attempt/,
    );
  });

  it("folds recovery state into snapshots and dismisses only settled runs", async () => {
    const f = await fixture();
    const run = await start(f, "per-shot");
    const q = queue();
    const current = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    q.settle(current.steps[0]!.jobId!, "failed", "transient");
    const state = await frameRunState(f.store, f.production.meta.id, current, [...q.jobs.values()]);
    const model = new ReadModel("test");
    model.setWorld(f.world);
    model.apply({
      at: CLOCK(),
      type: "production.frame-run",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      runId: run.id,
      state,
    });
    assert.equal(model.getState().frameRuns[0]!.steps[0]!.canRetry, true);
    await assert.rejects(() => dismissFrameRun(f.store, f.production.meta.id, run.id, () => [...q.jobs.values()]), /active/);
    await cancelFrameRun(f.store, f.production.meta.id, run.id, { jobById: q.deps.jobById, cancel: async () => {} });
    assert.equal(await dismissFrameRun(f.store, f.production.meta.id, run.id, () => [...q.jobs.values()]), true);
    const dismissed = await readFrameRun(f.store, f.production.meta.id, run.id);
    assert.equal(dismissed?.dismissed, true, "dismissal hides the report but retains its retry lineage");
    model.apply({
      at: CLOCK(),
      type: "production.frame-run",
      worldId: WORLD_ID,
      productionId: f.production.meta.id,
      runId: run.id,
      state: await frameRunState(f.store, f.production.meta.id, dismissed!, [...q.jobs.values()]),
    });
    assert.equal(model.getState().frameRuns[0]!.run.dismissed, true, "recovery retains hidden retry lineage");
  });
});

describe("frame-run Arke outcomes", () => {
  it("raises schema 4 before appending to an existing scene conversation", async () => {
    const f = await fixture();
    const conversationId = newId("cv") as ConversationId;
    await f.store.ensureSchemaVersion(2, "world-chat");
    await f.store.ownedWrite(async () => {
      const log = new WorldChatStore(conversationDir(f.dir, conversationId));
      await log.create(conversationId, CLOCK());
      await log.append(
        {
          type: "conversation.created",
          title: "Existing scene thread",
          entryContext: { kind: "scene", productionId: f.production.meta.id, sceneId: f.scene.id },
        },
        { at: CLOCK(), requestId: "existing-scene-thread" },
      );
    });
    const completed = await finishRun(f, "succeeded");

    assert.equal(await recordFrameRunOutcome(f.store, completed.state), conversationId);
    assert.equal((await readWorldMeta(f.dir)).schemaVersion, 4);
    await assert.rejects(
      () => readWorldMeta(f.dir, { supports: 3 }),
      (error: unknown) => error instanceof WorldOpenError && error.reason === "schema-newer",
    );
  });

  it("refuses direct conversation writes when the world closes between schema and ownership", async () => {
    const f = await fixture();
    await f.store.ensureSchemaVersion(4, "test");
    const completed = await finishRun(f, "succeeded");
    const ensure = f.store.ensureSchemaVersion.bind(f.store);
    f.store.ensureSchemaVersion = async (version, source) => {
      await ensure(version, source);
      await f.store.close();
    };

    await assert.rejects(() => recordFrameRunOutcome(f.store, completed.state), /world is closed/);
    assert.equal(
      (await discoverConversations(f.dir)).summaries.filter(
        (summary) => summary.entryContext?.kind === "scene" && summary.entryContext.sceneId === f.scene.id,
      ).length,
      0,
    );
  });

  it("records completion, failure, and cancellation once in one scene thread", async () => {
    const f = await fixture();
    const completed = await finishRun(f, "succeeded");
    assert.equal(completed.state.status, "completed");
    const [first, duplicate] = await Promise.all([
      recordFrameRunOutcome(f.store, completed.state),
      recordFrameRunOutcome(f.store, completed.state),
    ]);
    assert.equal(duplicate, first);

    const failed = await finishRun(f, "failed");
    assert.equal(failed.state.status, "completed");
    assert.ok(failed.state.failedShots > 0);
    assert.equal(await recordFrameRunOutcome(f.store, failed.state), first);

    const cancelledQueue = queue();
    const cancelledRun = await start(f, "per-shot");
    const live = (await advanceFrameRun(f.store, f.production.meta.id, cancelledRun.id, cancelledQueue.deps))!;
    await cancelFrameRun(f.store, f.production.meta.id, live.id, {
      jobById: cancelledQueue.deps.jobById,
      cancel: async (jobId) => { cancelledQueue.settle(jobId, "cancelled"); },
    });
    const cancelled = (await readFrameRun(f.store, f.production.meta.id, live.id))!;
    const cancelledState = await frameRunState(
      f.store,
      f.production.meta.id,
      cancelled,
      [...cancelledQueue.jobs.values()],
    );
    assert.equal(cancelledState.status, "cancelled");
    assert.equal(await recordFrameRunOutcome(f.store, cancelledState), first);

    const summaries = (await discoverConversations(f.store.dir)).summaries.filter(
      (summary) => summary.entryContext?.kind === "scene" && summary.entryContext.sceneId === f.scene.id,
    );
    assert.deepEqual(summaries.map((summary) => summary.id), [first]);
    const { events } = await new WorldChatStore(conversationDir(f.store.dir, first)).read();
    const outcomes = events.filter((envelope) => envelope.event.type === "frame-run.outcome-recorded");
    assert.equal(outcomes.length, 3);
    assert.equal(new Set(outcomes.map((envelope) => envelope.requestId)).size, 3);
    const messages = outcomes.map((envelope) => {
      assert.equal(envelope.event.type, "frame-run.outcome-recorded");
      return envelope.event.message.text;
    });
    assert.match(messages[0]!, /^The frame run finished .+\.$/);
    assert.match(messages[1]!, /still needing another try\.$/);
    assert.match(messages[2]!, /^The frame run was cancelled .+\.$/);
  });

  it("waits for assigned finalization before narrating a cancelled run", async () => {
    const f = await fixture();
    const run = await start(f, "per-shot");
    const q = queue();
    const assigned = (await advanceFrameRun(f.store, f.production.meta.id, run.id, q.deps))!;
    const first = assigned.steps[0]!;
    q.settle(first.jobId!, "succeeded");
    q.jobs.set(first.jobId!, {
      ...q.jobs.get(first.jobId!)!,
      finalization: { status: "pending", error: null, updatedAt: CLOCK() },
    });
    await cancelFrameRun(f.store, f.production.meta.id, run.id, {
      jobById: q.deps.jobById,
      cancel: async () => {},
    });
    const cancelled = (await readFrameRun(f.store, f.production.meta.id, run.id))!;
    const pending = await frameRunState(f.store, f.production.meta.id, cancelled, [...q.jobs.values()]);
    assert.equal(pending.status, "cancelled");
    assert.equal(pending.steps[0]!.status, "running");
    assert.ok(pending.steps.slice(1).every((step) => step.status === "not-enqueued"));

    const provider: WorldProvider = {
      listWorlds: async () => [],
      loadWorld: async () => f.store.getBundle(),
      openStore: () => f.store,
    };
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      appVersion: "test",
      changeLogPath: join(f.dir, "changes.jsonl"),
    });
    const record = (coordinator as unknown as {
      recordTerminalFrameRunOutcome(store: WorldStore, state: typeof pending): Promise<void>;
    }).recordTerminalFrameRunOutcome.bind(coordinator);
    await record(f.store, pending);
    assert.equal(
      (await discoverConversations(f.dir)).summaries.filter(
        (summary) => summary.entryContext?.kind === "scene" && summary.entryContext.sceneId === f.scene.id,
      ).length,
      0,
    );

    await recordFrameLandingOutcome(
      f.store,
      f.production.meta.id,
      q.jobs.get(first.jobId!)!,
      first.updateShotIds[0]!,
      "filed",
    );
    q.jobs.set(first.jobId!, {
      ...q.jobs.get(first.jobId!)!,
      finalization: { status: "complete", error: null, updatedAt: CLOCK() },
    });
    const finalizedRun = (await readFrameRun(f.store, f.production.meta.id, run.id))!;
    const finalized = await frameRunState(f.store, f.production.meta.id, finalizedRun, [...q.jobs.values()]);
    await Promise.all([record(f.store, finalized), record(f.store, finalized)]);

    const summaries = (await discoverConversations(f.dir)).summaries.filter(
      (summary) => summary.entryContext?.kind === "scene" && summary.entryContext.sceneId === f.scene.id,
    );
    assert.equal(summaries.length, 1);
    const { events } = await new WorldChatStore(conversationDir(f.dir, summaries[0]!.id)).read();
    const outcomes = events.filter((event) => event.event.type === "frame-run.outcome-recorded");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.event.type, "frame-run.outcome-recorded");
    assert.match(outcomes[0]!.event.message.text, /cancelled after filing frames for 1 shot\.$/);
    await coordinator.stop();
  });

  it("does not publish a recorded outcome after the open world switches during discovery", async () => {
    const f = await fixture();
    const completed = await finishRun(f, "succeeded");
    let openChecks = 0;
    const provider: WorldProvider = {
      listWorlds: async () => [],
      loadWorld: async () => f.store.getBundle(),
      openStore: () => ++openChecks === 1 ? f.store : null,
    };
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      appVersion: "test",
      changeLogPath: join(f.dir, "changes.jsonl"),
    });
    const internals = coordinator as unknown as {
      readModel: ReadModel;
      transport: { broadcastSnapshot(): void };
      recordTerminalFrameRunOutcome(store: WorldStore, state: typeof completed.state): Promise<void>;
    };
    const initial = f.store.getBundle();
    internals.readModel.setWorld(initial);
    let broadcasts = 0;
    internals.transport.broadcastSnapshot = () => { broadcasts += 1; };

    await internals.recordTerminalFrameRunOutcome(f.store, completed.state);

    assert.equal(openChecks, 2, "the store is rechecked after recording and after discovery");
    assert.deepEqual(coordinator.getState().world?.conversations, initial.conversations);
    assert.equal(coordinator.getState().worldChat, null);
    assert.equal(broadcasts, 0);
    assert.equal(
      (await discoverConversations(f.dir)).summaries.filter(
        (summary) => summary.entryContext?.kind === "scene" && summary.entryContext.sceneId === f.scene.id,
      ).length,
      1,
      "the durable outcome still landed",
    );
    await coordinator.stop();
  });

  it("records from folded emission and backfills a different terminal run during recovery", async () => {
    const f = await fixture();
    const emitted = await finishRun(f, "succeeded");
    const provider: WorldProvider = {
      listWorlds: async () => [],
      loadWorld: async () => f.store.getBundle(),
      openStore: () => f.store,
    };
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      appVersion: "test",
      changeLogPath: join(f.dir, "changes.jsonl"),
    });
    const hooks = coordinator as unknown as {
      jobQueue: { listJobs(): Job[] } | null;
      emitFrameRun(
        store: WorldStore,
        worldId: string,
        productionId: string,
        runId: string,
      ): Promise<void>;
      recoverFrameRuns(store: WorldStore, bundle: WorldBundle): Promise<void>;
    };
    hooks.jobQueue = { listJobs: () => [...emitted.q.jobs.values()] };
    await Promise.all([
      hooks.emitFrameRun(f.store, WORLD_ID, f.production.meta.id, emitted.run.id),
      hooks.emitFrameRun(f.store, WORLD_ID, f.production.meta.id, emitted.run.id),
    ]);

    const recovered = await finishRun(f, "failed");
    hooks.jobQueue = { listJobs: () => [...recovered.q.jobs.values()] };
    await hooks.recoverFrameRuns(f.store, f.store.getBundle());

    const summary = (await discoverConversations(f.store.dir)).summaries.find(
      (candidate) => candidate.entryContext?.kind === "scene" && candidate.entryContext.sceneId === f.scene.id,
    );
    assert.ok(summary);
    const { events } = await new WorldChatStore(conversationDir(f.store.dir, summary.id)).read();
    const runIds = events.flatMap((envelope) =>
      envelope.event.type === "frame-run.outcome-recorded" ? [envelope.event.report.runId] : [],
    );
    assert.equal(runIds.filter((runId) => runId === emitted.run.id).length, 1, "concurrent emits deduplicate");
    assert.equal(runIds.filter((runId) => runId === recovered.run.id).length, 1, "recovery records the missing outcome");
    hooks.jobQueue = null;
    await coordinator.stop();
  });
});
