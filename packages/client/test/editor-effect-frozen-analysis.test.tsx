import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { buildRenderPlan, defaultEffectClip, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { effectAnalysisRow, effectManifestContextProblem, type EffectAnalysisContext } from "../src/lib/editor-effect-analysis-context.js";
import { useEffectAnalyses } from "../src/screens/editor-effect-analysis.js";
import { useSelectedEffectAnalysis } from "../src/screens/editor-effect-selected-analysis.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { analysisManifest } from "./effect-analysis-fixture.js";
import { effectProposalFixture } from "./effect-proposal-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [], originalFetch = globalThis.fetch;
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); globalThis.fetch = originalFetch; __setBridgeForTest(null); });
function fixture() {
  const state = structuredClone(FIXTURE_STATE) as ClientState, production = state.world!.productions[0]!;
  const timeline = seedStoryPictureTimeline(production), effect = defaultEffectClip({ id: "cl_fx", lineageId: "ef_fx", seed: 42,
    startFrame: 0, durationFrames: 240, preset: "lights" });
  effect.audioInput = { kind: "composition-mix" }; effect.reaction.enabled = true;
  timeline.tracks.push({ id: "tr_effects", kind: "effect", name: "Effects", order: 20, muted: false, clips: [], effects: [effect] });
  production.timeline = { status: "ready", timeline };
  const built = buildRenderPlan({ production, timeline: production.timeline, artifacts: state.world!.artifacts,
    scope: { kind: "production" }, preset: "review-cut" }); assert.ok(built.ok);
  const manifest = analysisManifest(0.5), proposal = effectProposalFixture();
  const context: EffectAnalysisContext = { worldId: state.world!.meta.worldId, production, timeline, artifacts: state.world!.artifacts,
    frozen: { ref: { familyId: proposal.family.id, versionId: proposal.version.id, candidateHash: proposal.version.candidateHash, decisionRevision: 0 },
      frameRate: 24, startFrame: 0, endFrame: 240, dependencies: { ...proposal.version.dependencies, reactions: [{ effectId: effect.id,
        status: "ready", binding: effect.audioInput, requestFingerprint: "frozen-request", manifestKey: manifest.manifestKey,
        sourceFingerprint: manifest.sourceFingerprint, decoder: manifest.descriptor.native.decoder }] } } };
  return { state, production, timeline, effect, context, plan: built.plan, manifest };
}
describe("frozen proposal reaction analysis (SPEC-053 R-16, R-31–36)", () => {
  it("uses only the exact candidate manifest and never sends Current preparation or cancellation", async () => {
    const { state, context, plan, effect, manifest } = fixture(), sent: ClientMessage[] = [], fetched: string[] = [];
    state.effectAnalyses = [{ worldId: context.worldId, productionId: context.production.meta.id, canPrepare: true,
      byEffectId: { [effect.id]: { status: "source-changed", reason: "Current has another binding" } } }];
    __setStateForTest(state); __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } });
    globalThis.fetch = async input => { fetched.push(String(input)); return new Response(JSON.stringify(manifest)); };
    let preview!: ReturnType<typeof useEffectAnalyses>, selected!: ReturnType<typeof useSelectedEffectAnalysis>;
    function Probe() { preview = useEffectAnalyses(context, plan, 20); selected = useSelectedEffectAnalysis(effect, context, plan); return null; }
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<Probe />));
    for (let i = 0; i < 30 && (!selected.manifest || preview.readiness[0]?.preview !== "ready"); i++) await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
    assert.equal(selected.manifest?.manifestKey, manifest.manifestKey); assert.equal(preview.sources.manifestKeyByEffectId[effect.id], manifest.manifestKey);
    assert.ok(fetched.every(url => url.includes(manifest.manifestKey))); assert.deepEqual(sent, []);
    assert.equal(selected.retry, null); assert.equal(selected.cancel, null); assert.equal(preview.readiness[0]!.cancel, null);
  });
  it("keeps blocked candidate analysis blocked despite a ready Current row", () => {
    const { context, plan, effect, manifest } = fixture();
    context.frozen!.dependencies.reactions = [{ effectId: effect.id, status: "required", binding: effect.audioInput!, reason: "Analysis is unavailable in this version" }];
    const row = effectAnalysisRow(effect, context, plan, { status: "ready", manifestKey: manifest.manifestKey,
      sourceFingerprint: manifest.sourceFingerprint, requestFingerprint: "current", silent: false, cueConflicts: [] });
    assert.equal(row.state.status, "source-changed"); assert.equal(row.canRequest, false); assert.equal(row.source, null);
    assert.match("reason" in row.state ? row.state.reason : "", /this version/);
  });
  it("retains prepared response data for appearance edits and clears it for transient binding changes", () => {
    const { context, plan, effect } = fixture();
    assert.equal(effectAnalysisRow({ ...effect, appearance: { ...effect.appearance, amount: 0.24 } }, context, plan).state.status, "ready");
    const changed = effectAnalysisRow({ ...effect, audioInput: { kind: "audio-track", trackId: "tr_other" } }, context, plan);
    assert.equal(changed.state.status, "source-changed"); assert.equal(changed.canRequest, false);
    context.frozen!.staleReason = "Current audio changed. Update this proposal.";
    assert.equal(effectAnalysisRow(effect, context, plan).state.status, "source-changed");
  });
  it("validates frozen frame range and native decoder, and never reuses mismatched feature arrays", () => {
    const { context, effect, manifest, plan } = fixture();
    assert.equal(effectManifestContextProblem(manifest, effect, context, plan), null);
    assert.match(effectManifestContextProblem(manifest, effect, { ...context, frozen: { ...context.frozen!, endFrame: 241 } }, plan)!, /delivery range/);
    const row = context.frozen!.dependencies.reactions[0]!; assert.equal(row.status, "ready"); if (row.status !== "ready") return;
    row.decoder = { ...row.decoder, executableHash: "0".repeat(64) };
    assert.match(effectManifestContextProblem(manifest, effect, context, plan)!, /decoder/);
  });
  it("labels silence using the loaded frozen manifest, with no Current fallback", async () => {
    const values = fixture(), manifest = analysisManifest(0), { context, plan, effect, state } = values;
    const row = context.frozen!.dependencies.reactions[0]!; assert.equal(row.status, "ready"); if (row.status !== "ready") return;
    row.manifestKey = manifest.manifestKey; row.sourceFingerprint = manifest.sourceFingerprint;
    __setStateForTest(state); globalThis.fetch = async () => new Response(JSON.stringify(manifest));
    let selected!: ReturnType<typeof useSelectedEffectAnalysis>;
    function Probe() { selected = useSelectedEffectAnalysis(effect, context, plan); return null; }
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<Probe />));
    for (let i = 0; i < 30 && !selected.manifest; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
    assert.equal(selected.state.status === "ready" && selected.state.silent, true);
  });
});
