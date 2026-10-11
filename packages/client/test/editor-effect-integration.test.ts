import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTimelineCommands, buildRenderPlan, defaultEffectClip, resolveEffectAudioSource, seedStoryPictureTimeline,
  type ClientState, type EffectAnalysisState } from "@arke-studio/contracts";
import { effectDraftPlan, previewHumanEffects } from "../src/lib/editor-effect-authoring.js";
import { effectExportRefusal } from "../src/lib/editor-effect-export.js";
import { PreviewReactionBank, previewReactionMappingKey, renderPreviewFrame, type PreviewFrameRequest } from "../src/lib/editor-preview-frame.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { analysisManifest } from "./effect-analysis-fixture.js";

function fixture() {
  const state = structuredClone(FIXTURE_STATE) as ClientState, production = state.world!.productions[0]!;
  const timeline = seedStoryPictureTimeline(production);
  const effect = defaultEffectClip({ id: "cl_fx", lineageId: "ef_fx", seed: 42, startFrame: 0, durationFrames: 240, preset: "lights" });
  effect.audioInput = { kind: "composition-mix" }; effect.reaction.enabled = true;
  timeline.tracks.push({ id: "tr_effects", kind: "effect", name: "Effects", order: 20, muted: false, clips: [], effects: [effect] });
  production.timeline = { status: "ready", timeline };
  const artifacts = state.world!.artifacts;
  const built = buildRenderPlan({ production, timeline: production.timeline, artifacts, scope: { kind: "production" }, preset: "review-cut" });
  assert.ok(built.ok);
  return { production, artifacts, timeline, effect, canonical: built.plan };
}

describe("manual effect integration (SPEC-053 R-8, R-16, R-25)", () => {
  it("previews a protected human edit without changing its saved baseline or the canonical sound plan", () => {
    const { timeline, canonical, effect } = fixture();
    const protectedTimeline = applyTimelineCommands(timeline, [{ kind: "effect-protect", rule: { id: "pr_amount", kind: "property",
      lineageId: effect.lineageId, property: "appearance.amount", scope: { kind: "whole" } } }], { effectAuthority: "human" });
    const before = JSON.stringify(protectedTimeline);
    const result = previewHumanEffects(protectedTimeline, [{ kind: "effect-patch", clipId: effect.id, patch: { appearance: { amount: 0.7 } } }]);
    assert.ok(result.ok);
    const projected = effectDraftPlan(canonical, result.timeline); assert.ok(projected.ok);
    assert.equal(projected.plan.audio, canonical.audio);
    assert.equal(projected.plan.items, canonical.items);
    assert.equal(projected.plan.effectRender!.pictureLayers, canonical.effectRender!.pictureLayers);
    assert.equal(projected.plan.effectRender!.effectLayers[0]!.effect.appearance.amount, 0.7);
    assert.equal(projected.plan.totalSec, canonical.totalSec);
    assert.equal(JSON.stringify(protectedTimeline), before, "a preview cannot persist a history entry or baseline");
  });

  it("checks only delivered effects while preserving full-production audio fingerprints", () => {
    const input = fixture(), { effect, canonical } = input;
    const source = resolveEffectAudioSource({ ...input, plan: canonical, input: effect.audioInput! }); assert.ok(source.ok);
    const manifest = analysisManifest();
    const states: Record<string, EffectAnalysisState> = { [effect.id]: { status: "ready", requestFingerprint: source.requestFingerprint,
      sourceFingerprint: manifest.sourceFingerprint, manifestKey: manifest.manifestKey, silent: true, cueConflicts: [] } };
    const delivery = { ...canonical, totalSec: 2, effectRender: { ...canonical.effectRender!, startFrame: 48, endFrame: 96 } };
    assert.equal(effectExportRefusal({ ...input, delivery, states }), null);
    assert.match(effectExportRefusal({ ...input, delivery, states: {} })!, /Source changed/);
    const outside = { ...delivery, effectRender: { ...delivery.effectRender, startFrame: 240, endFrame: 300 } };
    assert.equal(effectExportRefusal({ ...input, delivery: outside, states: {} }), null);
    const gap = { ...delivery, effectRender: { ...delivery.effectRender, pictureLayers: [], effectLayers: [{ ...delivery.effectRender.effectLayers[0]!,
      effect: { ...effect, target: { kind: "picture-track" as const, trackId: "tr_picture" } } }] } };
    assert.equal(effectExportRefusal({ ...input, delivery: gap, states: {} }), null, "a scoped target gap consumes no analysis");
    input.timeline.mix = { ...input.timeline.mix, speechFirst: !input.timeline.mix.speechFirst };
    const changed = { ...canonical, mix: input.timeline.mix };
    assert.match(effectExportRefusal({ ...input, canonical: changed, delivery, states })!, /Source changed/);
  });

  it("reuses retained analysis arrays for response gestures and invalidates only relevant preparation", () => {
    const { effect } = fixture(), manifest = analysisManifest();
    effect.appearance = { ...effect.appearance, amount: 1, size: 1 };
    effect.reaction = { ...effect.reaction, strength: 1, energy: 1, limit: 1 };
    const sources = { manifestsByKey: { [manifest.manifestKey]: manifest }, manifestKeyByEffectId: { [effect.id]: manifest.manifestKey } };
    const range = { startFrame: 0, endFrame: 240 };
    const originalKey = previewReactionMappingKey([effect], sources, range);
    const appearance = { ...effect, appearance: { ...effect.appearance, amount: 0.2 } };
    assert.equal(previewReactionMappingKey([appearance], sources, range), originalKey);
    const changed = { ...effect, reaction: { ...effect.reaction, strength: 0 } };
    assert.notEqual(previewReactionMappingKey([changed], sources, range), originalKey);
    const bank = new PreviewReactionBank();
    bank.install({ kind: "analysis", analysisEpoch: 1, effects: [effect], ...range, ...sources });
    bank.install({ kind: "analysis", analysisEpoch: 2, effects: [changed], ...range, manifestKeyByEffectId: sources.manifestKeyByEffectId });
    const request: PreviewFrameRequest = { id: 1, generation: 0, analysisEpoch: 2, absoluteFrame: 100, frameRate: 24, width: 96, height: 54, pictures: [], composition: [changed] };
    assert.deepEqual(bank.render(request), renderPreviewFrame(request));
    bank.install({ kind: "analysis", analysisEpoch: 3, effects: [effect], ...range, manifestKeyByEffectId: sources.manifestKeyByEffectId });
    assert.notDeepEqual(bank.render({ ...request, analysisEpoch: 3, composition: [effect] }), renderPreviewFrame({ ...request, composition: [effect] }));
  });
});
