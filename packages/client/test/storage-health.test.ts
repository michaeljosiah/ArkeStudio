import assert from "node:assert/strict";
import { it } from "node:test";
import { DomainEventSchema, type StorageHealthSnapshot } from "@arke-studio/contracts";
import { __applyForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("folds the same measured storage state carried by reconnect snapshots", () => {
  const health: StorageHealthSnapshot = { at: 600_000, writing: true, limited: false, admission: { state: "reconciling", reservations: 1, uncertain: 1 }, roots: [{
    rootId: "root-a", role: "generated-media", state: "unavailable", capacity: null, source: "host-provided", limitations: ["probe-failed"], pressure: null, forecast: null,
  }] };
  const event = DomainEventSchema.parse({ type: "storage.health", at: "2026-10-26T14:00:00Z", health });
  const state = __applyForTest(structuredClone(FIXTURE_STATE), event);
  assert.deepEqual(state.app.storageHealth, health);
  assert.deepEqual(state.world, FIXTURE_STATE.world);
});
