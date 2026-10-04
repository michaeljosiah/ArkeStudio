import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CharacterAudioPlanSchema, DispatchPlanSchema, FrameRunQuoteSchema, FrameRunSchema, referenceAudioAsset,
  type ArkeGenerationBody, type ConversationActionBody, type ConversationActionCard, type Job, type ModelWorldChatAction,
} from "@arke-studio/contracts";
import {
  advanceFrameRun, cancelFrameRun, compileFrameRun, frameRunState, pauseFrameRun, quoteFrameRun,
  readFrameRun, resumeFrameRun, retryFrameCell, retryFrameStep, startFrameRun,
  type CompileFrameRunInput, type FrameRunDriverDeps,
} from "../productions/frame-run.js";
import {
  advancePlan, appendPlanEvents, compileDispatchPlan, createDispatchPlan, listPlans, planState, readPlanEvents,
  type CreatePlanInput, type PlanDriverDeps,
} from "../productions/plans.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore, WorldStatePrecondition } from "../world/store.js";
import { readContainedImageReferences } from "../world/reference-files.js";
import type { GenerationQuoteSource } from "./generation-quotes.js";

type StartAction = Extract<ModelWorldChatAction, { kind: "production-frame-run-start" }>;
type PlanAction = Extract<ModelWorldChatAction, { kind: "production-scene-dispatch" }>;
type ArkeCommandBody = Extract<ConversationActionBody, { family: "command" }>;
type FrameGenerationAction = Extract<ModelWorldChatAction, { kind: "production-frame-run-start" | "production-frame-run-resume" | "production-frame-run-retry-step" | "production-frame-run-retry-cell" }>;
function isFrameGeneration(action: ModelWorldChatAction): action is FrameGenerationAction {
  return ["production-frame-run-start", "production-frame-run-resume", "production-frame-run-retry-step", "production-frame-run-retry-cell"].includes(action.kind);
}
type ControlAction = Extract<ModelWorldChatAction, { kind: "production-frame-run-pause" | "production-frame-run-cancel" | "production-plan-cancel" }>;
function isControl(action: ModelWorldChatAction): action is ControlAction {
  return ["production-frame-run-pause", "production-frame-run-cancel", "production-plan-cancel"].includes(action.kind);
}
export interface ProductionBatchPorts {
  jobs(): readonly Job[];
  frameInput(action: StartAction, actionId: string, at: string): Promise<CompileFrameRunInput>;
  planInput(action: PlanAction, actionId: string, at: string, acknowledgeShotIds?: readonly string[]): Promise<CreatePlanInput>;
  frameDeps(): FrameRunDriverDeps;
  planDeps(): PlanDriverDeps;
  cancel(jobId: string): Promise<void>;
  freeze(input: EnqueueInput): EnqueueInput;
  refresh(productionId: string, runId?: string): Promise<void>;
}
function key(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return Array.from({ length: 26 }, (_, index) => alphabet[bytes[index]! % 32]).join("");
}
function frameInputs(run: ReturnType<typeof FrameRunSchema.parse>, from: number): EnqueueInput[] {
  return run.steps.slice(from).map(({ dispatch }) => ({ worldId: dispatch.worldId, productionId: dispatch.productionId,
    target: dispatch.target, capability: dispatch.capability, provider: dispatch.provider, model: dispatch.model,
    params: dispatch.params, estimatedMicroUsd: dispatch.estimatedMicroUsd, landing: dispatch.landing,
    idempotencyKey: dispatch.idempotencyKey, recipe: dispatch.recipe, engine: dispatch.engine }));
}
function generationBody(inputs: readonly EnqueueInput[], purpose: string, output: string, options: NonNullable<ArkeGenerationBody["options"]>): ArkeGenerationBody {
  const prompt = inputs.map((input, index) => `${index + 1}. ${String(input.params.prompt ?? "")}`).join("\n\n") || "Resume existing work; no further provider requests.";
  const suffix = "\n[Display truncated; complete prompts remain frozen in the approved jobs.]";
  return { family: "generation", medium: inputs[0]?.capability === "video" ? "video" : "image", purpose,
    prompt: prompt.length > 100_000 ? prompt.slice(0, 100_000 - suffix.length) + suffix : prompt,
    provider: inputs[0]?.provider ?? "Existing run", model: inputs[0]?.model ?? "Existing run", quantity: Math.max(1, inputs.length),
    references: inputs.flatMap((input, index) => {
      const audio = CharacterAudioPlanSchema.safeParse(input.params.audioReferences);
      const paths = [...(input.params.references as string[] ?? []), ...(input.params.videoReferences as string[] ?? []),
        ...(audio.success ? audio.data.references.map(ref => referenceAudioAsset(ref).file) : [])];
      return paths.map(path => ({ id: `ref_${key(path)}`, role: `Step ${index + 1}: ${path}`.slice(0, 200) }));
    }),
    exclusions: inputs.flatMap(input => ((input.params.request as { droppedReferences?: { path: string; reason: string }[] } | undefined)?.droppedReferences ?? []).map(ref => `${ref.path}: ${ref.reason}`)),
    options: options.map(option => {
      const suffix = "\n[Display truncated; complete data remains frozen in the approved plan or run.]";
      return { label: option.label.slice(0, 200), value: option.value.length > 20_000 ? option.value.slice(0, 20_000 - suffix.length) + suffix : option.value };
    }), output, cost: "Coordinator quote", privacy: ["Resolved prompts and carried image, video and audio references go to the configured provider runtime."], cancellationSupported: true };
}

/** Chat quotes reuse the same run/plan compilers and persist the domain authority before enqueue. */
export function productionBatchSource(store: WorldStore, ports: ProductionBatchPorts): GenerationQuoteSource {
  const productionFor = (id: string) => store.getBundle().productions.find(p => p.meta.id === id);
  const absentAuthority = async (productionId: string, id: string, kind: "runs" | "plans", inputs: readonly EnqueueInput[]) => {
    try { await stat(join(store.dir, "productions", productionId, kind, `${id}.json`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !inputs.some(input => ports.jobs().some(job => job.idempotencyKey === input.idempotencyKey))) {
        return { status: "stale" as const, detail: "No durable production authority was created or work admitted. Prepare a fresh card." };
      }
    }
    return { status: "running" as const, detail: "Production admission needs reconciliation in Activity; no purchase was repeated." };
  };
  return {
    compile: async (action, id, at) => {
      if (action.kind === "production-scene-dispatch") {
        const input = await ports.planInput(action, id, at);
        const plan = await compileDispatchPlan(store, { ...input, planId: `pl_${id.slice(4)}`, idempotencyKeyFor: index => key(`${id}/pass/${index}`), clock: () => at });
        const inputs: EnqueueInput[] = plan.passes.map(pass => ports.freeze({ worldId: plan.worldId, productionId: plan.productionId,
          target: pass.compiled.target, capability: pass.compiled.model.capability as "video" | "image",
          provider: pass.compiled.model.provider, model: pass.compiled.model.id, params: { ...pass.compiled.params, generationQuoteProduction: true },
          estimatedMicroUsd: pass.compiled.estimatedMicroUsd, landing: { dir: pass.compiled.landing.dir }, idempotencyKey: pass.idempotencyKey }));
        for (const input of inputs) if (input.recipe || input.engine) input.params = { ...input.params, generationQuoteLocalIdentity: { recipe: input.recipe, engine: input.engine } };
        return { inputs, authority: plan, materialization: { plan },
          body: generationBody(inputs, "Dispatch a planned scene", "Immutable candidate takes; acceptance is separate", [
            { label: "Plan", value: `${plan.planId} · ${plan.mode} · ${plan.policy}` },
            ...plan.passes.map(pass => ({ label: `Pass ${pass.passIndex + 1}`, value: `${pass.compiled.target.coversShots.join(", ")} · ${pass.compiled.route.kind} · ${pass.compiled.askedSec === undefined ? "image" : `${pass.compiled.askedSec}s`} · ${pass.dependsOn.map(dep => `after pass ${dep.passIndex + 1}: ${dep.needs}`).join("; ") || "ready to start"}` })),
            { label: "Dropped inputs", value: plan.passes.flatMap(pass => pass.compiled.dropped.map(ref => `${ref.sheetId}: ${ref.reason}`)).join("; ") || "None" },
            ...plan.passes.flatMap(pass => (pass.carries?.cast ?? []).map(member => ({ label: `Pass ${pass.passIndex + 1}: ${member.name}`, value: `Look ${member.look}; voice ${member.voice}${member.reason ? `; ${member.reason}` : ""}${member.voiceReason ? `; ${member.voiceReason}` : ""}` }))),
            ...(plan.castNotSent ?? []).map(member => ({ label: `${member.name}: audio not sent`, value: member.reason })),
            { label: "Continuation policy", value: plan.policy === "pre-authorized" ? "Approval pre-authorizes every quoted pass; later passes advance automatically. Changed-price reconfirmation remains human." : "Later dependent passes require human Continue. Changed-price reconfirmation also remains human." },
          ]) };
      }
      if (!isFrameGeneration(action)) throw new Error("This is not a production batch generation action.");
      const getProduction = () => productionFor(action.productionId);
      const jobs = ports.jobs();
      const jobById = (jobId: string) => jobs.find(job => job.id === jobId);
      let run, from: number, quote;
      if (action.kind === "production-frame-run-start") {
        const input = { ...await ports.frameInput(action, id, at), runId: `fr_${id.slice(4)}`, clock: () => at };
        run = await compileFrameRun(input);
        quote = await quoteFrameRun(store, { requestId: id.slice(4), quoteId: id.slice(4), worldId: store.worldId, productionId: action.productionId,
          sceneId: action.sceneId, mode: action.mode, modelId: input.model.id, scope: action.scope, shotId: action.shotId, clock: () => at, compile: () => input });
        if (quote.blockedReason) throw new Error(quote.blockedReason);
        from = 0;
      } else if (action.kind === "production-frame-run-resume") {
        const current = await readFrameRun(store, action.productionId, action.runId);
        if (!current || current.cancelled || !current.paused) throw new Error("Choose a paused, uncancelled frame run.");
        run = { ...current, paused: false };
        from = current.cursor;
      } else if (action.kind === "production-frame-run-retry-step" || action.kind === "production-frame-run-retry-cell") {
        run = action.kind === "production-frame-run-retry-step"
          ? await retryFrameStep(store, action.productionId, action.runId, action.stepIndex, getProduction, jobById, { previewOnly: true })
          : await retryFrameCell(store, action.productionId, action.runId, action.stepIndex, action.shotId, getProduction, jobById, { previewOnly: true });
        if (!run) throw new Error("The frame run is unavailable.");
        // A retry may also release the paused run's remaining original steps; quote all of them.
        from = run.cursor;
      } else throw new Error("This frame-run control does not purchase generation.");
      const inputs = frameInputs(run, from);
      for (const input of inputs) {
        const pins = input.params.generationQuoteReferences as { file: string; hash: string }[] | undefined;
        if (!pins) continue;
        const files = await readContainedImageReferences(store.dir, pins.map(pin => pin.file));
        if (pins.some((pin, index) => pin.hash !== createHash("sha256").update(files[index]!.data).digest("hex"))) throw new Error("A frozen frame-run reference changed. Prepare a new run instead of resuming or retrying it.");
      }
      return { inputs, authority: { run, quote }, materialization: { run, from, quote },
        body: generationBody(inputs, action.kind === "production-frame-run-start" ? "Start a frame run" : action.kind === "production-frame-run-resume" ? "Resume a frame run" : "Retry frame generation",
          "Immutable frames filed into the approved frame slots; replaced slots stay protected", [
            { label: "Run", value: `${run.id} · ${run.mode} · scene ${run.sceneId} v${run.sceneVersion}` },
            { label: "Continuation", value: `Only ${inputs.length} unsubmitted steps are authorized by this card.` },
            ...run.steps.slice(from).map(step => ({ label: step.label, value: `${step.updateShotIds.join(", ")} · ${step.dispatch.output.width} × ${step.dispatch.output.height} · ${step.grain}` })),
          ]) };
    },
    beforeDispatch: async (action, id, inputs, _materialization, at) => {
      if (action.kind === "production-scene-dispatch") {
        const sentShots = inputs.filter(input => input.params.audioReferences !== undefined).flatMap(input => input.target.coversShots ?? []);
        if (sentShots.length) await ports.planInput(action, id, at, sentShots);
      }
    },
    dispatch: async (action, id, inputs, materialization) => {
      const frozen = materialization as { run?: unknown; from?: number; quote?: unknown; plan?: unknown };
      if (action.kind === "production-scene-dispatch") {
        const plan = DispatchPlanSchema.parse(frozen.plan);
        const prepared = { ...plan, passes: plan.passes.map((pass, index) => ({ ...pass, compiled: { ...pass.compiled, params: inputs[index]!.params } })) };
        const input = await ports.planInput(action, id, plan.createdAt);
        const aggregate = await createDispatchPlan(store, { ...input, planId: plan.planId, idempotencyKeys: plan.passes.map(pass => pass.idempotencyKey),
          preparedPlan: prepared, clock: () => plan.createdAt });
        // The authority is durable even if its first enqueue needs queue reconciliation.
        await advancePlan(store, productionFor(action.productionId)!, store.getBundle(), aggregate, ports.planDeps()).catch(() => {});
        await ports.refresh(action.productionId);
        return { status: "queued", detail: `Scene plan ${aggregate.planId} authorized; its durable gates control further work.` };
      }
      if (!isFrameGeneration(action)) throw new Error("This is not a frame-run generation action.");
      const run = FrameRunSchema.parse(frozen.run);
      const from = frozen.from!;
      const prepared = { ...run, steps: run.steps.map((step, index) => index < from ? step : { ...step, dispatch: { ...step.dispatch, params: inputs[index - from]!.params } }) };
      const getProduction = () => productionFor(action.productionId);
      const jobById = (jobId: string) => ports.jobs().find(job => job.id === jobId);
      if (action.kind === "production-frame-run-start") {
        const quote = FrameRunQuoteSchema.parse(frozen.quote);
        const input = { ...await ports.frameInput(action, id, run.createdAt), runId: run.id, clock: () => run.createdAt };
        await startFrameRun(store, { preparedRun: prepared, quotedMicroUsd: quote.estimatedMicroUsd!, quoteSignature: quote.signature!,
          jobs: ports.jobs, consumeQuote: () => quote, compile: () => input });
      } else if (action.kind === "production-frame-run-resume") {
        await resumeFrameRun(store, action.productionId, action.runId, { authorizedRun: prepared });
      } else if (action.kind === "production-frame-run-retry-step") {
        await retryFrameStep(store, action.productionId, action.runId, action.stepIndex, getProduction, jobById, { authorizedRun: prepared });
      } else if (action.kind === "production-frame-run-retry-cell") {
        await retryFrameCell(store, action.productionId, action.runId, action.stepIndex, action.shotId, getProduction, jobById, { authorizedRun: prepared });
      } else throw new Error("The quoted batch action is unavailable.");
      await advanceFrameRun(store, action.productionId, run.id, ports.frameDeps()).catch(() => {});
      await ports.refresh(action.productionId, run.id);
      return { status: "queued", detail: `Frame run ${run.id} authorized; admission and progress remain in its durable record.` };
    },
    reconcile: async (card, action, inputs) => {
      if (action.kind === "production-scene-dispatch") {
        const plan = (await listPlans(store, action.productionId)).find(p => p.planId === `pl_${card.actionId.slice(4)}`);
        if (!plan) return absentAuthority(action.productionId, `pl_${card.actionId.slice(4)}`, "plans", inputs);
        const state = await planState(store, plan, ports.planDeps());
        if (state.status === "authorized" || state.status === "active") return { status: "running", detail: "Scene plan is active or awaiting its human continuation/reconfirmation gate." };
        return undefined;
      }
      if (!isFrameGeneration(action)) return null;
      const runId = action.kind === "production-frame-run-start" ? `fr_${card.actionId.slice(4)}` : action.runId;
      const run = runId && await readFrameRun(store, action.productionId, runId);
      if (!run) return absentAuthority(action.productionId, runId, "runs", inputs);
      const state = await frameRunState(store, action.productionId, run, ports.jobs());
      const ownJobs = inputs.map(input => ports.jobs().find(job => job.idempotencyKey === input.idempotencyKey));
      if ((state.status === "active" || state.status === "paused") && ownJobs.some(job => !job || !["succeeded", "failed", "cancelled"].includes(job.status))) return { status: "running", detail: `Frame run is ${state.status}; its existing authority owns continuation.` };
      if (inputs.length === 0) return { status: "completed", receipt: { kind: "frame-run", id: run.id, summary: "The existing run settled without another provider request." } };
      return undefined;
    },
  };
}

export class ProductionBatchControls {
  constructor(private readonly store: WorldStore, private readonly ports: ProductionBatchPorts) {}
  async prepare(action: ModelWorldChatAction): Promise<ArkeCommandBody> {
    if (action.kind === "production-plan-cancel") {
      const plan = (await listPlans(this.store, action.productionId)).find(p => p.planId === action.planId);
      if (!plan) throw new Error("The scene plan is unavailable.");
      return { family: "command", commands: [{ label: "Cancel scene plan", detail: `${plan.planId} · ${plan.policy} · ${plan.passes.length} passes` }],
        expectedResult: "Stops future plan work and asks active jobs to stop. Landed takes remain.", undoAvailable: false };
    }
    if (action.kind !== "production-frame-run-pause" && action.kind !== "production-frame-run-cancel") throw new Error("The frame-run control is unavailable.");
    const run = await readFrameRun(this.store, action.productionId, action.runId);
    if (!run) throw new Error("The frame run is unavailable.");
    return { family: "command", commands: [{ label: action.kind === "production-frame-run-pause" ? "Pause frame run" : "Cancel frame run",
      detail: `${run.id} · ${run.cursor}/${run.steps.length} admitted · paused ${run.paused} · cancelled ${run.cancelled}` }],
      expectedResult: action.kind === "production-frame-run-pause" ? "Stops future frame steps; the current job can finish." : "Stops future frame steps and asks active jobs to stop. Landed frames remain.", undoAvailable: false };
  }
  async execute(action: ModelWorldChatAction, actionId: string, precondition: WorldStatePrecondition) {
    if (!isControl(action)) throw new Error("This is not a production batch control.");
    const cancelIds: string[] = [];
    await this.store.gateOp(async () => {
      if (action.kind === "production-frame-run-pause") {
        if (!await pauseFrameRun(this.store, action.productionId, action.runId, { conversationActionId: actionId })) throw new Error("The frame run is unavailable.");
      } else if (action.kind === "production-frame-run-cancel") {
        if (!await cancelFrameRun(this.store, action.productionId, action.runId, { jobById: id => this.ports.jobs().find(job => job.id === id),
          cancel: async id => { cancelIds.push(id); } }, { conversationActionId: actionId })) throw new Error("The frame run is unavailable.");
      } else if (action.kind === "production-plan-cancel") {
        const plan = (await listPlans(this.store, action.productionId)).find(p => p.planId === action.planId);
        if (!plan) throw new Error("The plan is unavailable.");
        if (!(await readPlanEvents(this.store, action.productionId, action.planId)).some(event => event.kind === "cancelled" && event.requestId === actionId)) {
          await appendPlanEvents(this.store, action.productionId, action.planId, [{ kind: "cancelled", ts: this.store.now(), planId: action.planId, requestId: actionId }]);
        }
        const state = await planState(this.store, plan, this.ports.planDeps());
        cancelIds.push(...state.passes.flatMap(pass => pass.jobId && pass.state !== "succeeded" && pass.state !== "failed" ? [pass.jobId] : []));
      } else throw new Error("The production control is unavailable.");
    }, precondition);
    for (const jobId of cancelIds) await this.ports.cancel(jobId).catch(() => {});
    await this.ports.refresh(action.productionId, "runId" in action ? action.runId : undefined);
    return { status: "completed" as const, receipt: { kind: "production-control", id: action.kind === "production-plan-cancel" ? action.planId : action.runId,
      summary: "The reviewed control was applied; landed work remains available." } };
  }
  async reconcile(card: ConversationActionCard) {
    if (!card.productionId) return null;
    if (card.actionKind === "world-chat-production-plan-cancel") {
      const plan = (await listPlans(this.store, card.productionId)).find(p => p.planId === card.authority.id);
      if (!plan) return null;
      if (!(await readPlanEvents(this.store, card.productionId, plan.planId)).some(event => event.kind === "cancelled" && event.requestId === card.actionId)) return null;
      return this.execute({ kind: "production-plan-cancel", productionId: card.productionId, planId: plan.planId, checkReceiptIds: [] }, card.actionId, () => null);
    }
    if (card.actionKind !== "world-chat-production-frame-run-pause" && card.actionKind !== "world-chat-production-frame-run-cancel") return null;
    const run = await readFrameRun(this.store, card.productionId, card.authority.id);
    if (!run?.appliedConversationControls?.includes(card.actionId)) return null;
    if (card.actionKind === "world-chat-production-frame-run-cancel") return this.execute({ kind: "production-frame-run-cancel", productionId: card.productionId, runId: run.id, checkReceiptIds: [] }, card.actionId, () => null);
    return { status: "completed" as const, receipt: { kind: "production-control", id: run.id, summary: "The reviewed pause was applied; a later resume is retained." } };
  }
}
