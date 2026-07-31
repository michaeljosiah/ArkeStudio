import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadModel } from "../src/read-model.js";
import { MockWorldProvider } from "../src/world-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../fixtures");
const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const AT = "2026-08-01T10:00:00Z";

describe("ReadModel", () => {
  it("folds health changes", () => {
    const model = new ReadModel("0.0.0-test");
    model.apply({ at: AT, type: "health.changed", component: "harness", status: "healthy" });
    assert.equal(model.getState().app.health.harness.status, "healthy");
    model.apply({
      at: AT,
      type: "health.changed",
      component: "voice",
      status: "unavailable",
      reason: "Voxa is not configured",
    });
    assert.equal(model.getState().app.health.voice.reason, "Voxa is not configured");
  });

  it("upserts jobs by id", () => {
    const model = new ReadModel("0.0.0-test");
    const job = {
      id: "jb_01J8E0000000000000000000J9",
      idempotencyKey: "01J8E1000000000000000000K9",
      worldId: WORLD_ID,
      target: { kind: "shot", id: "sh_14" },
      provider: "fal",
      model: "seedance-2.0",
      params: {},
      estimatedMicroUsd: 110000,
      status: "queued" as const,
      providerJobId: null,
      error: null,
      createdAt: AT,
      updatedAt: AT,
    };
    model.apply({ at: AT, type: "job.updated", job });
    model.apply({ at: AT, type: "job.updated", job: { ...job, status: "running" } });
    assert.equal(model.getState().app.jobs.length, 1);
    assert.equal(model.getState().app.jobs[0]!.status, "running");
  });

  it("folds world-scoped events into the open world only", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const model = new ReadModel("0.0.0-test");
    model.setWorld(await provider.loadWorld(WORLD_ID));

    const before = model.getState().world!.changes.length;
    model.apply({
      at: AT,
      type: "entity.changed",
      worldId: WORLD_ID,
      change: { ts: AT, entity: "characters/maren-kest", fromVersion: 4, toVersion: 5, source: "test" },
    });
    assert.equal(model.getState().world!.changes.length, before + 1);

    // An event for a different world must not touch the open one.
    model.apply({
      at: AT,
      type: "entity.changed",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6XX",
      change: { ts: AT, entity: "characters/nobody", source: "test" },
    });
    assert.equal(model.getState().world!.changes.length, before + 1);

    model.apply({
      at: AT,
      type: "selection.changed",
      worldId: WORLD_ID,
      productionId: "saltlight",
      shotId: "sh_13",
      selection: { acceptedTakeId: "tk_01J8D0000000000000000000D4" },
    });
    const saltlight = model.getState().world!.productions[0]!;
    assert.equal(saltlight.selections["sh_13"]?.acceptedTakeId, "tk_01J8D0000000000000000000D4");

    model.apply({ at: AT, type: "canon.revision.advanced", worldId: WORLD_ID, revision: 43 });
    assert.equal(model.getState().world!.meta.canonRevision, 43);
  });
});
