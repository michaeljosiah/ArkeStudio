import assert from "node:assert/strict";
import { it } from "node:test";
import { localAiSetupReadiness, SetupComponentSchema, type SetupComponentState } from "../src/setup.js";

const component = (id: string, state: SetupComponentState = "present") => SetupComponentSchema.parse({
  id, displayName: id, purpose: "Runtime", sizeMb: 1, installLocation: "/runtime", state,
});
const healthy = { state: "ready", source: "managed", detail: null };
const components = [component("comfyui-runtime"), component("ollama-runtime")];

it("requires installation and healthy selected services for both runtimes, independently of optional models", () => {
  assert.equal(localAiSetupReadiness(components, healthy, healthy).ready, true);
  assert.equal(localAiSetupReadiness([...components, component("optional-model", "failed")], healthy, healthy).ready, true);
  for (const state of ["queued", "installing", "paused", "failed", "blocked", "skipped"] as const) {
    assert.equal(localAiSetupReadiness([component("comfyui-runtime", state), components[1]!], healthy, healthy).ready, false, state);
  }
  for (const state of ["starting", "failed", "stopped", "absent", "unreachable", "incompatible"]) {
    assert.equal(localAiSetupReadiness(components, { ...healthy, state }, healthy).ready, false, state);
    assert.equal(localAiSetupReadiness(components, healthy, { ...healthy, state }).ready, false, state);
  }
  assert.equal(localAiSetupReadiness(components, healthy).ready, false);
  assert.equal(localAiSetupReadiness([], healthy, healthy).ready, false);
  assert.equal(localAiSetupReadiness(components, { ...healthy, source: "absent" }, healthy).ready, false);
});

it("accepts explicit existing installs only when healthy, and readiness is revoked on health loss", () => {
  const external = { ...healthy, source: "user-url" };
  assert.equal(localAiSetupReadiness(components, { ...healthy, source: "user-path" }, external).ready, true);
  const result = localAiSetupReadiness(components, external, { ...external, state: "failed", detail: "Not answering." });
  assert.equal(result.ready, false);
  assert.equal(result.engines.ollama.installed, true);
  assert.equal(result.engines.ollama.healthy, false);
  assert.equal(result.engines.ollama.detail, "Not answering.");
});
