import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientStateSchema, DomainEventSchema } from "@arke-studio/contracts";
import { ReadModel } from "../src/read-model.js";

describe("retained update state", () => {
  it("folds progress and ready state into snapshots for late clients", () => {
    const model = new ReadModel("1.0.0");
    for (const update of [
      {
        status: "downloading" as const,
        targetVersion: "1.1.0",
        progressPercent: 37,
        flow: null,
        detail: null,
      },
      { status: "ready" as const, targetVersion: "1.1.0", progressPercent: 100, flow: null, detail: null },
    ]) {
      model.apply(DomainEventSchema.parse({ at: "2026-08-05T12:00:00Z", type: "update.status", update }));
    }
    const snapshot = ClientStateSchema.parse(model.getState());
    assert.deepEqual(snapshot.app.update, {
      status: "ready",
      targetVersion: "1.1.0",
      progressPercent: 100,
      flow: null,
      detail: null,
    });
  });
});
