import { z } from "zod";
import {
  FrameRunIdSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  SceneIdSchema,
  ShotIdSchema,
  SlugSchema,
  UlidSchema,
} from "./ids.js";
import { JobFailureClassSchema, JobStatusSchema, JobTargetSchema } from "./job.js";
import { JobEngineIdentitySchema, RecipeIdentitySchema } from "./comfyui.js";
import { parseAspect } from "./manifest.js";

const ImageOutputSchema = z
  .object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    aspect: z.string().min(1),
    resolution: z.string().min(1).optional(),
  })
  .strict();

export const FrameBoardLayoutSchema = z
  .object({
    columns: z.union([z.literal(2), z.literal(3)]),
    rows: z.number().int().min(1),
    canvasWidth: z.number().int().min(1),
    canvasHeight: z.number().int().min(1),
    regions: z.array(
      z.object({
        panel: z.number().int().min(1),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }).strict(),
    ).min(1),
  })
  .strict()
  .superRefine((layout, ctx) => {
    for (const [index, region] of layout.regions.entries()) {
      if (region.panel !== index + 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["regions", index, "panel"], message: "regions must be in panel order" });
      }
      if (region.x + region.width > layout.canvasWidth || region.y + region.height > layout.canvasHeight) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["regions", index], message: "panel region must fit the canvas" });
      }
    }
  });
export type FrameBoardLayout = z.infer<typeof FrameBoardLayoutSchema>;

/** A step's inputs, frozen when the dialog's confirm authorized them (SPEC-036 §2.7). */
export const FrameStepRequestSchema = z
  .object({
    prompt: z.string().min(1),
    panels: z.array(
      z
        .object({
          panel: z.number().int().min(1),
          shotId: ShotIdSchema,
          role: z.enum(["update", "fixed"]),
          fixedImage: z
            .object({
              source: z.enum(["take", "artifact"]),
              id: z.string().min(1),
              path: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .superRefine((panel, ctx) => {
          if (panel.role === "fixed" && panel.fixedImage === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedImage"], message: "a fixed panel requires its frozen image" });
          }
          if (panel.role === "update" && panel.fixedImage !== undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedImage"], message: "an update panel has no fixed image" });
          }
        }),
    ),
    references: z.array(
      z
        .object({
          sheetId: SlugSchema,
          version: z.number().int().min(1),
          path: z.string().min(1),
        })
        .strict(),
    ),
    /** Immutable generated sheets used to condition a cell retry. */
    contextImages: z
      .array(
        z
          .object({
            source: z.literal("board-sheet"),
            jobId: JobIdSchema,
            path: z.string().min(1),
            hash: z.string().regex(/^sha256:[0-9a-f]{16}$/),
          })
          .strict(),
      )
      .optional(),
    droppedReferences: z.array(
      z.object({ path: z.string().min(1), reason: z.string().min(1) }).strict(),
    ).default([]),
    provenance: z
      .object({
        canonRevision: z.number().int().min(0),
        artDirectionVersion: z.number().int().min(1),
      })
      .strict(),
    layout: FrameBoardLayoutSchema.optional(),
    aspect: z.string().min(1),
    slotAtAuthorization: z.record(ShotIdSchema, z.string().nullable()),
  })
  .strict();
export type FrameStepRequest = z.infer<typeof FrameStepRequestSchema>;

export const FrameStepDispatchSchema = z
  .object({
    worldId: UlidSchema,
    productionId: SlugSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    capability: z.literal("image"),
    target: JobTargetSchema,
    references: z.array(z.string().min(1)),
    referenceCapacity: z.number().int().min(0),
    output: ImageOutputSchema,
    /** Provider-supported single-image output frozen for any cell retry. */
    routeOutput: ImageOutputSchema,
    /** Production-aspect output for one panel; board `output` is the whole sheet. */
    cellOutput: ImageOutputSchema,
    estimatedMicroUsd: z.number().int().min(0),
    cellEstimatedMicroUsd: z.number().int().min(0),
    params: z.record(z.string(), z.unknown()),
    landing: z.object({ dir: z.string().min(1), name: z.string().min(1) }).strict(),
    idempotencyKey: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    recipe: RecipeIdentitySchema.optional(),
    engine: JobEngineIdentitySchema.optional(),
  })
  .strict()
  .superRefine((dispatch, ctx) => {
    if (dispatch.references.length > dispatch.referenceCapacity) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["references"], message: "references exceed the frozen capacity" });
    }
  });
export type FrameStepDispatch = z.infer<typeof FrameStepDispatchSchema>;

export const FrameRunStepSchema = z
  .object({
    label: z.string().min(1),
    requestShotIds: z.array(ShotIdSchema).min(1),
    updateShotIds: z.array(ShotIdSchema).min(1),
    request: FrameStepRequestSchema,
    dispatch: FrameStepDispatchSchema,
    /** The original creative source; initial steps point to themselves. */
    sourceStepIndex: z.number().int().min(0),
    grain: z.enum(["initial", "step-retry", "cell-retry"]),
    /** The attempt this retry directly descends from. */
    retryOf: z.number().int().min(0).optional(),
    jobId: JobIdSchema.nullable(),
    landingOutcomes: z.record(ShotIdSchema, z.enum(["filed", "superseded"])).default({}),
  })
  .strict()
  .superRefine((step, ctx) => {
    const request = step.requestShotIds;
    const updates = new Set(step.updateShotIds);
    if (new Set(request).size !== request.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requestShotIds"], message: "request shots must be unique" });
    }
    if (updates.size !== step.updateShotIds.length || step.updateShotIds.some((id) => !request.includes(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["updateShotIds"], message: "update shots must be a unique subset of request shots" });
    }
    if (
      step.request.panels.length !== request.length ||
      step.request.panels.some((panel, index) => panel.panel !== index + 1 || panel.shotId !== request[index])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "panels"], message: "panels must exactly map request shots in order" });
    }
    const panelUpdates = step.request.panels.filter((panel) => panel.role === "update").map((panel) => panel.shotId);
    if (panelUpdates.length !== step.updateShotIds.length || panelUpdates.some((id, index) => id !== step.updateShotIds[index])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["updateShotIds"], message: "update shots must match update panels" });
    }
    const slotKeys = Object.keys(step.request.slotAtAuthorization);
    if (slotKeys.length !== updates.size || slotKeys.some((id) => !updates.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "slotAtAuthorization"], message: "slot snapshots must exactly cover update shots" });
    }
    if (step.request.layout !== undefined && step.request.panels.length > step.request.layout.columns * step.request.layout.rows) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "layout"], message: "layout cannot hold every panel" });
    }
    if (step.request.layout !== undefined) {
      const expectedColumns = step.request.panels.length <= 4 ? 2 : 3;
      if (step.request.layout.columns !== expectedColumns) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "layout", "columns"], message: "board layout is two columns through four panels and three beyond" });
      }
      if (step.request.layout.regions.length !== step.request.panels.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "layout", "regions"], message: "layout requires one region per panel" });
      }
      const ratio = parseAspect(step.request.aspect);
      if (ratio === null || step.request.layout.regions.some((region) => Math.abs(region.width / region.height - ratio) > 0.000001)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "layout", "regions"], message: "every panel region must preserve production aspect" });
      }
    }
    if (step.dispatch.routeOutput.aspect !== step.request.aspect) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "routeOutput", "aspect"], message: "route output must preserve production aspect" });
    }
    if (step.dispatch.cellOutput.aspect !== step.request.aspect) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "cellOutput", "aspect"], message: "cell crop must preserve production aspect" });
    }
    if (step.request.layout !== undefined) {
      const layout = step.request.layout;
      if (
        step.dispatch.output.width !== layout.canvasWidth ||
        step.dispatch.output.height !== layout.canvasHeight ||
        layout.regions.some((region) =>
          region.width * step.dispatch.cellOutput.height !== region.height * step.dispatch.cellOutput.width)
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "output"], message: "dispatch canvas and panel regions must match frozen layout geometry" });
      }
    }
    if (
      step.dispatch.target.kind === "shot" &&
      JSON.stringify(step.dispatch.output) !== JSON.stringify(step.dispatch.routeOutput)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "output"], message: "a shot dispatch must use the frozen provider route output" });
    }
    const requestPaths = [
      ...step.request.panels.flatMap((panel) => panel.fixedImage === undefined ? [] : [panel.fixedImage.path]),
      ...step.request.references.map((reference) => reference.path),
      ...(step.request.contextImages ?? []).map((image) => image.path),
    ];
    if (requestPaths.length !== step.dispatch.references.length || requestPaths.some((path, index) => path !== step.dispatch.references[index])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "references"], message: "dispatch references must match the frozen request in order" });
    }
    if (JSON.stringify(step.dispatch.params["request"]) !== JSON.stringify(step.request)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "params", "request"], message: "dispatch params must carry the frozen request" });
    }
    if (JSON.stringify(step.dispatch.params["output"]) !== JSON.stringify(step.dispatch.output)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "params", "output"], message: "dispatch params must carry the frozen output" });
    }
    if (JSON.stringify(step.dispatch.params["references"]) !== JSON.stringify(step.dispatch.references)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "params", "references"], message: "dispatch params must carry the frozen references" });
    }
    if (step.dispatch.target.coversShots === undefined || JSON.stringify(step.dispatch.target.coversShots) !== JSON.stringify(step.requestShotIds)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "target", "coversShots"], message: "dispatch target must cover the frozen request shots" });
    }
    if (step.dispatch.target.kind === "board-sheet" && step.request.layout === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "layout"], message: "a board sheet requires frozen layout" });
    }
    if (step.dispatch.target.kind === "shot" && (step.requestShotIds.length !== 1 || step.dispatch.target.id !== step.requestShotIds[0])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dispatch", "target"], message: "a shot dispatch must target its one request shot" });
    }
    if (Object.keys(step.landingOutcomes).some((id) => !updates.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["landingOutcomes"], message: "landing outcomes may name only update shots" });
    }
  });
export type FrameRunStep = z.infer<typeof FrameRunStepSchema>;

/** The durable operational record written under a production's `runs/` directory. */
export const FrameRunSchema = z
  .object({
    id: FrameRunIdSchema,
    sceneId: SceneIdSchema,
    sceneVersion: z.number().int().min(1),
    mode: z.enum(["per-shot", "board"]),
    model: z.string().min(1),
    steps: z.array(FrameRunStepSchema),
    cursor: z.number().int().min(0),
    paused: z.boolean(),
    cancelled: z.boolean(),
    /** Hidden from the run bar but retained because the board sheet remains a retry source. */
    dismissed: z.literal(true).optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.steps.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "a frame run requires at least one step" });
    }
    if (run.cursor > run.steps.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cursor"], message: "cursor cannot pass the end of the run" });
    }
    for (const [index, step] of run.steps.entries()) {
      if (step.dispatch.model !== run.model) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "dispatch", "model"], message: "step model must match the run" });
      }
      if (step.sourceStepIndex > index || (step.retryOf !== undefined && step.retryOf >= index)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: "retry lineage must point backward" });
      }
      if (step.retryOf === undefined && step.sourceStepIndex !== index) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "sourceStepIndex"], message: "an initial step is its own source" });
      }
      if ((step.retryOf === undefined) !== (step.grain === "initial")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "grain"], message: "only initial attempts omit retryOf" });
      }
      if (step.grain === "cell-retry" && step.updateShotIds.length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "updateShotIds"], message: "a cell retry updates exactly one shot" });
      }
      if (step.retryOf === undefined) {
        const expected = run.mode === "board" ? "board-sheet" : "shot";
        if (step.dispatch.target.kind !== expected) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "dispatch", "target", "kind"], message: `initial ${run.mode} steps must target ${expected}` });
        }
      }
      if (step.retryOf !== undefined && run.steps[step.retryOf]?.sourceStepIndex !== step.sourceStepIndex) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "retryOf"], message: "retry and parent must share a source" });
      }
    }
  });
export type FrameRun = z.infer<typeof FrameRunSchema>;

/** The queue fields joined into a run fold; none are copied into the durable run record. */
export const FrameRunJobFactsSchema = z
  .object({
    id: JobIdSchema,
    status: JobStatusSchema,
    failureClass: JobFailureClassSchema.nullable().optional(),
    error: z.string().nullable().optional(),
    etaSec: z.number().min(0).nullable().optional(),
    finalization: z.enum(["pending", "complete", "failed"]).optional(),
    finalizationError: z.string().nullable().optional(),
    /** Poll-time provider faults are durable non-terminal holds. */
    providerHeld: z.boolean().optional(),
  })
  .strict();
export type FrameRunJobFacts = z.infer<typeof FrameRunJobFactsSchema>;

export const FrameRunStepStatusSchema = z.enum([
  "not-enqueued",
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "reconciled",
  "superseded",
  "needs-reconciliation",
  "missing",
]);
export type FrameRunStepStatus = z.infer<typeof FrameRunStepStatusSchema>;

export const FrameRunStepStateSchema = z
  .object({
    index: z.number().int().min(0),
    status: FrameRunStepStatusSchema,
    failureClass: JobFailureClassSchema.nullable(),
    error: z.string().nullable(),
    etaSec: z.number().min(0).nullable(),
    canRetry: z.boolean(),
    canRetryCell: z.boolean(),
    landingOutcome: z.enum(["filed", "superseded", "partial"]).nullable(),
    shots: z.array(z.object({
      shotId: ShotIdSchema,
      status: FrameRunStepStatusSchema,
      failureClass: JobFailureClassSchema.nullable(),
      error: z.string().nullable(),
      landingOutcome: z.enum(["filed", "superseded"]).nullable(),
      canRetryCell: z.boolean(),
    }).strict()),
  })
  .strict();
export type FrameRunStepState = z.infer<typeof FrameRunStepStateSchema>;

export const FrameRunStateSchema = z
  .object({
    worldId: UlidSchema,
    productionId: SlugSchema,
    run: FrameRunSchema,
    status: z.enum(["active", "paused", "cancelled", "completed"]),
    steps: z.array(FrameRunStepStateSchema),
    completedSteps: z.number().int().min(0),
    failedSteps: z.number().int().min(0),
    failedShots: z.number().int().min(0),
    filedShots: z.number().int().min(0),
    supersededShots: z.number().int().min(0),
    etaSec: z.number().min(0).nullable(),
  })
  .strict();
export type FrameRunState = z.infer<typeof FrameRunStateSchema>;

export const FrameRunQuoteSchema = z.object({
  requestId: UlidSchema,
  quoteId: UlidSchema,
  signature: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  worldId: UlidSchema,
  productionId: SlugSchema,
  sceneId: SceneIdSchema,
  sceneVersion: z.number().int().min(1).nullable(),
  mode: z.enum(["per-shot", "board"]),
  modelId: z.string().min(1),
  scope: z.enum(["missing", "all"]),
  shotId: ShotIdSchema.optional(),
  includedCount: z.number().int().min(0),
  steps: z.array(z.object({
    label: z.string().min(1),
    requestShotIds: z.array(ShotIdSchema).min(1),
    updateShotIds: z.array(ShotIdSchema).min(1),
    references: FrameStepRequestSchema.shape.references,
    estimatedMicroUsd: z.number().int().min(0),
  }).strict()),
  estimatedMicroUsd: z.number().int().min(0).nullable(),
  blockedReason: z.string().min(1).nullable(),
  quotedAt: IsoDateTimeSchema,
}).strict();
export type FrameRunQuote = z.infer<typeof FrameRunQuoteSchema>;

const TERMINAL_STEP_STATUSES: ReadonlySet<FrameRunStepStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "missing",
  "reconciled",
  "superseded",
]);

/** Fold one durable run with current queue truth. Pure and idempotent; ETA is observed, never timed here. */
export function foldFrameRun(run: FrameRun, jobs: readonly FrameRunJobFacts[]): FrameRunState {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const baseStatus = (job: FrameRunJobFacts | undefined): FrameRunStepStatus =>
    job === undefined
      ? "missing"
      : job.providerHeld === true || job.finalization === "pending"
        ? "running"
        : job.finalization === "failed"
          ? "failed"
          : job.status;
  const succeeded = (job: FrameRunJobFacts | undefined) =>
    job?.status === "succeeded" && job.finalization !== "pending" && job.finalization !== "failed";
  const descendsFrom = (candidateIndex: number, ancestorIndex: number): boolean => {
    let at = run.steps[candidateIndex]?.retryOf;
    while (at !== undefined) {
      if (at === ancestorIndex) return true;
      at = run.steps[at]?.retryOf;
    }
    return false;
  };
  const laterAttempts = (index: number, shotId: string) =>
    run.steps
      .map((step, candidateIndex) => ({ step, candidateIndex }))
      .filter(({ step, candidateIndex }) =>
        candidateIndex > index && step.updateShotIds.includes(shotId as never) && descendsFrom(candidateIndex, index))
      .sort((a, b) => b.candidateIndex - a.candidateIndex);
  const blockedByDescendant = (index: number, shotIds: readonly string[], retryingWholeBoard = false) =>
    run.steps.some((step, candidateIndex) => {
      if (candidateIndex <= index || !descendsFrom(candidateIndex, index)) return false;
      if (!step.updateShotIds.some((shotId) => shotIds.includes(shotId))) return false;
      const status = baseStatus(step.jobId === null ? undefined : jobById.get(step.jobId));
      if (
        retryingWholeBoard &&
        step.grain === "cell-retry" &&
        step.jobId !== null &&
        ["succeeded", "failed", "cancelled"].includes(status)
      ) {
        return false;
      }
      return true;
    });
  const inheritedLandingOutcome = (index: number, shotId: string): "filed" | "superseded" | undefined => {
    let at = run.steps[index]?.retryOf;
    while (at !== undefined) {
      const ancestor = run.steps[at];
      if (ancestor === undefined) return undefined;
      const job = ancestor.jobId === null ? undefined : jobById.get(ancestor.jobId);
      const outcome = ancestor.landingOutcomes[shotId as never];
      if (succeeded(job) && outcome !== undefined) return outcome;
      at = ancestor.retryOf;
    }
    return undefined;
  };
  const steps: FrameRunStepState[] = run.steps.map((step, index) => {
    if (step.jobId === null) {
      return {
        index,
        status: "not-enqueued",
        failureClass: null,
        error: null,
        etaSec: null,
        canRetry: false,
        canRetryCell: false,
        landingOutcome: null,
        shots: step.updateShotIds.map((shotId) => ({
          shotId,
          status: "not-enqueued" as const,
          failureClass: null,
          error: null,
          landingOutcome: null,
          canRetryCell: false,
        })),
      };
    }
    const job = jobById.get(step.jobId);
    if (job === undefined) {
      return {
        index,
        status: "missing",
        failureClass: null,
        error: `job ${step.jobId} is gone from the queue's history`,
        etaSec: null,
        canRetry: false,
        canRetryCell: false,
        landingOutcome: null,
        shots: step.updateShotIds.map((shotId) => ({
          shotId,
          status: "missing" as const,
          failureClass: null,
          error: `job ${step.jobId} is gone from the queue's history`,
          landingOutcome: null,
          canRetryCell: false,
        })),
      };
    }
    const failureClass = job.failureClass ?? null;
    const rawStatus = baseStatus(job);
    const shots = step.updateShotIds.map((shotId) => {
      const later = laterAttempts(index, shotId);
      const latest = later[0];
      const reconciled = rawStatus === "failed" && latest !== undefined && succeeded(
        latest.step.jobId === null ? undefined : jobById.get(latest.step.jobId),
      );
      const shotStatus: FrameRunStepStatus = reconciled
        ? "reconciled"
        : rawStatus === "succeeded" && step.landingOutcomes[shotId] === "superseded"
          ? "superseded"
          : rawStatus;
      const canRetryCell =
        !run.cancelled &&
        run.mode === "board" &&
        run.steps[step.sourceStepIndex]?.dispatch.target.kind === "board-sheet" &&
        step.dispatch.referenceCapacity > 0 &&
        (
          shotStatus === "succeeded" ||
          shotStatus === "superseded" ||
          shotStatus === "reconciled" ||
          (shotStatus === "failed" && failureClass === "transient")
        ) &&
        !blockedByDescendant(index, [shotId]);
      return {
        shotId,
        status: shotStatus,
        failureClass,
        error: job.finalization === "failed" ? (job.finalizationError ?? job.error ?? null) : (job.error ?? null),
        landingOutcome: (succeeded(job) ? step.landingOutcomes[shotId] : undefined) ?? inheritedLandingOutcome(index, shotId) ?? null,
        canRetryCell,
      };
    });
    const landed = shots.map((shot) => shot.landingOutcome);
    const allSuperseded = landed.length > 0 && landed.every((outcome) => outcome === "superseded");
    const landingOutcome = landed.every((outcome) => outcome === "filed")
      ? "filed"
      : allSuperseded
        ? "superseded"
        : landed.some((outcome) => outcome !== null)
          ? "partial"
          : null;
    const status: FrameRunStepStatus = shots.every((shot) => shot.status === "reconciled")
      ? "reconciled"
      : shots.every((shot) => shot.status === "superseded")
        ? "superseded"
        : shots.some((shot) => shot.status === "failed")
          ? "failed"
          : shots.some((shot) => shot.status === "needs-reconciliation")
            ? "needs-reconciliation"
            : rawStatus;
    const wholeBoardRetry =
      run.mode === "board" &&
      step.dispatch.target.kind === "board-sheet" &&
      ["succeeded", "reconciled", "superseded"].includes(status);
    const canRetry =
      !run.cancelled &&
      ((status === "failed" && failureClass === "transient") || wholeBoardRetry) &&
      !blockedByDescendant(index, step.updateShotIds, wholeBoardRetry);
    return {
      index,
      status,
      failureClass,
      error: job.finalization === "failed" ? (job.finalizationError ?? job.error ?? null) : (job.error ?? null),
      etaSec: job.etaSec ?? null,
      canRetry,
      canRetryCell: shots.some((shot) => shot.canRetryCell),
      landingOutcome,
      shots,
    };
  });
  const initialIndexes = run.steps.flatMap((step, index) => step.grain === "initial" ? [index] : []);
  const currentShotStates = initialIndexes.flatMap((initialIndex) =>
    run.steps[initialIndex]!.updateShotIds.map((shotId) => {
      const affecting = run.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step, index }) =>
          step.updateShotIds.includes(shotId) && (index === initialIndex || descendsFrom(index, initialIndex)))
        .sort((a, b) => b.index - a.index);
      const current = affecting[0]!;
      return steps[current.index]!.shots.find((shot) => shot.shotId === shotId)!;
    }),
  );
  const completedSteps = initialIndexes.filter((index) =>
    run.steps[index]!.updateShotIds.every((shotId) => {
      const current = currentShotStates.find((shot) => shot.shotId === shotId);
      return current !== undefined && ["succeeded", "superseded", "reconciled"].includes(current.status);
    }),
  ).length;
  const failedSteps = initialIndexes.filter((index) =>
    run.steps[index]!.updateShotIds.some((shotId) => {
      const current = currentShotStates.find((shot) => shot.shotId === shotId);
      return current !== undefined && ["failed", "missing", "needs-reconciliation"].includes(current.status);
    }),
  ).length;
  const failedShots = currentShotStates.filter((shot) => ["failed", "missing", "needs-reconciliation"].includes(shot.status)).length;
  const filedShots = currentShotStates.filter((shot) => shot.landingOutcome === "filed").length;
  const supersededShots = currentShotStates.filter((shot) => shot.landingOutcome === "superseded").length;
  const settled = steps.length > 0 && steps.every((step) => TERMINAL_STEP_STATUSES.has(step.status));
  const etaValues = steps
    .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
    .map((step) => step.etaSec)
    .filter((eta): eta is number => eta !== null);
  const status: FrameRunState["status"] = run.cancelled
    ? "cancelled"
    : settled
      ? "completed"
      : run.paused
        ? "paused"
        : "active";

  return {
    worldId: run.steps[0]!.dispatch.worldId,
    productionId: run.steps[0]!.dispatch.productionId,
    run,
    status,
    steps,
    completedSteps,
    failedSteps,
    failedShots,
    filedShots,
    supersededShots,
    etaSec: etaValues.length > 0 ? etaValues.reduce((sum, eta) => sum + eta, 0) : null,
  };
}
