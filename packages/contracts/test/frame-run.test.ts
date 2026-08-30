import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientMessageSchema,
  ClientStateSchema,
  DomainEventSchema,
  FrameRunIdSchema,
  FrameRunSchema,
  FrameStepRequestSchema,
  JobSchema,
  foldFrameRun,
  newId,
  ulid,
  type FrameRun,
  type FrameStepRequest,
  FrameRunQuoteSchema,
} from "../src/index.js";

const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const RUN_ID = "fr_01J8E0000000000000000000R1";
const JOB_1 = "jb_01J8E0000000000000000000J1";
const JOB_2 = "jb_01J8E0000000000000000000J2";

const request: FrameStepRequest = {
  prompt: "One coherent board under salt-blue light.",
  panels: [
    { panel: 1, shotId: "sh_1", role: "update" },
    {
      panel: 2,
      shotId: "sh_2",
      role: "fixed",
      fixedImage: { source: "artifact", id: "ar_01J8E0000000000000000000A1", path: "artifacts/sh-2.png" },
    },
  ],
  references: [{ sheetId: "maren-kest", version: 4, path: "characters/maren-kest.md" }],
  droppedReferences: [],
  provenance: { canonRevision: 8, artDirectionVersion: 3 },
  layout: {
    columns: 2,
    rows: 1,
    canvasWidth: 3072,
    canvasHeight: 1024,
    regions: [
      { panel: 1, x: 0, y: 80, width: 1536, height: 864 },
      { panel: 2, x: 1536, y: 80, width: 1536, height: 864 },
    ],
  },
  aspect: "16:9",
  slotAtAuthorization: { sh_1: null },
};

const dispatch = {
  worldId: WORLD_ID,
  productionId: "saltlight",
  provider: "openai",
  model: "gpt-image-2",
  capability: "image" as const,
  target: { kind: "board-sheet", coversShots: ["sh_1", "sh_2"] },
  references: ["artifacts/sh-2.png", "characters/maren-kest.md"],
  referenceCapacity: 8,
  output: { width: 3072, height: 1024, aspect: "3:1" },
  cellOutput: { width: 1536, height: 864, aspect: "16:9" },
  estimatedMicroUsd: 2000,
  cellEstimatedMicroUsd: 1000,
  params: {
    prompt: request.prompt,
    references: ["artifacts/sh-2.png", "characters/maren-kest.md"],
    output: { width: 3072, height: 1024, aspect: "3:1" },
    request,
  },
  landing: { dir: "productions/saltlight/incoming/fr/0", name: "board.png" },
  idempotencyKey: "01J8E0000000000000000000K1",
};

const request2: FrameStepRequest = {
  ...request,
  panels: [{ panel: 1, shotId: "sh_3", role: "update" }],
  slotAtAuthorization: { sh_3: null },
  layout: {
    columns: 2,
    rows: 1,
    canvasWidth: 3072,
    canvasHeight: 1024,
    regions: [{ panel: 1, x: 0, y: 80, width: 1536, height: 864 }],
  },
};

const run: FrameRun = {
  id: RUN_ID,
  sceneId: "sc_4",
  sceneVersion: 7,
  mode: "board",
  model: "gpt-image-2",
  steps: [
    {
      label: "Board A",
      requestShotIds: ["sh_1", "sh_2"],
      updateShotIds: ["sh_1"],
      request,
      dispatch,
      sourceStepIndex: 0,
      grain: "initial",
      jobId: JOB_1,
      landingOutcomes: {},
    },
    {
      label: "Board B",
      requestShotIds: ["sh_3"],
      updateShotIds: ["sh_3"],
      request: request2,
      dispatch: {
        ...dispatch,
        target: { kind: "board-sheet", coversShots: ["sh_3"] },
        references: ["characters/maren-kest.md"],
        output: { width: 3072, height: 1024, aspect: "3:1" },
        params: {
          prompt: request.prompt,
          references: ["characters/maren-kest.md"],
          output: { width: 3072, height: 1024, aspect: "3:1" },
          request: request2,
        },
        idempotencyKey: "01J8E0000000000000000000K2",
      },
      sourceStepIndex: 1,
      grain: "initial",
      jobId: JOB_2,
      landingOutcomes: {},
    },
  ],
  cursor: 2,
  paused: false,
  cancelled: false,
  createdAt: "2026-08-30T12:00:00Z",
};

describe("frame-run durable contracts (SPEC-036 §2.7)", () => {
  it("uses the fr record prefix", () => {
    assert.equal(FrameRunIdSchema.parse(RUN_ID), RUN_ID);
    assert.match(newId("fr"), /^fr_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.throws(() => FrameRunIdSchema.parse("run_01J8E0000000000000000000R1"));
  });

  it("round-trips the exact frozen request and run record", () => {
    assert.deepEqual(FrameStepRequestSchema.parse(request), request);
    assert.deepEqual(FrameRunSchema.parse(run), run);
    assert.throws(() => FrameRunSchema.parse({ ...run, status: "running" }), /unrecognized_keys/);
    assert.throws(() => FrameStepRequestSchema.parse({ ...request, model: "not-owned-by-the-request" }));
  });

  it("requires a fixed image exactly for fixed panels", () => {
    assert.throws(() =>
      FrameStepRequestSchema.parse({
        ...request,
        panels: [{ panel: 1, shotId: "sh_1", role: "fixed" }],
      }),
    );
    assert.throws(() =>
      FrameStepRequestSchema.parse({
        ...request,
        panels: [
          {
            panel: 1,
            shotId: "sh_1",
            role: "update",
            fixedImage: { source: "take", id: "tk_01J8E0000000000000000000T1", path: "takes/frame.png" },
          },
        ],
      }),
    );
  });
});

describe("frame-run wire contracts", () => {
  it("accepts start, control, retry, list, and dismiss commands", () => {
    const production = { worldId: WORLD_ID, productionId: "saltlight" };
    const commands = [
      {
        kind: "frame-run-quote",
        requestId: "01J8E0000000000000000000Q1",
        ...production,
        sceneId: "sc_4",
        mode: "board",
        modelId: "gpt-image-2",
        scope: "missing",
      },
      {
        kind: "frame-run-start",
        requestId: "01J8E0000000000000000000Q1",
        quoteId: "01J8E0000000000000000000Q2",
        quoteSignature: `sha256:${"a".repeat(64)}`,
        quotedMicroUsd: 2000,
        ...production,
        sceneId: "sc_4",
        mode: "board",
        modelId: "gpt-image-2",
        scope: "missing",
      },
      { kind: "frame-run-pause", ...production, runId: RUN_ID },
      { kind: "frame-run-resume", ...production, runId: RUN_ID },
      { kind: "frame-run-cancel", ...production, runId: RUN_ID },
      { kind: "frame-run-retry-step", ...production, runId: RUN_ID, stepIndex: 0 },
      { kind: "frame-run-retry-cell", ...production, runId: RUN_ID, stepIndex: 0, shotId: "sh_1" },
      { kind: "frame-run-list", ...production },
      { kind: "frame-run-dismiss", ...production, runId: RUN_ID },
    ];
    for (const command of commands) assert.deepEqual(ClientMessageSchema.parse(command), command);
    assert.throws(() => ClientMessageSchema.parse({ ...commands[0], scope: "none" }));
    assert.throws(() => ClientMessageSchema.parse({ ...commands[5], stepIndex: -1 }));
  });

  it("carries a folded run event and defaults snapshots to no recovered runs", () => {
    const state = foldFrameRun(run, [
      { id: JOB_1, status: "succeeded", etaSec: null },
      { id: JOB_2, status: "failed", failureClass: "terminal", error: "content policy", etaSec: null },
    ]);
    const event = {
      at: "2026-08-30T12:01:00Z",
      type: "production.frame-run",
      worldId: WORLD_ID,
      productionId: "saltlight",
      runId: RUN_ID,
      state,
    } as const;
    assert.deepEqual(DomainEventSchema.parse(event), event);
    const dismissed = DomainEventSchema.parse({ ...event, state: null });
    assert.equal(dismissed.type, "production.frame-run");
    assert.equal("state" in dismissed ? dismissed.state : undefined, null);

    const snapshot = ClientStateSchema.parse({
      app: {
        version: "0.1.0",
        health: {
          coordinator: { status: "healthy" },
          harness: { status: "unavailable" },
          voice: { status: "unavailable" },
        },
        jobs: [],
        ledger: [],
      },
      worlds: [],
      world: null,
    });
    assert.deepEqual(snapshot.frameRuns, []);
  });

  it("carries a correlated authoritative quote", () => {
    const quote = FrameRunQuoteSchema.parse({
      requestId: "01J8E0000000000000000000Q1",
      quoteId: "01J8E0000000000000000000Q2",
      signature: `sha256:${"a".repeat(64)}`,
      worldId: WORLD_ID,
      productionId: "saltlight",
      sceneId: "sc_4",
      sceneVersion: 7,
      mode: "board",
      modelId: "gpt-image-2",
      scope: "missing",
      includedCount: 1,
      steps: [{ label: "Board A", requestShotIds: ["sh_1", "sh_2"], updateShotIds: ["sh_1"], estimatedMicroUsd: 2000 }],
      estimatedMicroUsd: 2000,
      blockedReason: null,
      quotedAt: "2026-08-30T12:00:00Z",
    });
    assert.deepEqual(DomainEventSchema.parse({
      at: "2026-08-30T12:00:01Z",
      type: "production.frame-run-quote",
      quote,
    }), {
      at: "2026-08-30T12:00:01Z",
      type: "production.frame-run-quote",
      quote,
    });
  });

  it("carries correlated accepted and refused start results", () => {
    const base = {
      at: "2026-08-30T12:00:02Z",
      type: "production.frame-run-start-result" as const,
      requestId: "01J8E0000000000000000000Q1",
      quoteId: "01J8E0000000000000000000Q2",
      worldId: WORLD_ID,
      productionId: "saltlight",
    };
    assert.deepEqual(DomainEventSchema.parse({ ...base, disposition: "accepted", runId: RUN_ID }), {
      ...base,
      disposition: "accepted",
      runId: RUN_ID,
    });
    assert.deepEqual(DomainEventSchema.parse({ ...base, disposition: "refused", reason: "stale quote" }), {
      ...base,
      disposition: "refused",
      reason: "stale quote",
    });
  });
});

describe("frame-run fold", () => {
  it("joins queue status, durable class, error, and observed ETA per step", () => {
    const state = foldFrameRun(run, [
      { id: JOB_1, status: "running", etaSec: 8 },
      {
        id: JOB_2,
        status: "failed",
        failureClass: "transient",
        error: "gave up after 5 attempts: timed out",
        etaSec: null,
      },
    ]);
    assert.equal(state.status, "active");
    assert.equal(state.etaSec, 8);
    assert.deepEqual(state.steps[0], {
      index: 0,
      status: "running",
      failureClass: null,
      error: null,
      etaSec: 8,
      canRetry: false,
      canRetryCell: false,
      landingOutcome: null,
      shots: [{
        shotId: "sh_1",
        status: "running",
        failureClass: null,
        error: null,
        landingOutcome: null,
        canRetryCell: false,
      }],
    });
    assert.deepEqual(state.steps[1], {
      index: 1,
      status: "failed",
      failureClass: "transient",
      error: "gave up after 5 attempts: timed out",
      etaSec: null,
      canRetry: true,
      canRetryCell: true,
      landingOutcome: null,
      shots: [{
        shotId: "sh_3",
        status: "failed",
        failureClass: "transient",
        error: "gave up after 5 attempts: timed out",
        landingOutcome: null,
        canRetryCell: true,
      }],
    });
    assert.equal(state.failedSteps, 1);
  });

  it("does not offer retries for terminal, provider-fault, or offline classifications", () => {
    for (const failureClass of ["terminal", "provider-fault", "offline"] as const) {
      const state = foldFrameRun(
        { ...run, steps: [run.steps[0]!] },
        [{ id: JOB_1, status: "failed", failureClass, error: failureClass }],
      );
      assert.equal(state.steps[0]!.canRetry, false, failureClass);
      assert.equal(state.status, "completed");
    }
  });

  it("lets cancellation outrank settlement and pause own only the advance gate", () => {
    const jobs = [
      { id: JOB_1, status: "succeeded" as const },
      { id: JOB_2, status: "running" as const, etaSec: 3 },
    ];
    assert.equal(foldFrameRun({ ...run, paused: true }, jobs).status, "paused");
    assert.equal(foldFrameRun({ ...run, cancelled: true }, jobs).status, "cancelled");
  });

  it("does not call provider success complete until local finalization completes", () => {
    const pending = foldFrameRun(
      { ...run, steps: [run.steps[0]!] },
      [{ id: JOB_1, status: "succeeded", finalization: "pending" }],
    );
    assert.equal(pending.steps[0]!.status, "running");
    assert.equal(pending.status, "active");
    const failed = foldFrameRun(
      { ...run, steps: [run.steps[0]!] },
      [{ id: JOB_1, status: "succeeded", finalization: "failed", finalizationError: "crop failed" }],
    );
    assert.equal(failed.steps[0]!.status, "needs-reconciliation");
    assert.equal(failed.steps[0]!.error, "crop failed");
    assert.equal(failed.failedSteps, 1);
  });

  it("reconciles a failed source after its retry succeeds and suppresses duplicate retry", () => {
    const retry: FrameRun = {
      ...run,
      steps: [
        run.steps[0]!,
        {
          ...run.steps[0]!,
          label: "Board A retry",
          sourceStepIndex: 0,
          grain: "step-retry",
          retryOf: 0,
          jobId: JOB_2,
          dispatch: { ...run.steps[0]!.dispatch, idempotencyKey: "01J8E0000000000000000000K2" },
        },
      ],
      cursor: 2,
    };
    const state = foldFrameRun(retry, [
      { id: JOB_1, status: "failed", failureClass: "transient", error: "timeout" },
      { id: JOB_2, status: "succeeded", finalization: "complete" },
    ]);
    assert.equal(state.steps[0]!.status, "reconciled");
    assert.equal(state.steps[0]!.canRetry, false);
    assert.equal(state.steps[1]!.status, "succeeded");
    assert.equal(state.failedSteps, 0);
    assert.equal(state.completedSteps, 1, "progress counts the creative source, not attempts");
  });

  it("surfaces a fenced landing as superseded rather than ordinary success", () => {
    const superseded = {
      ...run,
      steps: [{ ...run.steps[0]!, landingOutcomes: { sh_1: "superseded" as const } }],
      cursor: 1,
    };
    const state = foldFrameRun(superseded, [{ id: JOB_1, status: "succeeded", finalization: "complete" }]);
    assert.equal(state.steps[0]!.status, "superseded");
    assert.equal(state.steps[0]!.landingOutcome, "superseded");
    assert.equal(state.failedSteps, 0);
  });

  it("uses the latest attempt per shot, and a cell success reconciles only that cell", () => {
    const twoUpdateRequest = {
      ...run.steps[0]!.request,
      panels: [
        { panel: 1, shotId: "sh_1", role: "update" as const },
        { panel: 2, shotId: "sh_2", role: "update" as const },
      ],
      slotAtAuthorization: { sh_1: null, sh_2: null },
    };
    const boardFailed: FrameRun = {
      ...run,
      steps: [{
        ...run.steps[0]!,
        updateShotIds: ["sh_1", "sh_2"],
        request: twoUpdateRequest,
        dispatch: {
          ...run.steps[0]!.dispatch,
          references: ["characters/maren-kest.md"],
          params: {
            ...run.steps[0]!.dispatch.params,
            references: ["characters/maren-kest.md"],
            request: twoUpdateRequest,
          },
        },
        jobId: JOB_1,
      }],
      cursor: 1,
    };
    const firstShotRetry: FrameRun["steps"][number] = {
      ...run.steps[0]!,
      label: "shot 1 retry",
      requestShotIds: ["sh_1"],
      updateShotIds: ["sh_1"],
      request: {
        ...run.steps[0]!.request,
        panels: [{ panel: 1, shotId: "sh_1", role: "update" }],
        layout: undefined,
        slotAtAuthorization: { sh_1: null },
      },
      dispatch: {
        ...run.steps[0]!.dispatch,
        target: { kind: "shot", id: "sh_1", coversShots: ["sh_1"] },
        output: run.steps[0]!.dispatch.cellOutput,
        references: ["characters/maren-kest.md"],
        params: {
          ...run.steps[0]!.dispatch.params,
          output: run.steps[0]!.dispatch.cellOutput,
          references: ["characters/maren-kest.md"],
          request: {
            ...run.steps[0]!.request,
            panels: [{ panel: 1, shotId: "sh_1", role: "update" }],
            layout: undefined,
            slotAtAuthorization: { sh_1: null },
          },
        },
        idempotencyKey: "01J8E0000000000000000000K3",
      },
      sourceStepIndex: 0,
      grain: "cell-retry",
      retryOf: 0,
      jobId: JOB_2,
      landingOutcomes: { sh_1: "filed" },
    };
    const partial = foldFrameRun(
      { ...boardFailed, steps: [...boardFailed.steps, firstShotRetry], cursor: 2 },
      [
        { id: JOB_1, status: "failed", failureClass: "transient", error: "bad board" },
        { id: JOB_2, status: "succeeded", finalization: "complete" },
      ],
    );
    assert.equal(partial.failedShots, 1, "shot 1 is reconciled while shot 2 remains failed");
    assert.equal(partial.steps[0]!.shots[0]!.status, "reconciled");
    assert.equal(partial.steps[0]!.shots[1]!.status, "failed");

    const laterFailure = foldFrameRun(
      { ...run, steps: [run.steps[0]!, { ...firstShotRetry, jobId: JOB_2 }], cursor: 2 },
      [
        { id: JOB_1, status: "succeeded", finalization: "complete" },
        { id: JOB_2, status: "failed", failureClass: "transient", error: "later failed" },
      ],
    );
    assert.equal(laterFailure.failedShots, 1, "an older success never hides a later regeneration failure");
  });

  it("does not offer a cell retry when the frozen model accepts no parent image", () => {
    const requestWithoutReferences = {
      ...request2,
      references: [],
      droppedReferences: [],
    };
    const noReferences: FrameRun = {
      ...run,
      steps: [{
        ...run.steps[1]!,
        request: requestWithoutReferences,
        dispatch: {
          ...run.steps[1]!.dispatch,
          referenceCapacity: 0,
          references: [],
          params: {
            ...run.steps[1]!.dispatch.params,
            references: [],
            request: requestWithoutReferences,
          },
        },
      }],
      cursor: 1,
    };
    const state = foldFrameRun(noReferences, [{ id: JOB_2, status: "failed", failureClass: "transient" }]);
    assert.equal(state.steps[0]!.canRetryCell, false);
    assert.equal(state.steps[0]!.shots[0]!.canRetryCell, false);
  });
});

describe("job failure classification", () => {
  it("persists the queue's closed failure vocabulary", () => {
    const job = {
      id: JOB_1,
      idempotencyKey: ulid(),
      worldId: WORLD_ID,
      target: { kind: "shot", id: "sh_1", coversShots: ["sh_1"] },
      capability: "image",
      provider: "openai",
      model: "gpt-image-2",
      params: {},
      estimatedMicroUsd: 1,
      status: "failed",
      providerJobId: null,
      attempt: 5,
      error: "timed out",
      failureClass: "transient",
      createdAt: "2026-08-30T12:00:00Z",
      updatedAt: "2026-08-30T12:01:00Z",
    };
    assert.deepEqual(JobSchema.parse(job), job);
    assert.throws(() => JobSchema.parse({ ...job, failureClass: "retryable" }));
  });
});
