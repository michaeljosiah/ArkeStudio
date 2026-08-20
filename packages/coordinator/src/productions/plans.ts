/**
 * Durable scene-dispatch plans (SPEC-024; issue #402).
 *
 * The aggregate is written once, atomically, before any network I/O; progress is an append-only
 * events journal fsynced before the action each event authorises; and everything a driver does
 * here is a fold followed by exactly one durable act, repeated — so a crash between any two
 * lines is recovered by running the same driver again, which is precisely what world open does.
 */

import { mkdir, open as openFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bindPassFrame,
  chainedDependencies,
  compilePasses,
  DispatchPlanSchema,
  foldPlan,
  ulid,
  type DispatchPlan,
  type ManifestModel,
  type PlanEventLike,
  type PlanJobFacts,
  type PlanPolicy,
  type PlanState,
  type ProductionBundle,
  type Scene,
  type ScenePlan,
  type Take,
  type WorldBundle,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { extractBoundaryArtifact, type BoundaryFrameMaker } from "../takes/boundary.js";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

function plansDir(store: WorldStore, productionId: string): string {
  return join(store.dir, "productions", productionId, "plans");
}

/** Append events, fsynced before the caller acts on them (SPEC-024 R-9, SPEC-009 D1). */
export async function appendPlanEvents(
  store: WorldStore,
  productionId: string,
  planId: string,
  events: readonly PlanEventLike[],
): Promise<void> {
  const dir = plansDir(store, productionId);
  await mkdir(toExtendedLength(dir), { recursive: true });
  const handle = await openFile(toExtendedLength(join(dir, `${planId}.events.jsonl`)), "a");
  try {
    await handle.writeFile(events.map((event) => JSON.stringify(event) + "\n").join(""), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readPlanEvents(
  store: WorldStore,
  productionId: string,
  planId: string,
): Promise<PlanEventLike[]> {
  try {
    const raw = await readFile(toExtendedLength(join(plansDir(store, productionId), `${planId}.events.jsonl`)), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        // A malformed line is skipped, never fatal (R-10): the fold is indifferent to what it
        // does not understand, and a journal that refuses to load is a plan nobody can finish.
        try {
          return [JSON.parse(line) as PlanEventLike];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function listPlans(store: WorldStore, productionId: string): Promise<DispatchPlan[]> {
  let files: string[];
  try {
    files = await readdir(toExtendedLength(plansDir(store, productionId)));
  } catch {
    return [];
  }
  const plans: DispatchPlan[] = [];
  for (const file of files.filter((f) => f.endsWith(".json") && !f.endsWith(".events.jsonl"))) {
    try {
      const raw = await readFile(toExtendedLength(join(plansDir(store, productionId), file)), "utf8");
      plans.push(DispatchPlanSchema.parse(JSON.parse(raw)));
    } catch {
      /* an unreadable aggregate is skipped; its journal stays on disk for a build that can read it */
    }
  }
  return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface CreatePlanInput {
  worldId: string;
  productionId: string;
  scene: Scene;
  plan: ScenePlan;
  model: ManifestModel;
  world: WorldBundle;
  policy: PlanPolicy;
  /** The creating command's idempotency (SPEC-024 R-12): redelivery finds the existing plan. */
  requestId: string;
  clock: () => string;
}

/**
 * Create the durable plan (R-12..R-15): compile, write the aggregate atomically, append
 * `authorized` — all before any pass may reach a provider. Idempotent by requestId.
 */
export async function createDispatchPlan(store: WorldStore, input: CreatePlanInput): Promise<DispatchPlan> {
  const existing = (await listPlans(store, input.productionId)).find((plan) => plan.requestId === input.requestId);
  if (existing !== undefined) return existing;

  // Compilation refuses what dispatch would refuse (R-13) — a plan that could not compile does
  // not exist. Whole-scene passes chain behind boundary frames where the model has a route.
  const compiled = compilePasses({
    productionId: input.productionId,
    scene: input.scene,
    plan: input.plan,
    model: input.model,
    world: input.world,
    chainWholeSceneFrames: input.plan.mode === "whole-scene",
  });
  if (compiled.length === 0) throw new Error("nothing to dispatch — the plan compiled no passes");
  const dependencies = chainedDependencies(input.plan.mode, input.model, compiled.length);
  const aggregate: DispatchPlan = DispatchPlanSchema.parse({
    planId: `pl_${ulid()}`,
    requestId: input.requestId,
    worldId: input.worldId,
    productionId: input.productionId,
    sceneId: input.scene.id,
    mode: input.plan.mode,
    policy: input.policy,
    // The number the user confirmed (R-15): the sum of every pass's estimate at authorization.
    capMicroUsd: compiled.reduce((sum, pass) => sum + pass.estimatedMicroUsd, 0),
    sources: {
      canonRevision: input.world.meta.canonRevision,
      artDirectionVersion: input.world.artDirection.version,
      sceneVersion: input.scene.version,
      sheets: Object.fromEntries(
        [...new Set(compiled.flatMap((pass) => Object.keys(pass.sources.sheets)))].map((sheetId) => [
          sheetId,
          compiled.find((pass) => pass.sources.sheets[sheetId] !== undefined)!.sources.sheets[sheetId]!,
        ]),
      ),
      ...(input.plan.aspect !== undefined ? { aspect: input.plan.aspect } : {}),
      modelId: input.model.id,
    },
    passes: compiled.map((pass, passIndex) => ({
      passIndex,
      idempotencyKey: ulid(),
      dependsOn: dependencies[passIndex]!,
      compiled: pass,
    })),
    createdAt: input.clock(),
  });
  await mkdir(toExtendedLength(plansDir(store, input.productionId)), { recursive: true });
  await atomicWriteFile(join(plansDir(store, input.productionId), `${aggregate.planId}.json`), // atomic: temp + rename
    JSON.stringify(aggregate, null, 2) + "\n");
  await appendPlanEvents(store, input.productionId, aggregate.planId, [
    { kind: "authorized", ts: input.clock(), planId: aggregate.planId },
  ]);
  return aggregate;
}

export interface PlanDriverDeps {
  enqueue: (input: EnqueueInput) => Promise<{ id: string }>;
  jobFacts: (jobIds: readonly string[]) => PlanJobFacts[];
  boundaryFrameMaker?: BoundaryFrameMaker | undefined;
  clock: () => string;
  onRefused?: (planId: string, reason: string) => void;
  /**
   * The current bundle, re-read per loop iteration when provided: a long advance holding its
   * caller's snapshot kept enqueueing against sources that moved after the fold began (R-24).
   */
  fresh?: () => WorldBundle | undefined;
}

/** The folded state of one plan, from disk and the queue — never from memory (R-10). */
export async function planState(
  store: WorldStore,
  plan: DispatchPlan,
  deps: Pick<PlanDriverDeps, "jobFacts">,
): Promise<PlanState> {
  const events = await readPlanEvents(store, plan.productionId, plan.planId);
  const jobIds = events.flatMap((event) => (event.kind === "pass-enqueued" ? [event["jobId"] as string] : []));
  return foldPlan(plan, events, deps.jobFacts(jobIds));
}

/**
 * What moved since authorization, or null (R-24). Checked at every advance: running passes
 * finish elsewhere; nothing new materialises against sources nobody reviewed.
 */
function sourceDrift(plan: DispatchPlan, production: ProductionBundle, world: WorldBundle): string | null {
  const scene = production.scenes.find((candidate) => candidate.id === plan.sceneId);
  if (scene === undefined) return `scene ${plan.sceneId} is gone`;
  if (scene.version !== plan.sources.sceneVersion) {
    return `the scene moved v${plan.sources.sceneVersion} → v${scene.version}`;
  }
  if (world.meta.canonRevision !== plan.sources.canonRevision) {
    return `canon moved r${plan.sources.canonRevision} → r${world.meta.canonRevision}`;
  }
  if (world.artDirection.version !== plan.sources.artDirectionVersion) {
    return `art direction moved v${plan.sources.artDirectionVersion} → v${world.artDirection.version}`;
  }
  for (const [sheetId, version] of Object.entries(plan.sources.sheets)) {
    const sheet = world.sheets.find((candidate) => candidate.id === sheetId);
    if (sheet === undefined) return `${sheetId} is gone`;
    if (sheet.version !== version) return `${sheetId} moved v${version} → v${sheet.version}`;
  }
  if ((production.meta.aspect ?? undefined) !== plan.sources.aspect) {
    return `the delivery aspect moved ${plan.sources.aspect ?? "unset"} → ${production.meta.aspect ?? "unset"}`;
  }
  return null;
}

/**
 * Fold, act once, repeat (R-14, R-18..R-20): each loop appends its event durably before the
 * action it authorises, so the crash windows of SPEC-024 §2.4 all land back here on reopen.
 * Stops on `none` or an await — the awaits are the user's, not a timer's.
 */
export async function advancePlan(
  store: WorldStore,
  production: ProductionBundle,
  world: WorldBundle,
  plan: DispatchPlan,
  deps: PlanDriverDeps,
): Promise<PlanState> {
  for (let guard = 0; guard < plan.passes.length * 4 + 4; guard++) {
    const state = await planState(store, plan, deps);
    if (state.status === "cancelled" || state.status === "stale" || state.status === "completed") return state;
    // Staleness gates every forward act (R-24), against the freshest sources the caller can
    // give — a snapshot held across a long advance is exactly how a moved scene keeps spending.
    // Without a fresh reader, the caller's own snapshot is the truth; overriding it from an
    // older bundle would un-move the very sources the caller just saw move.
    const refreshed = deps.fresh?.();
    const currentWorld = refreshed ?? world;
    const currentProduction = refreshed
      ? (refreshed.productions.find((candidate) => candidate.meta.id === plan.productionId) ?? production)
      : production;
    const drift = sourceDrift(plan, currentProduction, currentWorld);
    if (drift !== null) {
      await appendPlanEvents(store, plan.productionId, plan.planId, [
        { kind: "stale", ts: deps.clock(), planId: plan.planId, reason: drift },
      ]);
      return planState(store, plan, deps);
    }
    const next = state.next;
    if (next.kind === "none" || next.kind === "await-continue" || next.kind === "await-reconfirm") {
      if (next.kind === "await-reconfirm") {
        const pass = plan.passes[next.passIndex]!;
        const events = await readPlanEvents(store, plan.productionId, plan.planId);
        const already = events.some(
          (event) => event.kind === "reconfirm-required" && event.passIndex === next.passIndex,
        );
        if (!already) {
          await appendPlanEvents(store, plan.productionId, plan.planId, [
            {
              kind: "reconfirm-required",
              ts: deps.clock(),
              planId: plan.planId,
              passIndex: next.passIndex,
              authorizedMicroUsd: plan.capMicroUsd,
              currentMicroUsd: state.spentEstimateMicroUsd + pass.compiled.estimatedMicroUsd,
            },
          ]);
        }
      }
      return state;
    }
    const pass = plan.passes[next.kind === "extract-boundary" ? next.passIndex : next.passIndex]!;

    if (next.kind === "extract-boundary") {
      const dependencyState = state.passes[next.fromPassIndex]!;
      const sourceTake = findPrimaryTake(currentProduction, dependencyState.jobId);
      if (sourceTake === null) {
        // The queue says succeeded but the scan has not surfaced the take yet — a transient
        // window, not a failure. Appending boundary-failed here wrote durable noise on every
        // race; waiting costs nothing, because the next trigger (job settle, world open, a
        // plan frame) advances again.
        return state;
      }
      const extracted = await extractBoundaryArtifact(store, currentProduction, {
        take: sourceTake,
        label: `${plan.planId}-pass-${next.passIndex}`,
        maker: deps.boundaryFrameMaker,
        clock: deps.clock,
      });
      await appendPlanEvents(store, plan.productionId, plan.planId, [
        extracted.ok
          ? {
              kind: "boundary-extracted",
              ts: deps.clock(),
              planId: plan.planId,
              passIndex: next.passIndex,
              artifactId: extracted.artifactId,
              hash: extracted.hash,
              file: extracted.file,
            }
          : {
              kind: "boundary-failed",
              ts: deps.clock(),
              planId: plan.planId,
              passIndex: next.passIndex,
              // The source is named (R-18): retry extraction or cancel, never dispatch frameless.
              reason: extracted.reason,
            },
      ]);
      if (!extracted.ok) return planState(store, plan, deps);
      continue;
    }

    if (next.kind === "materialise") {
      const passState = state.passes[next.passIndex]!;
      const params =
        pass.compiled.route.kind === "frame" && pass.dependsOn.some((dep) => dep.needs === "boundary-frame")
          ? bindPassFrame(pass.compiled, passState.boundFrame!)
          : pass.compiled.params;
      await appendPlanEvents(store, plan.productionId, plan.planId, [
        {
          kind: "pass-materialised",
          ts: deps.clock(),
          planId: plan.planId,
          passIndex: next.passIndex,
          params,
        },
      ]);
      continue;
    }

    // next.kind === "enqueue": the materialised bag is the exact-sent record (R-19); the job
    // carries the plan linkage so the take answers "which authorization spent this" (R-26).
    const events = await readPlanEvents(store, plan.productionId, plan.planId);
    const materialised = [...events]
      .reverse()
      .find((event) => event.kind === "pass-materialised" && event.passIndex === next.passIndex);
    const params = (materialised?.["params"] as Record<string, unknown>) ?? pass.compiled.params;
    try {
      const job = await deps.enqueue({
        worldId: plan.worldId,
        productionId: plan.productionId,
        target: pass.compiled.target,
        capability: pass.compiled.model.capability as EnqueueInput["capability"],
        provider: pass.compiled.model.provider,
        model: pass.compiled.model.id,
        params: { ...params, planId: plan.planId, passIndex: next.passIndex },
        estimatedMicroUsd: pass.compiled.estimatedMicroUsd,
        landing: pass.compiled.landing,
        idempotencyKey: pass.idempotencyKey,
      });
      await appendPlanEvents(store, plan.productionId, plan.planId, [
        { kind: "pass-enqueued", ts: deps.clock(), planId: plan.planId, passIndex: next.passIndex, jobId: job.id },
      ]);
    } catch (error) {
      // A refused enqueue is a named halt for this pass, not a silent retry loop (R-20): the
      // materialised event stands, and the next advance — user-initiated or on reopen — retries
      // with the same idempotency key.
      deps.onRefused?.(plan.planId, error instanceof Error ? error.message : String(error));
      return planState(store, plan, deps);
    }
  }
  return planState(store, plan, deps);
}

/**
 * The primary take THIS plan's job landed — by jobId alone. A covers-shots fallback picked up
 * a previous dispatch's footage for the same scene, permanently chaining the next pass off a
 * clip nobody just paid for; a take not visible yet is a wait, never a guess.
 */
function findPrimaryTake(production: ProductionBundle, jobId: string | undefined): Take | null {
  if (jobId === undefined) return null;
  return production.takes.find((take) => take.jobId === jobId && take.segment === undefined) ?? null;
}

/** Advance every plan in a production that can move — world open's reconciliation (T-19). */
export async function advanceAllPlans(
  store: WorldStore,
  production: ProductionBundle,
  world: WorldBundle,
  deps: PlanDriverDeps,
): Promise<PlanState[]> {
  const plans = await listPlans(store, production.meta.id);
  const states: PlanState[] = [];
  for (const plan of plans) {
    states.push(await advancePlan(store, production, world, plan, deps));
  }
  return states;
}
