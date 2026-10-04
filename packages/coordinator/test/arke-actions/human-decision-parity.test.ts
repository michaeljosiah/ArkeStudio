import assert from "node:assert/strict";
import { it } from "node:test";
import { ARKE_CLIENT_COMMAND_REGISTRY, findArkeAction, modelActionCatalogue } from "../../src/arke-actions/registry.js";

it("gives every pipeline human decision an in-thread control, never a model command (SPEC-051 R-23)", () => {
  const required = {
    "plan-continue": "plan", "plan-reconfirm": "plan", "stage-construct": "stage", "stage-inspection": "stage",
    "stage-construct-cancel": "stage", "stage-review-discard": "stage", "accept-character-voice-sample": "voice-sample",
    "proposal-accept": "proposal", "proposal-discard": "proposal", "editor-request-decide": "editor-request",
    "resolve-extraction": "extraction",
  } as const;
  const catalogue = modelActionCatalogue();
  for (const [kind, family] of Object.entries(required)) {
    const descriptor = ARKE_CLIENT_COMMAND_REGISTRY[kind as keyof typeof required];
    assert.equal(descriptor.classification, "human-only-control-plane", kind);
    assert.equal(descriptor.inThreadCard, family, `${kind} must have its screen's in-thread control`);
    assert.equal(catalogue.some(entry => entry.kind === kind), false, `${kind} must stay out of model preparation`);
  }
  const stage = ARKE_CLIENT_COMMAND_REGISTRY["scene-command"];
  assert.equal(stage.inThreadCard, "stage", "the human Keep gesture uses the ordinary edit-stage scene command");
  assert.ok(stage.classification === "supported-by-arke");
  assert.equal("stageReviewId" in (stage.conversationSchema as unknown as { shape: Record<string, unknown> }).shape, false,
    "a model scene edit cannot impersonate a retained draft's human Keep receipt");
  const legacy = findArkeAction("world-chat-artifact-extraction-review")!;
  assert.ok(legacy.classification === "supported-by-arke");
  assert.equal(legacy.support.preparation.state, "blocked");
  assert.equal(legacy.support.execution.state, "blocked", "previously prepared model choices cannot execute after this boundary");
});
