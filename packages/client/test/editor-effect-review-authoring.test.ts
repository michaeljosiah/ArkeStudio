import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultEffectClip, seedStoryPictureTimeline, type ClientState } from "@arke-studio/contracts";
import { effectReviewCommandIntent, effectReviewTimeline } from "../src/lib/editor-effect-review-authoring.js";
import { FIXTURE_STATE } from "./fixture-state.js";

test("review projection replaces only effects, retaining canonical media and history identity", () => {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const current = seedStoryPictureTimeline(state.world!.productions[0]!);
  const before = JSON.stringify(current), picture = current.tracks[0]!;
  const effect = defaultEffectClip({ id: "cl_pending", lineageId: "ef_pending", startFrame: 0, durationFrames: 120, seed: 1 });
  const pending = effectReviewTimeline(current, { state: { tracks: [{ id: "tr_fx", name: "Effects", order: 20, muted: false, effects: [effect] }], protection: [] } });
  assert.equal(pending.tracks[0], picture);
  assert.equal(pending.mix, current.mix);
  assert.equal(pending.library, current.library);
  assert.equal(pending.history, current.history);
  assert.equal(pending.revision, current.revision);
  assert.equal(pending.tracks.at(-1)!.effects![0], effect);
  assert.equal(JSON.stringify(current), before);
});

test("pending command sink keeps human Release explicit and refuses picture or sound authoring", () => {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const current = seedStoryPictureTimeline(state.world!.productions[0]!);
  assert.deepEqual(effectReviewCommandIntent(current, [{ kind: "effect-release", ruleId: "pr_amount" }]),
    { ok: true, intent: { kind: "release", ruleId: "pr_amount" } });
  assert.equal(effectReviewCommandIntent(current, [{ kind: "set-mix", mix: { speechFirst: true } }]).ok, false);
  assert.equal(effectReviewCommandIntent(current, [{ kind: "set-track", trackId: current.tracks[0]!.id, muted: true }]).ok, false);
  assert.equal(effectReviewCommandIntent(current, [{ kind: "effect-patch", clipId: "cl_fx", patch: { appearance: { amount: .3 } } }]).ok, true);
  assert.equal(effectReviewCommandIntent(current, [{ kind: "effect-release", ruleId: "pr_amount" },
    { kind: "effect-patch", clipId: "cl_fx", patch: { appearance: { amount: .3 } } }]).ok, false);
});
