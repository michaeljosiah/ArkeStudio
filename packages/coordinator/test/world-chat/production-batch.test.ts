import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobSchema, WorldChatCheckReceiptSchema, newId, ulid, type ConversationActionCard, type Job, type ManifestModel, type ModelManifest, type ModelWorldChatAction } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { productionBatchSource, ProductionBatchControls, type ProductionBatchPorts } from "../../src/world-chat/production-batch.js";
import { GenerationQuotes } from "../../src/world-chat/generation-quotes.js";
import { advanceFrameRun, listFrameRuns, quoteFrameRun, readFrameRun, recordBoardSheetFromJob } from "../../src/productions/frame-run.js";
import { advancePlan, appendPlanEvents, listPlans, planState, readPlanEvents, readPlanRecords } from "../../src/productions/plans.js";
import type { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { sceneFence, takesFence, WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { prepareWorldChatActions } from "../../src/world-chat/actions.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const AT = "2026-10-04T01:00:00.000Z";
const IMAGE: ManifestModel = { id: "batch-image", provider: "fal", capability: "image", displayName: "Batch image",
  accepts: { referenceImages: 8, startFrame: false, endFrame: false }, limits: { aspects: ["16:9"] }, pricing: { kind: "perImage", microUsdPerImage: 1000, microUsdPerReferenceImage: 10 } };
const VIDEO: ManifestModel = { id: "batch-video", provider: "fal", capability: "video", displayName: "Batch video",
  accepts: { referenceImages: 8, startFrame: true, endFrame: false }, modes: { generate: { locked: [] }, "first-frame": { locked: [], route: "first-frame" } },
  limits: { maxDurationSec: 10, storyboardPanels: 6, aspects: ["16:9"], durations: { "4": "4", "6": "6", "8": "8", "10": "10" } }, pricing: { kind: "perSecond", microUsdPerSecond: 1000 } };
const frameAction = (mode: "per-shot" | "board" = "per-shot"): Extract<ModelWorldChatAction, { kind: "production-frame-run-start" }> => ({ kind: "production-frame-run-start",
  productionId: "saltlight", sceneId: "sc_04", mode, scope: "all", modelId: IMAGE.id, checkReceiptIds: [newId("check")] });
const planAction = (): Extract<ModelWorldChatAction, { kind: "production-scene-dispatch" }> => ({ kind: "production-scene-dispatch", productionId: "saltlight",
  sceneId: "sc_04", mode: "whole-scene", policy: "review-gated", modelId: VIDEO.id, checkReceiptIds: [newId("check")] });
async function setup() {
  const made = await makeTempRoot();
  const provider = new FsWorldProvider(made.root, { clock: () => AT });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-10-04", models: [IMAGE, VIDEO] };
  const coordinator = new Coordinator({ provider, manifest, adapter: null, appVersion: "test", changeLogPath: join(made.root, "changes.jsonl"),
    boundaryFrameMaker: { write: async (_input, output) => { await writeFile(output, encodePng(solidImage(4, 4, [20, 40, 60, 255]))); return { ok: true }; } } });
  closeOnCleanup(() => coordinator.stop());
  coordinator.emit({ type: "provider.status", at: AT, providers: [{ id: "fal", configured: true, validation: "valid", fault: null,
    probes: [{ capability: "image", available: true }, { capability: "video", available: true }] }] });
  const jobs: Job[] = [], inputs: EnqueueInput[] = [];
  const enqueue = async (input: EnqueueInput) => {
    const existing = jobs.find(job => job.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    inputs.push(structuredClone(input));
    const job = JobSchema.parse({ ...input, id: newId("jb"), status: "queued", createdAt: AT, updatedAt: AT });
    jobs.push(job); return job;
  };
  const internal = coordinator as unknown as { jobQueue: unknown; productionBatchPorts(store: WorldStore): ProductionBatchPorts;
    conversationActionLifecycle(store: WorldStore): ConversationActionLifecycle; backgroundWork: Set<Promise<unknown>>; onJobTerminal(job: Job): Promise<void> };
  internal.jobQueue = { listJobs: () => jobs, enqueue, cancel: async (id: string) => { const job = jobs.find(j => j.id === id)!; job.status = "cancelled"; }, dispose: async () => {} };
  const store = provider.openStore()!;
  await store.ownedWrite(async () => {
    const path = join(made.worldDir, "productions/saltlight/production.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata.models = { image: IMAGE.id, video: VIDEO.id };
    await writeFile(path, JSON.stringify(metadata));
  });
  const ports = internal.productionBatchPorts(store);
  ports.refresh = async () => {};
  const source = productionBatchSource(store, ports);
  const quotes = () => new GenerationQuotes(store, source, { enqueue, jobs: () => jobs, actualCost: async () => 0 });
  const controls = new ProductionBatchControls(store, ports);
  const card = (id: string) => ({ actionId: id } as ConversationActionCard);
  return { ...made, store, ports, source, quotes, controls, jobs, inputs, card, coordinator, internal };
}

describe("Production Chat batch authority (SPEC-051 R-8..10)", () => {
  async function actionRead(h: Awaited<ReturnType<typeof setup>>, tool: "list_jobs" | "list_plans") {
    const conversationId = newId("cv"), log = new WorldChatStore(conversationDir(h.worldDir, conversationId));
    const entryContext = { kind: "production" as const, productionId: "saltlight" };
    await log.create(conversationId, AT);
    await log.append({ type: "conversation.created", title: "Control production work", entryContext }, { at: AT });
    const lease = new QueryLeaseRegistry(() => WORLD_ID).mint({ worldId: WORLD_ID, conversationId, runId: newId("run") });
    const reader = new WorldChatTargetReads({ getJobs: () => h.jobs, getPlans: async id => readPlanRecords(h.store, id, h.jobs) });
    const read = await reader.call(lease, h.store.getBundle(), tool, { productionId: "saltlight" });
    const receipt = WorldChatCheckReceiptSchema.parse({ id: newId("check"), runId: lease.runId, tool: "target-read", status: read.status, consulted: [],
      target: read.result.target, observedRevisionOrDigest: read.result.observedRevisionOrDigest, complete: read.result.complete, nextCursor: read.result.nextCursor, at: AT });
    const lifecycle = h.internal.conversationActionLifecycle(h.store);
    const prepare = (action: ModelWorldChatAction) => prepareWorldChatActions(h.store, lifecycle, { conversationId, turnId: newId("turn"), entryContext,
      existingCandidates: [], existingGroups: [], candidates: [], groups: [], bibleEdits: [], bibleBaseVersion: 1, sceneEdits: [], sceneBaseVersion: null,
      editorRequests: [], actions: [action], receipts: [receipt], at: AT }, { getJobs: () => h.jobs });
    return { read: read.result, receipt, prepare, lifecycle, log };
  }
  for (const mode of ["per-shot", "board"] as const) it(`quotes ${mode} identically to Generate, survives restart and admits only after approval`, async () => {
    const h = await setup(), action = frameAction(mode), id = newId("act");
    const input = await h.ports.frameInput(action, id, AT);
    const screen = await quoteFrameRun(h.store, { ...action, requestId: ulid(), quoteId: ulid(), worldId: WORLD_ID, modelId: IMAGE.id, compile: () => input, clock: () => AT });
    const compiled = await h.source.compile(action, id, AT);
    assert.equal((compiled.materialization as { quote: { signature: string } }).quote.signature, screen.signature);
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.estimatedMicroUsd, screen.estimatedMicroUsd);
    assert.equal(body.quantity, screen.steps.length);
    assert.equal(h.jobs.length, 0);
    assert.equal((await listFrameRuns(h.store, "saltlight")).length, 0);
    assert.deepEqual(await h.quotes().prepare(action, id, AT), body);
    assert.equal((await h.quotes().dispatch(action, id)).status, "queued");
    assert.equal(h.jobs.length, 1, "a run admits its first step and owns subsequent ordering");
    assert.ok(Array.isArray(h.jobs[0]!.params.generationQuoteReferences));
    await h.quotes().dispatch(action, id);
    assert.equal(h.jobs.length, 1, "redelivery does not create another run or admission");
  });
  it("denies without work and refuses a shot changed after quotation", async () => {
    const h = await setup(), action = frameAction(), id = newId("act");
    await h.quotes().prepare(action, id, AT);
    await h.quotes().abandon(id);
    await assert.rejects(h.quotes().dispatch(action, id), /unavailable/);
    const fresh = newId("act");
    await h.quotes().prepare(action, fresh, AT);
    const p = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, scene = p.scenes.find(s => s.id === "sc_04")!;
    await applySceneCommand(h.store, { productionId: p.meta.id, sceneId: scene.id, sceneFile: p.sceneFiles[scene.id]!, baseVersion: scene.version,
      command: { kind: "edit-shot", shotId: "sh_12", change: { description: "A changed shot." } } });
    await assert.rejects(h.quotes().dispatch(action, fresh), /inputs changed/i);
    assert.equal(h.jobs.length, 0);
    assert.equal((await listFrameRuns(h.store, "saltlight")).length, 0);
  });
  it("quotes remaining spend on resume and recovers a pause without reversing a later human resume", async () => {
    const h = await setup(), start = frameAction(), id = newId("act"), runId = `fr_${id.slice(4)}`;
    await h.quotes().prepare(start, id, AT); await h.quotes().dispatch(start, id);
    const pause = { kind: "production-frame-run-pause" as const, productionId: "saltlight", runId, checkReceiptIds: [newId("check")] }, pauseId = newId("act");
    await h.controls.execute(pause, pauseId, () => null);
    h.jobs[0]!.status = "failed"; h.jobs[0]!.failureClass = "transient";
    await advanceFrameRun(h.store, "saltlight", runId, h.ports.frameDeps());
    assert.equal(h.jobs.length, 1);
    const resume = { kind: "production-frame-run-resume" as const, productionId: "saltlight", runId, checkReceiptIds: [newId("check")] }, resumeId = newId("act");
    const before = (await readFrameRun(h.store, "saltlight", runId))!;
    const body = await h.quotes().prepare(resume, resumeId, AT);
    assert.equal(body.quantity, before.steps.length - before.cursor);
    assert.equal(h.jobs.length, 1);
    await h.quotes().dispatch(resume, resumeId);
    assert.equal(h.jobs.length, 2);
    const recovered = await h.controls.reconcile({ actionId: pauseId, actionKind: "world-chat-production-frame-run-pause", productionId: "saltlight", authority: { kind: "frame-run", id: runId } } as ConversationActionCard);
    assert.equal(recovered?.status, "completed");
    assert.equal((await readFrameRun(h.store, "saltlight", runId))!.paused, false);
  });
  it("previews and purchases a step retry without mutating the settled run before approval", async () => {
    const h = await setup(), start = frameAction(), id = newId("act"), runId = `fr_${id.slice(4)}`;
    await h.quotes().prepare(start, id, AT); await h.quotes().dispatch(start, id);
    for (let index = 0; index < 4; index++) {
      h.jobs[index]!.status = "failed"; h.jobs[index]!.failureClass = "transient";
      await advanceFrameRun(h.store, "saltlight", runId, h.ports.frameDeps());
    }
    const before = (await readFrameRun(h.store, "saltlight", runId))!;
    const retry = { kind: "production-frame-run-retry-step" as const, productionId: "saltlight", runId, stepIndex: 0, checkReceiptIds: [newId("check")] }, retryId = newId("act");
    const body = await h.quotes().prepare(retry, retryId, AT);
    assert.equal(body.quantity, 1);
    assert.deepEqual(await readFrameRun(h.store, "saltlight", runId), before);
    await h.quotes().dispatch(retry, retryId);
    assert.equal(h.jobs.length, 5);
    assert.equal(h.jobs[4]!.params.prompt, h.jobs[0]!.params.prompt);
    assert.notEqual(h.jobs[4]!.idempotencyKey, h.jobs[0]!.idempotencyKey);
  });
  it("quotes a board-cell retry from its immutable parent and admits it after approval", async () => {
    const h = await setup(), start = frameAction("board"), id = newId("act"), runId = `fr_${id.slice(4)}`;
    await h.quotes().prepare(start, id, AT); await h.quotes().dispatch(start, id);
    const run = (await readFrameRun(h.store, "saltlight", runId))!, job = h.jobs[0]!, output = run.steps[0]!.dispatch.output;
    await mkdir(join(h.worldDir, job.landing!.dir), { recursive: true });
    const file = `${job.landing!.dir}/${job.landing!.name}`;
    await writeFile(join(h.worldDir, file), encodePng(solidImage(output.width, output.height, [20, 40, 60, 255])));
    job.status = "succeeded"; job.landedFiles = [file]; job.finalization = { status: "complete", error: null, updatedAt: AT };
    await recordBoardSheetFromJob(h.store, h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, job, 0, undefined);
    const shotId = run.steps[0]!.requestShotIds[0]!;
    const retry = { kind: "production-frame-run-retry-cell" as const, productionId: "saltlight", runId, stepIndex: 0, shotId, checkReceiptIds: [newId("check")] }, retryId = newId("act");
    const before = await readFrameRun(h.store, "saltlight", runId);
    const compiled = await h.source.compile(retry, retryId, AT);
    assert.ok(compiled.inputs.at(-1)!.params.references);
    await h.quotes().prepare(retry, retryId, AT);
    assert.deepEqual(await readFrameRun(h.store, "saltlight", runId), before);
    await h.quotes().dispatch(retry, retryId);
    const after = (await readFrameRun(h.store, "saltlight", runId))!;
    assert.equal(after.steps.at(-1)!.grain, "cell-retry");
    assert.equal(after.steps.at(-1)!.request.contextImages?.length, 1);
  });
  it("persists the reviewed plan, holds its human gate, and pins a late boundary before the next dispatch", async () => {
    const h = await setup(), action = planAction(), id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal((await listPlans(h.store, "saltlight")).length, 0);
    assert.equal(h.jobs.length, 0);
    await h.quotes().dispatch(action, id);
    const plan = (await listPlans(h.store, "saltlight"))[0]!;
    assert.ok(plan);
    assert.equal(body.estimatedMicroUsd, plan.capMicroUsd);
    assert.equal(h.jobs.length, 1);
    const job = h.jobs[0]!;
    await mkdir(join(h.worldDir, job.landing!.dir), { recursive: true });
    const file = `${job.landing!.dir}/clip.mp4`;
    await writeFile(join(h.worldDir, file), Buffer.from("test-video"));
    job.status = "succeeded"; job.landedFiles = [file]; job.finalization = { status: "complete", error: null, updatedAt: AT };
    await recordTakesFromJob(h.store, job, 0);
    await advancePlan(h.store, h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, h.store.getBundle(), plan, h.ports.planDeps());
    assert.equal(h.jobs.length, 1, "review-gated continuation is not granted by the model");
    assert.equal((await h.quotes().reconcile(h.card(id)))?.status, "running");
    await appendPlanEvents(h.store, "saltlight", plan.planId, [{ kind: "continue-approved", ts: AT, planId: plan.planId, passIndex: 1 }]);
    await advancePlan(h.store, h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, h.store.getBundle(), plan, h.ports.planDeps());
    assert.equal(h.jobs.length, 2);
    const pins = h.jobs[1]!.params.generationQuoteReferences as { file: string; hash: string }[];
    assert.equal(pins[0]!.file, (h.jobs[1]!.params.references as string[])[0]);
    assert.equal(pins[0]!.hash.length, 64);
    const aggregate = await readFile(join(h.worldDir, "productions/saltlight/plans", `${plan.planId}.json`), "utf8");
    const cancelId = newId("act");
    await h.controls.execute({ kind: "production-plan-cancel", productionId: "saltlight", planId: plan.planId, checkReceiptIds: [newId("check")] }, cancelId, () => null);
    assert.equal((await planState(h.store, plan, h.ports.planDeps())).status, "cancelled");
    assert.equal(await readFile(join(h.worldDir, "productions/saltlight/plans", `${plan.planId}.json`), "utf8"), aggregate);
    assert.ok((await readPlanEvents(h.store, "saltlight", plan.planId)).some(event => event.kind === "cancelled" && event.requestId === cancelId));
    assert.equal((await h.controls.reconcile({ actionId: cancelId, actionKind: "world-chat-production-plan-cancel", productionId: "saltlight", authority: { kind: "dispatch-plan", id: plan.planId } } as ConversationActionCard))?.status, "completed");
    assert.equal(h.inputs.length, 2, "recovery never purchases another pass");
  });
  it("settles an open frame-run conversation card after terminal work without reopening the thread", async () => {
    const h = await setup();
    await h.coordinator.openWorld(WORLD_ID);
    const production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, scene = production.scenes.find(s => s.id === "sc_04")!;
    const conversationId = newId("cv"), log = new WorldChatStore(conversationDir(h.worldDir, conversationId));
    await log.create(conversationId, AT);
    await log.append({ type: "conversation.created", title: "Draw frames", entryContext: { kind: "scene", productionId: production.meta.id, sceneId: scene.id } }, { at: AT });
    const lifecycle = h.internal.conversationActionLifecycle(h.store);
    const card = await lifecycle.prepare({ conversationId, turnId: newId("turn"), worldId: WORLD_ID, productionId: production.meta.id,
      actionKind: "world-chat-production-frame-run-start", targets: [{ kind: "production", id: production.meta.id }], createdAt: AT,
      payload: { kind: "world-chat-production-frame-run-start", worldId: WORLD_ID, action: { ...frameAction(), shotId: "sh_12" } },
      baseObservations: [{ requirement: "scenes", target: `${production.meta.id}:${scene.id}`, revisionOrDigest: sceneFence(production, scene.id), complete: true },
        { requirement: "takes", target: production.meta.id, revisionOrDigest: takesFence(production), complete: true }] });
    assert.equal(h.jobs.length, 0);
    const before = foldConversation(conversationId, AT, (await log.read()).events).view;
    await lifecycle.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId, actionId: card.actionId, requestId: ulid(),
      decision: "approve", expectedStatus: "pending", expectedConversationSeq: before.seq });
    await Promise.all(h.internal.backgroundWork);
    assert.equal(h.jobs.length, 1);
    const job = h.jobs[0]!;
    job.status = "failed"; job.failureClass = "transient";
    await h.internal.onJobTerminal(job);
    await Promise.all(h.internal.backgroundWork);
    const settled = foldConversation(conversationId, AT, (await log.read()).events).view.actions[0]!;
    assert.equal(settled.status, "failed");
    assert.equal(settled.receipt?.generation?.authorized, 1);
    assert.equal(h.jobs.length, 1);
  });
  it("recovers a cancelled frame run after a lost quote acknowledgement without resubmitting", async () => {
    const h = await setup(), action = frameAction(), id = newId("act"), runId = `fr_${id.slice(4)}`;
    await h.quotes().prepare(action, id, AT); await h.quotes().dispatch(action, id);
    const cancelId = newId("act");
    await h.controls.execute({ kind: "production-frame-run-cancel", productionId: "saltlight", runId, checkReceiptIds: [newId("check")] }, cancelId, () => null);
    const path = join(h.worldDir, ".history/world/prepared", `${id}.generation.json`);
    const quote = JSON.parse(await readFile(path, "utf8"));
    quote.admissionComplete = false;
    await h.store.ownedWrite(() => writeFile(path, JSON.stringify(quote)));
    const receipt = await h.quotes().reconcile(h.card(id));
    assert.equal(receipt?.receipt?.generation?.cancelled, 1);
    assert.equal(receipt?.receipt?.generation?.unattempted, 3);
    assert.equal(JSON.parse(await readFile(path, "utf8")).admissionComplete, true);
    assert.equal((await h.controls.reconcile({ actionId: cancelId, actionKind: "world-chat-production-frame-run-cancel", productionId: "saltlight", authority: { kind: "frame-run", id: runId } } as ConversationActionCard))?.status, "completed");
    await h.quotes().dispatch(action, id);
    assert.equal(h.jobs.length, 1);
  });
  it("discovers run controls through a safe jobs receipt and binds their real approval adapter", async () => {
    const h = await setup(), start = frameAction(), id = newId("act");
    await h.quotes().prepare(start, id, AT); await h.quotes().dispatch(start, id);
    const read = await actionRead(h, "list_jobs");
    const job = read.read.items[0] as { frameRun: { runId: string; stepIndex: number } };
    assert.deepEqual(job.frameRun, { runId: `fr_${id.slice(4)}`, stepIndex: 0 });
    assert.doesNotMatch(JSON.stringify(read.read.items), /generationQuoteReferences|idempotencyKey/);
    const prepared = read.prepare({ kind: "production-frame-run-pause", productionId: "saltlight", runId: job.frameRun.runId, checkReceiptIds: [read.receipt.id] })[0]!;
    await read.log.append({ type: "action.prepare-intent", intent: prepared.intent }, { at: AT });
    const card = await read.lifecycle.bindIntent(prepared.intent, prepared.payload);
    assert.equal(card.authority.id, job.frameRun.runId);
    assert.equal(card.shown.body.family, "command");
  });
  it("prepares cancellation from a fresh plan-state receipt and refuses it after cancellation changes that state", async () => {
    const h = await setup(), action = planAction(), id = newId("act");
    await h.quotes().prepare(action, id, AT); await h.quotes().dispatch(action, id);
    const read = await actionRead(h, "list_plans");
    const record = read.read.items[0] as { plan: { planId: string }; state: { status: string } };
    assert.equal(record.state.status, "active");
    const cancel = { kind: "production-plan-cancel" as const, productionId: "saltlight", planId: record.plan.planId, checkReceiptIds: [read.receipt.id] };
    const prepared = read.prepare(cancel)[0]!;
    await read.log.append({ type: "action.prepare-intent", intent: prepared.intent }, { at: AT });
    const card = await read.lifecycle.bindIntent(prepared.intent, prepared.payload);
    assert.equal(card.authority.id, cancel.planId);
    await appendPlanEvents(h.store, "saltlight", cancel.planId, [{ kind: "cancelled", planId: cancel.planId, ts: AT }]);
    assert.throws(() => read.prepare(cancel), /plans.*no longer current/i);
  });
  it("discloses that approval pre-authorizes every pass of an automatic plan", async () => {
    const h = await setup();
    const body = await h.quotes().prepare({ ...planAction(), policy: "pre-authorized" }, newId("act"), AT);
    assert.match(body.options!.find(option => option.label === "Continuation policy")!.value, /pre-authorizes every quoted pass.*automatically/i);
    assert.equal(h.jobs.length, 0);
  });
  it("settles a frame-run admission refused before an authority exists, without replaying that purchase", async () => {
    const h = await setup(), action = frameAction(), id = newId("act"), competingId = newId("act");
    await h.quotes().prepare(action, competingId, AT);
    const quotes = new GenerationQuotes(h.store, { ...h.source, dispatch: async (...args) => {
      await h.quotes().dispatch(action, competingId);
      return h.source.dispatch!(...args);
    } }, { enqueue: async () => { throw new Error("unexpected enqueue"); }, jobs: () => h.jobs });
    await quotes.prepare(action, id, AT);
    assert.equal((await quotes.dispatch(action, id)).status, "running");
    assert.equal((await quotes.reconcile(h.card(id)))?.status, "stale");
    await quotes.dispatch(action, id);
    assert.equal(h.jobs.length, 1, "only the competing run purchased work");
    const dir = join(h.worldDir, "productions/saltlight/runs");
    await h.store.ownedWrite(() => writeFile(join(dir, `fr_${id.slice(4)}.json`), "{broken"));
    assert.equal((await quotes.reconcile(h.card(id)))?.status, "running", "an unreadable record is not proof of absence");
  });
  it("bounds a large review prompt while retaining every complete quoted provider prompt", async () => {
    const h = await setup(), action = { ...frameAction(), shotId: "sh_12" }, id = newId("act");
    const p = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, scene = p.scenes.find(s => s.id === "sc_04")!;
    await applySceneCommand(h.store, { productionId: p.meta.id, sceneId: scene.id, sceneFile: p.sceneFiles[scene.id]!, baseVersion: scene.version,
      command: { kind: "edit-shot", shotId: "sh_12", change: { description: "A detailed visual direction. ".repeat(4_000) } } });
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.prompt.length, 100_000);
    assert.match(body.prompt, /Display truncated/);
    assert.ok(String((await h.quotes().validate(action, id)).inputs[0]!.params.prompt).length > body.prompt.length);
    assert.equal(h.jobs.length, 0);
  });
  it("settles a plan refused when its scene changes after quote validation but before authority persistence", async () => {
    const h = await setup(), action = planAction(), id = newId("act");
    const quotes = new GenerationQuotes(h.store, { ...h.source, dispatch: async (...args) => {
      const p = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, scene = p.scenes.find(s => s.id === "sc_04")!;
      await applySceneCommand(h.store, { productionId: p.meta.id, sceneId: scene.id, sceneFile: p.sceneFiles[scene.id]!, baseVersion: scene.version,
        command: { kind: "edit-shot", shotId: "sh_12", change: { description: "Changed after approval validation." } } });
      return h.source.dispatch!(...args);
    } }, { enqueue: async () => { throw new Error("unexpected enqueue"); }, jobs: () => h.jobs });
    await quotes.prepare(action, id, AT);
    assert.equal((await quotes.dispatch(action, id)).status, "running");
    assert.equal((await quotes.reconcile(h.card(id)))?.status, "stale");
    await quotes.dispatch(action, id);
    assert.equal(h.jobs.length, 0);
    assert.equal((await listPlans(h.store, "saltlight")).length, 0);
  });
});
