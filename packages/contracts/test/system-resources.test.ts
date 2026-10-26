import assert from "node:assert/strict";
import { it } from "node:test";
import { SystemResourcesSchema, resourceFresh, unavailableSystemResources } from "../src/system-resources.js";

it("keeps zero utilisation measured, rejects invalid or identifying payloads, and expires old/future readings", () => {
  const snapshot = unavailableSystemResources(10_000);
  snapshot.cpu = { source: "node-os", state: "measured", measuredAt: 10_000, value: 0 };
  assert.equal(resourceFresh(SystemResourcesSchema.parse(snapshot).cpu, 10_000), true);
  assert.equal(resourceFresh(snapshot.cpu, 26_000), false);
  assert.equal(resourceFresh(snapshot.cpu, 9_000), false);
  assert.equal(SystemResourcesSchema.safeParse({ ...snapshot, hostname: "private-pc" }).success, false);
  assert.equal(SystemResourcesSchema.safeParse({ ...snapshot, cpu: { ...snapshot.cpu, value: 101 } }).success, false);
  assert.equal(SystemResourcesSchema.safeParse({ ...snapshot, cpu: { ...snapshot.cpu, value: null } }).success, false);
  assert.equal(SystemResourcesSchema.safeParse({ ...snapshot, memory: { source: "node-os", state: "measured", measuredAt: 10_000, value: { usedBytes: 11, totalBytes: 10 } } }).success, false);
});
