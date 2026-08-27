import { z } from "zod";
import { IsoDateTimeSchema, PlanIdSchema, SceneIdSchema, SlugSchema, TakeIdSchema, UlidSchema } from "./ids.js";
import { frameDispatchFor, type ManifestModel } from "./manifest.js";
import type { CompiledPass } from "./pass-compiler.js";

/**
 * Durable scene-dispatch plans (SPEC-024; issues #391/#402).
 *
 * The aggregate is written once and never edited: it is the authorization record, and a record
 * that mutates cannot answer "what did the user approve" a month later. Progress lives in an
 * append-only events journal beside it, and plan state is a pure idempotent fold over the
 * aggregate, the events, and the queue journal's job facts — never a timer, never a screen.
 */

// ---------------------------------------------------------------------------
// The aggregate (R-1..R-8)
// ---------------------------------------------------------------------------

export const PlanPolicySchema = z.enum(["review-gated", "pre-authorized"]);
export type PlanPolicy = z.infer<typeof PlanPolicySchema>;

export const PassDependencySchema = z
  .object({
    passIndex: z.number().int().min(0),
    needs: z.enum(["boundary-frame", "completion"]),
  })
  .strict();
export type PassDependency = z.infer<typeof PassDependencySchema>;

/** The compiled pass, persisted verbatim (SPEC-024 D3) — loose on `params` by design. */
export const CompiledPassRecordSchema = z
  .object({
    target: z
      .object({ kind: z.enum(["shot", "scene-pass"]), id: z.string().min(1), coversShots: z.array(z.string()) })
      .strict(),
    model: z
      .object({
        id: z.string().min(1),
        provider: z.string().min(1),
        capability: z.string().min(1),
        displayName: z.string().min(1),
      })
      .strict(),
    route: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text") }).strict(),
      z.object({ kind: z.literal("reference") }).strict(),
      z
        .object({
          kind: z.literal("frame"),
          mode: z.enum(["first-frame", "first-and-last-frame"]),
          endpoint: z.string().nullable(),
        })
        .strict(),
      // The authorization record has to name the exact take the extension was approved against
      // (SPEC-019 R-50, R-53). Without it a plan replayed after a reselection would re-dispatch
      // against whatever is selected now, which is a different piece of footage and a different
      // request from the one the user authorized.
      z
        .object({
          kind: z.literal("continuation"),
          endpoint: z.string().nullable(),
          predecessorTakeId: TakeIdSchema,
        })
        .strict(),
    ]),
    params: z.record(z.string(), z.unknown()),
    references: z.array(
      z
        .object({
          index: z.number().int().min(1),
          file: z.string().min(1),
          sheetId: z.string().min(1),
          sheetVersion: z.number().int().min(1).nullable(),
          role: z.string().min(1),
          /*
           * Persisted with the rest of the compiled reference (design 67), and optional because
           * plans outlive the build that wrote them.
           *
           * The record is strict, so a field the compiler emits that this schema does not admit
           * is not a smaller record — it refuses the whole plan. Required, it refuses the other
           * direction too: every aggregate an older build wrote carrying a reference would fail
           * to parse, and `listPlans` skips what it cannot read. An unfinished chain would stop
           * being recovered, and `createDispatchPlan` dedupes on a requestId it finds through
           * that same listing — so a retry would author a second plan and spend again.
           *
           * Nothing reads either field back off a persisted plan; they are here so the record
           * stays the compiled object verbatim.
           */
          subject: z.string().min(1).optional(),
          mode: z.enum(["designated", "main-photo", "scoped-look", "sketch-citation"]).optional(),
        })
        .strict(),
    ),
    frame: z
      .object({ artifactId: z.string().min(1), file: z.string().min(1), hash: z.string().min(1) })
      .strict()
      .optional(),
    /*
     * The footage a continuation extends, persisted with the rest of the compiled object for the
     * reason the whole record is: it IS the compiled pass, and a strict schema that omits a field
     * the compiler emits does not store a smaller plan — it refuses the plan entirely, and
     * `listPlans` skips what it cannot read.
     *
     * Optional because plans outlive the build that wrote them, exactly as the reference fields
     * above are.
     */
    continuation: z
      .object({
        takeId: TakeIdSchema,
        fromShotId: z.string().min(1),
        fromShotNumber: z.number().int().min(1),
        mediaTakeId: TakeIdSchema,
        media: z.string().min(1),
        segment: z.object({ inSec: z.number().min(0), outSec: z.number().min(0) }).strict().optional(),
      })
      .strict()
      .optional(),
    askedSec: z.number().optional(),
    estimatedMicroUsd: z.number().int().min(0),
    dropped: z.array(
      z.object({ sheetId: z.string().min(1), role: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    sources: z
      .object({
        canonRevision: z.number().int().min(0),
        artDirectionVersion: z.number().int().min(0),
        sceneId: SceneIdSchema,
        sceneVersion: z.number().int().min(1),
        sheets: z.record(z.string(), z.number()),
      })
      .strict(),
    landing: z.object({ dir: z.string().min(1) }).strict(),
  })
  .strict();

export const PlanPassSchema = z
  .object({
    passIndex: z.number().int().min(0),
    /** Pre-allocated at plan creation (SPEC-024 D2), so a crash window has nothing to invent. */
    idempotencyKey: UlidSchema,
    dependsOn: z.array(PassDependencySchema),
    compiled: CompiledPassRecordSchema,
  })
  .strict();
export type PlanPass = z.infer<typeof PlanPassSchema>;

export const DispatchPlanSchema = z
  .object({
    planId: PlanIdSchema,
    /** The creating command's idempotency (SPEC-024 R-12): redelivery finds this plan. */
    requestId: UlidSchema,
    worldId: UlidSchema,
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    mode: z.enum(["per-shot", "whole-scene"]),
    policy: PlanPolicySchema,
    /** The number the user confirmed (R-15): the sum of pass estimates at authorization. */
    capMicroUsd: z.number().int().min(0),
    sources: z
      .object({
        canonRevision: z.number().int().min(0),
        artDirectionVersion: z.number().int().min(0),
        sceneVersion: z.number().int().min(1),
        sheets: z.record(z.string(), z.number()),
        aspect: z.string().optional(),
        modelId: z.string().min(1),
      })
      .strict(),
    passes: z.array(PlanPassSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type DispatchPlan = z.infer<typeof DispatchPlanSchema>;

// ---------------------------------------------------------------------------
// The events journal (R-9..R-11)
// ---------------------------------------------------------------------------

export const PlanEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authorized"), ts: IsoDateTimeSchema, planId: PlanIdSchema }).strict(),
  z
    .object({
      kind: z.literal("pass-materialised"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      /** The completed exact-sent bag, late frame fields bound (R-19). */
      params: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pass-enqueued"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      jobId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pass-succeeded"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      takeId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pass-failed"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("boundary-extracted"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      artifactId: z.string().min(1),
      hash: z.string().min(1),
      file: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("boundary-failed"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("continue-approved"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconfirm-required"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
      authorizedMicroUsd: z.number().int().min(0),
      currentMicroUsd: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconfirmed"),
      ts: IsoDateTimeSchema,
      planId: PlanIdSchema,
      passIndex: z.number().int().min(0),
    })
    .strict(),
  z
    .object({ kind: z.literal("cancelled"), ts: IsoDateTimeSchema, planId: PlanIdSchema, reason: z.string().optional() })
    .strict(),
  z
    .object({ kind: z.literal("stale"), ts: IsoDateTimeSchema, planId: PlanIdSchema, reason: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("completed"), ts: IsoDateTimeSchema, planId: PlanIdSchema }).strict(),
]);
export type PlanEvent = z.infer<typeof PlanEventSchema>;

/** What the fold accepts: parsed events, plus anything future — unknown kinds change nothing (R-10). */
export type PlanEventLike = { kind: string; passIndex?: number; [key: string]: unknown };

// ---------------------------------------------------------------------------
// The fold (R-10, R-21..R-23)
// ---------------------------------------------------------------------------

/** The queue facts the fold joins on — a projection of SPEC-009's job record, never a copy. */
export interface PlanJobFacts {
  id: string;
  status: "queued" | "submitting" | "running" | "succeeded" | "failed" | "cancelled" | "needs-reconciliation";
}

export type PassStateKind =
  | "compiled"
  | "materialised"
  | "enqueued"
  | "waiting-reconciliation"
  | "succeeded"
  | "failed"
  | "blocked"
  | "halted";

export interface PassState {
  passIndex: number;
  state: PassStateKind;
  jobId?: string;
  takeId?: string;
  boundFrame?: { artifactId: string; hash: string; file: string };
  reason?: string;
  estimatedMicroUsd: number;
}

export type PlanNextAction =
  | { kind: "enqueue"; passIndex: number }
  | { kind: "extract-boundary"; passIndex: number; fromPassIndex: number }
  | { kind: "materialise"; passIndex: number }
  | { kind: "await-continue"; passIndex: number }
  | { kind: "await-reconfirm"; passIndex: number }
  | { kind: "none" };

export interface PlanState {
  planId: string;
  productionId: string;
  sceneId: string;
  mode: DispatchPlan["mode"];
  policy: PlanPolicy;
  capMicroUsd: number;
  status: "authorized" | "active" | "cancelled" | "stale" | "completed";
  haltReason?: string;
  passes: PassState[];
  /** Estimates of every pass that has been materialised — what pre-authorization has spent. */
  spentEstimateMicroUsd: number;
  /** The single durable action a driver should take next. Deterministic; never a guess. */
  next: PlanNextAction;
}

/**
 * Plan state, folded (SPEC-024 R-10): pure, idempotent, and indifferent to replay or unknown
 * event kinds. The queue journal is joined, never mirrored (D7) — a job's own status is the
 * submission truth, and the fold only reads it.
 */
export function foldPlan(
  plan: DispatchPlan,
  events: readonly PlanEventLike[],
  jobs: readonly PlanJobFacts[],
): PlanState {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const byPass = new Map<number, { events: PlanEventLike[] }>();
  let cancelled: string | undefined;
  let stale: string | undefined;
  let authorized = false;
  for (const event of events) {
    if (event.kind === "authorized") authorized = true;
    else if (event.kind === "cancelled") cancelled = (event["reason"] as string | undefined) ?? "cancelled";
    else if (event.kind === "stale") stale = event["reason"] as string;
    else if (typeof event.passIndex === "number") {
      const slot = byPass.get(event.passIndex) ?? { events: [] };
      slot.events.push(event);
      byPass.set(event.passIndex, slot);
    }
  }
  const halted = cancelled !== undefined || stale !== undefined;

  const passes: PassState[] = plan.passes.map((pass) => {
    const its = byPass.get(pass.passIndex)?.events ?? [];
    const has = (kind: string) => its.some((event) => event.kind === kind);
    const last = (kind: string) => [...its].reverse().find((event) => event.kind === kind);
    const enqueued = last("pass-enqueued");
    const jobId = enqueued?.["jobId"] as string | undefined;
    const job = jobId !== undefined ? jobById.get(jobId) : undefined;
    const boundary = last("boundary-extracted");
    const boundFrame =
      boundary !== undefined
        ? {
            artifactId: boundary["artifactId"] as string,
            hash: boundary["hash"] as string,
            file: boundary["file"] as string,
          }
        : undefined;
    const base = {
      passIndex: pass.passIndex,
      estimatedMicroUsd: pass.compiled.estimatedMicroUsd,
      ...(jobId !== undefined ? { jobId } : {}),
      ...(boundFrame !== undefined ? { boundFrame } : {}),
    };
    // Outcomes first: a terminal fact outranks every intermediate mark, replayed or not.
    const succeededEvent = last("pass-succeeded");
    if (succeededEvent !== undefined || job?.status === "succeeded") {
      return {
        ...base,
        state: "succeeded" as const,
        ...(succeededEvent?.["takeId"] !== undefined ? { takeId: succeededEvent["takeId"] as string } : {}),
      };
    }
    if (has("pass-failed") || job?.status === "failed" || job?.status === "cancelled") {
      const failure = last("pass-failed");
      return { ...base, state: "failed" as const, reason: (failure?.["reason"] as string) ?? "the job failed" };
    }
    if (job?.status === "needs-reconciliation") {
      return { ...base, state: "waiting-reconciliation" as const, reason: "landed work awaits finalization" };
    }
    if (jobId !== undefined && job === undefined) {
      // The journalled job is gone — deleted from Activity's history. A durable pass-succeeded
      // was checked FIRST above, so tidying a finished plan's jobs never rewrites its outcomes;
      // without one, the pass ends here rather than letting its pre-allocated key become a
      // fresh spend.
      return { ...base, state: "failed" as const, reason: `job ${jobId} is gone from the queue's history` };
    }
    if (jobId !== undefined) return { ...base, state: "enqueued" as const };
    if (has("pass-materialised")) return { ...base, state: "materialised" as const };
    if (has("boundary-failed") && boundFrame === undefined) {
      const failure = last("boundary-failed");
      return { ...base, state: "blocked" as const, reason: failure?.["reason"] as string };
    }
    if (halted) {
      return { ...base, state: "halted" as const, reason: cancelled ?? stale! };
    }
    return { ...base, state: "compiled" as const };
  });

  const stateOf = new Map(passes.map((pass) => [pass.passIndex, pass]));
  const spentEstimateMicroUsd = passes
    .filter((pass) => pass.state !== "compiled" && pass.state !== "halted" && pass.state !== "blocked")
    .reduce((sum, pass) => sum + pass.estimatedMicroUsd, 0);

  // The next durable action, in pass order: the first pass that can move, moves (R-14, R-18).
  let next: PlanNextAction = { kind: "none" };
  if (!halted) {
    for (const pass of plan.passes) {
      const state = stateOf.get(pass.passIndex)!;
      if (state.state === "materialised") {
        // Money gates outrank mechanics even here: a reconfirmation outstanding on an
        // already-materialised pass must stop the enqueue, not be skipped past by it.
        const its = byPass.get(pass.passIndex)?.events ?? [];
        const gated =
          its.some((event) => event.kind === "reconfirm-required") &&
          !its.some((event) => event.kind === "reconfirmed");
        next = gated
          ? { kind: "await-reconfirm", passIndex: pass.passIndex }
          : { kind: "enqueue", passIndex: pass.passIndex };
        break;
      }
      // Blocked is user-recoverable (R-18): the next advance retries extraction rather than
      // abandoning the pass — the reason stays visible until it succeeds or the plan is cancelled.
      if (state.state !== "compiled" && state.state !== "blocked") continue;
      const deps = pass.dependsOn.map((dep) => ({ dep, state: stateOf.get(dep.passIndex)! }));
      if (deps.some(({ state: depState }) => depState.state === "failed")) continue; // never past a failed dependency (R-22)
      if (!deps.every(({ state: depState }) => depState.state === "succeeded")) continue; // not ready yet
      const its = byPass.get(pass.passIndex)?.events ?? [];
      const has = (kind: string) => its.some((event) => event.kind === kind);
      // Money gates before mechanics: a reconfirmation outstanding stops everything for this pass.
      if (has("reconfirm-required") && !has("reconfirmed")) {
        next = { kind: "await-reconfirm", passIndex: pass.passIndex };
        break;
      }
      if (
        plan.policy === "pre-authorized" &&
        !has("reconfirmed") &&
        spentEstimateMicroUsd + pass.compiled.estimatedMicroUsd > plan.capMicroUsd
      ) {
        next = { kind: "await-reconfirm", passIndex: pass.passIndex };
        break;
      }
      if (plan.policy === "review-gated" && pass.dependsOn.length > 0 && !has("continue-approved")) {
        next = { kind: "await-continue", passIndex: pass.passIndex };
        break;
      }
      const needsFrame = pass.dependsOn.find((dep) => dep.needs === "boundary-frame");
      if (needsFrame !== undefined && state.boundFrame === undefined) {
        next = { kind: "extract-boundary", passIndex: pass.passIndex, fromPassIndex: needsFrame.passIndex };
        break;
      }
      next = { kind: "materialise", passIndex: pass.passIndex };
      break;
    }
  }

  const terminal = (state: PassStateKind) => state === "succeeded" || state === "failed" || state === "halted";
  const settled =
    passes.every((pass) => terminal(pass.state)) ||
    (next.kind === "none" &&
      passes.every(
        (pass) => terminal(pass.state) || pass.state === "compiled" /* unreachable behind a failure */,
      ));
  const status: PlanState["status"] = cancelled !== undefined
    ? "cancelled"
    : stale !== undefined
      ? "stale"
      : settled
        ? "completed"
        : authorized
          ? passes.some((pass) => pass.state !== "compiled")
            ? "active"
            : "authorized"
          : "authorized";

  return {
    planId: plan.planId,
    productionId: plan.productionId,
    sceneId: plan.sceneId,
    mode: plan.mode,
    policy: plan.policy,
    capMicroUsd: plan.capMicroUsd,
    status,
    ...(cancelled !== undefined || stale !== undefined ? { haltReason: cancelled ?? stale! } : {}),
    passes,
    spentEstimateMicroUsd,
    next,
  };
}

// ---------------------------------------------------------------------------
// Dependency derivation and late frame binding (R-5, R-6, R-19)
// ---------------------------------------------------------------------------

/**
 * The chain a plan declares (SPEC-024 R-5): whole-scene passes on a model with a first-frame
 * route chain each pass behind the previous pass's boundary frame — the continuity the plan
 * exists to hold. Everything else dispatches independent passes, exactly as it does today.
 */
export function chainedDependencies(
  mode: "per-shot" | "whole-scene",
  model: ManifestModel,
  passCount: number,
): PassDependency[][] {
  const chains =
    mode === "whole-scene" && model.capability === "video" && passCount > 1 && frameDispatchFor(model, 1) !== null;
  return Array.from({ length: passCount }, (_, index) =>
    chains && index > 0 ? [{ passIndex: index - 1, needs: "boundary-frame" as const }] : [],
  );
}

/**
 * Bind the late frame fields into a compiled pass's params (R-19). The aggregate is untouched;
 * the completed bag lands in the `pass-materialised` event and the job. The compiler already
 * set the mode and route at authorization — this adds only what could not exist yet.
 */
export function bindPassFrame(
  compiled: Pick<CompiledPass, "params" | "route">,
  frame: { artifactId: string; hash: string; file: string },
): Record<string, unknown> {
  if (compiled.route.kind !== "frame") {
    throw new Error("only a frame-routed pass binds a boundary frame");
  }
  return {
    ...compiled.params,
    references: [frame.file],
    taskMode: compiled.route.mode,
    ...(compiled.route.endpoint !== null ? { route: compiled.route.endpoint } : {}),
    startFrame: frame.file,
    frameArtifact: { id: frame.artifactId, hash: frame.hash },
  };
}
