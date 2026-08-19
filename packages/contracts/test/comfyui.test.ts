import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppSettingsSchema,
  ComfyUiStatusSchema,
  comfyUiRecoveryDecision,
  JobSchema,
  PROVIDERS,
  ProviderIdSchema,
  ProvenanceSchema,
  RecipeIdentitySchema,
  reconcileStrategy,
  ulid,
  type JobEngineIdentity,
} from "../src/index.js";

/**
 * SPEC-021: the provider row, the identity frozen onto a job, and the per-source recovery
 * policy (§2.11). The policy is pure — data in, decision out — asserted here exhaustively,
 * because the queue consults it instead of guessing.
 */

const DIGEST = "a".repeat(64);

describe("the comfyui provider row", () => {
  it("is local, keyless, and serves image, video and local cloned voice", () => {
    assert.equal(ProviderIdSchema.safeParse("comfyui").success, true);
    assert.deepEqual(PROVIDERS.comfyui, {
      displayName: "ComfyUI",
      // voice-tts since SPEC-022: a cloned voice runs here as a recipe. Deliberately NOT
      // voice-clone — cloning is what the app does to a recording, not something it asks an
      // engine for, and a capability probe claiming otherwise is what sank the indextts row.
      capabilities: ["image", "video", "voice-tts"],
      local: true,
      credential: "none",
    });
  });

  it("declares nothing reconcilable, so the strategy is the honest user decision (D12)", () => {
    assert.equal(
      reconcileStrategy({
        supportsIdempotencyKey: false,
        supportsLookupByKey: false,
        supportsListRecent: false,
        reportsCost: false,
      }),
      "ask-user",
    );
  });
});

describe("identity frozen onto a job (R-15)", () => {
  const job = {
    id: `jb_${ulid()}`,
    idempotencyKey: ulid(),
    worldId: ulid(),
    target: { kind: "shot", id: "sh_001" },
    capability: "video" as const,
    provider: "comfyui",
    model: "comfyui-draft-video",
    params: {},
    estimatedMicroUsd: 0,
    status: "queued" as const,
    providerJobId: null,
    attempt: 0,
    error: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };

  it("a job can carry recipe and engine identity, and both are strict shapes", () => {
    const parsed = JobSchema.parse({
      ...job,
      recipe: { id: "comfyui-draft-video", version: 1, templateDigest: DIGEST, dependencyDigest: DIGEST },
      engine: { source: "user-url", instanceId: "abc123" },
    });
    assert.equal(parsed.recipe?.version, 1);
    assert.equal(parsed.engine?.source, "user-url");
    // A field that is not identity does not ride along silently.
    assert.equal(
      JobSchema.safeParse({ ...job, recipe: { id: "x", version: 1, templateDigest: DIGEST, dependencyDigest: DIGEST, graph: {} } })
        .success,
      false,
    );
  });

  it("a job without either field still parses — every existing journal row stays readable", () => {
    assert.equal(JobSchema.safeParse(job).success, true);
  });

  it("the template digest must be a sha256, not a truncation that could collide quietly", () => {
    assert.equal(
      RecipeIdentitySchema.safeParse({ id: "r", version: 1, templateDigest: "abc123", dependencyDigest: DIGEST }).success,
      false,
    );
  });
});

describe("take provenance carries the recipe version (R-13)", () => {
  it("alongside canon and sheets, optionally, and never a zero", () => {
    assert.equal(
      ProvenanceSchema.safeParse({ canonRevision: 3, sheets: {}, recipeVersion: 1 }).success,
      true,
    );
    assert.equal(
      ProvenanceSchema.safeParse({ canonRevision: 3, sheets: {}, recipeVersion: 0 }).success,
      false,
    );
    assert.equal(ProvenanceSchema.safeParse({ canonRevision: 3, sheets: {} }).success, true);
  });
});

describe("comfyui settings", () => {
  it("defaults to nothing configured, and a corrupt block falls back without losing the file", () => {
    const fresh = AppSettingsSchema.parse({});
    assert.deepEqual(fresh.comfyui, { enginePath: null, engineUrl: null, modelsDir: null });
    const corrupt = AppSettingsSchema.parse({ comfyui: { enginePath: 42 } });
    assert.deepEqual(corrupt.comfyui, { enginePath: null, engineUrl: null, modelsDir: null });
  });
});

describe("the recovery policy (§2.11) — a table, not a guess", () => {
  const at = (source: JobEngineIdentity["source"], instanceId = "same"): JobEngineIdentity => ({ source, instanceId });

  it("spawned engines requeue: their queue died with Arke and the relaunched engine holds no old work", () => {
    for (const source of ["managed", "user-path"] as const) {
      for (const status of ["running", "submitting"] as const) {
        assert.deepEqual(
          comfyUiRecoveryDecision({ status, engine: at(source), currentInstanceId: "same" }),
          { action: "requeue" },
          `${source}/${status}`,
        );
        // Even when the current engine differs — a spawned engine's old work is gone either way.
        assert.deepEqual(
          comfyUiRecoveryDecision({ status, engine: at(source), currentInstanceId: "different" }),
          { action: "requeue" },
        );
      }
    }
  });

  it("a surviving URL engine resumes a running job only on the same instance", () => {
    assert.deepEqual(
      comfyUiRecoveryDecision({ status: "running", engine: at("user-url"), currentInstanceId: "same" }),
      { action: "resume" },
    );
  });

  it("an old id is never polled against a different engine — the job fails with the reason stated", () => {
    for (const current of ["different", null]) {
      const decision = comfyUiRecoveryDecision({
        status: "running",
        engine: at("user-url"),
        currentInstanceId: current,
      });
      assert.equal(decision.action, "fail");
      assert.match((decision as { action: "fail"; reason: string }).reason, /no longer configured/);
      // Never wording that implies it might quietly resume.
      assert.match((decision as { action: "fail"; reason: string }).reason, /not resumed/);
    }
  });

  it("an unwitnessed submission against a surviving engine is the user's decision", () => {
    assert.deepEqual(
      comfyUiRecoveryDecision({ status: "submitting", engine: at("user-url"), currentInstanceId: "same" }),
      { action: "hold" },
    );
  });

  it("a job with no frozen identity holds — nothing can be proven about which engine it was", () => {
    assert.deepEqual(
      comfyUiRecoveryDecision({ status: "running", engine: undefined, currentInstanceId: "same" }),
      { action: "hold" },
    );
  });
});

describe("the combined status shape", () => {
  it("parses the whole picture and refuses a generic disabled without a reason present as empty", () => {
    const status = ComfyUiStatusSchema.parse({
      engine: {
        source: "user-path",
        state: "ready",
        location: "C:\\AI\\ComfyUI",
        version: "0.33.1",
        instanceId: "abc",
        detail: null,
        detected: [],
      },
      recipes: [
        {
          recipeId: "comfyui-draft-image",
          recipeVersion: 1,
          displayName: "Local · Draft Image",
          capability: "image",
          state: "ready",
        },
        {
          recipeId: "comfyui-draft-video",
          recipeVersion: 1,
          displayName: "Local · Draft Video",
          capability: "video",
          state: "disabled",
          reason: "Needs 8 GB VRAM. This machine has 6 GB. Cloud video still works.",
        },
      ],
      checkedAt: "2026-08-18T00:00:00.000Z",
    });
    assert.equal(status.recipes.length, 2);
    // An empty-string reason is not a reason (R-10).
    assert.equal(
      ComfyUiStatusSchema.safeParse({
        ...status,
        recipes: [{ ...status.recipes[1]!, reason: "" }],
      }).success,
      false,
    );
  });
});
