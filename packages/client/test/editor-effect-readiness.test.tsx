import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { defaultEffectClip, resolveEffectAudioSource, seedStoryPictureTimeline,
  type ClientMessage, type ClientState, type EffectAnalysisState, type RenderPlan } from "@arke-studio/contracts";
import { __applyForTest, __setBridgeForTest, __setStateForTest, useStore } from "../src/lib/store.js";
import { effectPreviewAnalysisState, useEffectAnalyses, type EffectAnalysisContext } from "../src/screens/editor-effect-analysis.js";
import { useRenderPlan } from "../src/screens/editor-plan.js";
import { EditorPicturePreview } from "../src/screens/editor-picture-preview.js";
import { PreviewReactionBank, type PreviewAnalysisInstall, type PreviewFrameRequest, type PreviewReactionSources } from "../src/lib/editor-preview-frame.js";
import type { Transport } from "../src/screens/editor-transport.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { analysisManifest } from "./effect-analysis-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
const roots: Root[] = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); globalThis.fetch = originalFetch; __setBridgeForTest(null);
});
function mount() { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root); return { root, container }; }
function fixture() {
  const state = structuredClone(FIXTURE_STATE) as ClientState, production = state.world!.productions[0]!;
  const timeline = seedStoryPictureTimeline(production);
  const effect = defaultEffectClip({ id: "cl_fx", lineageId: "ef_fx", seed: 42, startFrame: 0, durationFrames: 240, preset: "lights" });
  effect.audioInput = { kind: "composition-mix" }; effect.reaction.enabled = true;
  timeline.tracks.push({ id: "tr_effects", kind: "effect", name: "Effects", order: 20, muted: false, solo: false, clips: [], effects: [effect] });
  production.timeline = { status: "ready", timeline };
  const context: EffectAnalysisContext = { worldId: state.world!.meta.worldId, production, timeline, artifacts: state.world!.artifacts };
  return { state, context, effect };
}

describe("derived effect readiness in the editor (SPEC-053 R-14–16)", () => {
  it("requires the current resolved source hint and treats missing/Off sources explicitly", () => {
    const { effect } = fixture(), manifest = analysisManifest();
    const ready: EffectAnalysisState = { status: "ready", requestFingerprint: "current", sourceFingerprint: manifest.sourceFingerprint,
      manifestKey: manifest.manifestKey, silent: false, cueConflicts: [] };
    assert.equal(effectPreviewAnalysisState(effect, "current", ready), ready);
    assert.equal(effectPreviewAnalysisState(effect, "changed", ready).status, "source-changed");
    assert.equal(effectPreviewAnalysisState(effect, "current", ready, "The placed clip was removed").status, "missing-source");
    effect.reaction.enabled = false;
    assert.equal(effectPreviewAnalysisState(effect, "current", ready).status, "off");
    effect.reaction.enabled = true; delete effect.audioInput;
    assert.equal(effectPreviewAnalysisState(effect, null, undefined).status, "no-source");
  });

  it("prepares once, offers explicit cancel/retry, loads Ready independently and preserves the audio plan", async () => {
    const { state, context } = fixture(), sent: ClientMessage[] = [];
    const manifest = analysisManifest(); globalThis.fetch = async () => new Response(JSON.stringify(manifest));
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } });
    state.effectAnalyses = [{ worldId: context.worldId, productionId: context.production.meta.id, canPrepare: true, byEffectId: {} }];
    __setStateForTest(state);
    let latest!: ReturnType<typeof useEffectAnalyses>, plan!: RenderPlan;
    function Probe() {
      useStore();
      const result = useRenderPlan({ production: context.production, artifacts: context.artifacts, timelineState: context.production.timeline!, timeline: context.timeline,
        timelineError: null, subtitleView: null, subtitleHidden: false }).renderPlan;
      assert.ok(result?.ok); plan = result.plan;
      latest = useEffectAnalyses(context, plan, 30); return null;
    }
    const { root } = mount(); await act(async () => root.render(<Probe />));
    const stablePlan = plan;
    const fingerprint = resolveEffectAudioSource({ ...context, plan, input: { kind: "composition-mix" } }).requestFingerprint;
    const set = async (row: EffectAnalysisState, canPrepare = true) => {
      state.effectAnalyses = [{ worldId: context.worldId, productionId: context.production.meta.id, canPrepare, byEffectId: { cl_fx: row } }];
      await act(async () => __setStateForTest({ ...state }));
    };
    assert.equal(sent.length, 1); assert.equal(sent[0]?.kind, "editor-effect-analysis");
    await set({ status: "source-changed", requestFingerprint: fingerprint, reason: "Needs analysis" });
    assert.equal(sent.length, 1, "a metadata echo cannot enqueue duplicate work");
    await set({ status: "analysing", requestFingerprint: fingerprint, progress: 0.5 });
    assert.ok(latest.readiness[0]!.cancel); latest.readiness[0]!.cancel!();
    const cancel = sent.at(-1); assert.equal(cancel?.kind === "editor-effect-analysis" && cancel.action, "cancel");
    await set({ status: "failed", requestFingerprint: fingerprint, reason: "Cancelled" });
    assert.ok(latest.readiness[0]!.retry); latest.readiness[0]!.retry!();
    const retry = sent.at(-1); assert.equal(retry?.kind === "editor-effect-analysis" && retry.action, "retry");
    await set({ status: "missing-source", requestFingerprint: fingerprint, reason: "The placed sound file is missing" });
    assert.ok(latest.readiness[0]!.retry, "a restored physical file can be retried while its placed binding remains valid");
    latest.readiness[0]!.retry!();
    const restored = sent.at(-1); assert.equal(restored?.kind === "editor-effect-analysis" && restored.action, "retry");
    await set({ status: "ready", requestFingerprint: fingerprint, sourceFingerprint: manifest.sourceFingerprint, manifestKey: manifest.manifestKey, silent: false, cueConflicts: [] });
    for (let count = 0; count < 20 && latest.readiness[0]!.preview !== "ready"; count++) await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
    assert.equal(latest.readiness[0]!.preview, "ready");
    assert.equal(latest.sources.manifestKeyByEffectId.cl_fx, manifest.manifestKey);
    assert.equal(plan, stablePlan, "readiness cannot rebuild/restart the soundtrack owner");
    assert.equal(sent.filter(row => row.kind === "timeline-command").length, 0);
    const beforeFileChange = sent.length;
    await set({ status: "source-changed", requestFingerprint: fingerprint, previousManifestKey: manifest.manifestKey, reason: "Audio file changed" });
    assert.equal(sent.length, beforeFileChange + 1, "the same placement hint can need fresh analysis after its raw file changes");
    assert.equal(latest.readiness[0]!.preview, "base");
    const count = sent.length;
    await set({ status: "source-changed", requestFingerprint: "stale", reason: "Changed" }, false);
    assert.equal(latest.readiness[0]!.preview, "base");
    assert.deepEqual(latest.sources.manifestKeyByEffectId, {});
    assert.equal(sent.length, count, "read-only capability cannot prepare or retry");
    assert.equal(latest.readiness[0]!.retry, null);
  });

  it("folds metadata by world and production without replacing timeline/production identities", () => {
    const { state, context } = fixture();
    const row = { worldId: context.worldId, productionId: context.production.meta.id, canPrepare: true, byEffectId: {} };
    const other = { ...row, productionId: "another-production" };
    state.effectAnalyses = [row, other];
    const next = __applyForTest(state, { type: "editor-effect.analysis", at: "2026-10-11T00:00:00Z", worldId: row.worldId, productionId: row.productionId,
      analysis: { ...row, byEffectId: { cl_fx: { status: "analysing", requestFingerprint: "one" } } } });
    assert.equal(next.world, state.world); assert.equal(next.world!.productions[0], context.production);
    assert.equal(next.effectAnalyses!.find(value => value.productionId === other.productionId), other);
    const removed = __applyForTest(next, { type: "editor-effect.analysis", at: "2026-10-11T00:00:00Z", worldId: row.worldId, productionId: row.productionId, analysis: null });
    assert.deepEqual(removed.effectAnalyses, [other]);
  });

  it("installs analysis once and redraws a paused frame without replacing the source worker", async () => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      listeners = new Set<(event: { data: unknown }) => void>(); requests: Array<PreviewFrameRequest | PreviewAnalysisInstall> = []; bank = new PreviewReactionBank();
      delay = false; held: unknown[] = [];
      constructor() { workers.push(this); }
      addEventListener(type: string, callback: (event: { data: unknown }) => void) { if (type === "message") this.listeners.add(callback); }
      removeEventListener(_type: string, callback: (event: { data: unknown }) => void) { this.listeners.delete(callback); }
      postMessage(message: PreviewFrameRequest | PreviewAnalysisInstall) {
        this.requests.push(message);
        let data: unknown;
        if ("kind" in message) { this.bank.install(message); data = { kind: "analysis-ready", analysisEpoch: message.analysisEpoch }; }
        else data = { ...message, pixels: this.bank.render(message) };
        if (this.delay) this.held.push(data);
        else queueMicrotask(() => this.deliver(data));
      }
      deliver(data: unknown) { for (const listener of this.listeners) listener({ data }); }
      terminate() {}
    }
    Object.assign(globalThis, { Worker: FakeWorker });
    const canvasPrototype = Object.getPrototypeOf(document.createElement("canvas"));
    canvasPrototype.getContext = () => ({ createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {} });
    const { effect } = fixture();
    const projection = { rendererVersion: "software-rgba-v1" as const, frameRate: 24, width: 64, height: 36, startFrame: 0, endFrame: 240,
      pictureLayers: [], effectLayers: [{ trackId: "tr_effects", trackOrder: 0, effect }], issues: [] };
    const transport = { time: 2, timeRef: { current: 2 }, playing: false, seek() {}, setPlaying() {} } as unknown as Transport;
    const urlFor = () => null;
    const { root, container } = mount();
    await act(async () => root.render(<EditorPicturePreview projection={projection} transport={transport} urlFor={urlFor} />));
    const canvas = container.querySelector("canvas")!;
    assert.equal(canvas.dataset.frame, "48"); const oldEpoch = canvas.dataset.analysisEpoch;
    const manifest = analysisManifest();
    const sources: PreviewReactionSources = { manifestsByKey: { [manifest.manifestKey]: manifest }, manifestKeyByEffectId: { [effect.id]: manifest.manifestKey } };
    await act(async () => root.render(<EditorPicturePreview projection={projection} transport={transport} urlFor={urlFor} reactions={sources} />));
    assert.equal(workers.length, 1); assert.equal(canvas.dataset.frame, "48"); assert.notEqual(canvas.dataset.analysisEpoch, oldEpoch);
    const installs = workers[0]!.requests.filter(row => "kind" in row).length;
    await act(async () => root.render(<EditorPicturePreview projection={projection} transport={transport} urlFor={urlFor} reactions={sources} />));
    assert.equal(workers[0]!.requests.filter(row => "kind" in row).length, installs, "ordinary component renders never resend long-song arrays");
    const worker = workers[0]!; worker.delay = true;
    for (let index = 0; index < 3; index++) await act(async () => root.render(<EditorPicturePreview projection={projection} transport={transport} urlFor={urlFor}
      reactions={{ manifestsByKey: {}, manifestKeyByEffectId: {} }} />));
    assert.equal(worker.requests.filter(row => "kind" in row).length, installs + 1, "only one install can be in flight");
    assert.equal(canvas.dataset.frame, undefined, "a prior Ready frame is not represented as the pending source");
    await act(async () => worker.deliver(worker.held.shift()));
    assert.equal(worker.requests.filter(row => "kind" in row).length, installs + 2, "queued changes collapse to the latest immutable source map");
    worker.delay = false;
    await act(async () => worker.deliver(worker.held.shift()));
    assert.equal(canvas.dataset.frame, "48");
  });
});
