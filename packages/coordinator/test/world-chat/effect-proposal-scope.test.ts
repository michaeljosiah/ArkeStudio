import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldChatSubject } from "@arke-studio/contracts";
import { effectOnlyTurnProblem } from "../../src/world-chat/effect-proposal-scope.js";

test("effects-only scope fences every sibling authored result channel before preparation", () => {
  const subject: WorldChatSubject = { kind: "effect-arrangement", scope: { kind: "effects-only", target: { kind: "composition" },
    range: { startFrame: 0, endFrame: 240 }, audio: { kind: "off" }, direction: "Soft atmosphere", palette: [{ id: "dust", version: 1 }] } };
  const result = { actions: [{ kind: "production-effects-propose" }], editorRequests: [], bibleEdits: [], sceneEdits: [], candidates: [], groups: [], tombstones: [] };
  assert.equal(effectOnlyTurnProblem(subject, result), null);
  assert.equal(effectOnlyTurnProblem(undefined, result), null, "ordinary chat may prepare the same effects-only result");
  for (const key of ["editorRequests", "bibleEdits", "sceneEdits", "candidates", "groups", "tombstones"] as const) {
    assert.match(effectOnlyTurnProblem(subject, { ...result, [key]: [{}] })!, /effects-only/, key);
    assert.match(effectOnlyTurnProblem(undefined, { ...result, [key]: [{}] })!, /effects-only/, `chat ${key}`);
  }
  for (const key of ["setupUpdate", "productionPlan"] as const) assert.match(effectOnlyTurnProblem(subject, { ...result, [key]: {} })!, /effects-only/);
  for (const kind of ["production-audio-edit", "production-timeline-operation", "production-scene-command", "canon-retire"]) {
    assert.match(effectOnlyTurnProblem(subject, { ...result, actions: [...result.actions, { kind }] })!, /effects-only/);
    assert.equal(effectOnlyTurnProblem(undefined, { ...result, actions: [{ kind }] }), null, "ordinary requests retain their existing scope");
  }
});
