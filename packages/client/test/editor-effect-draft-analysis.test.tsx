import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, defaultEffectClip, projectEffectLayers, type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { useHumanEffectDraft } from "../src/screens/editor-effect-draft.js";
import { useEffectAnalyses, type EffectAnalysisContext } from "../src/screens/editor-effect-analysis.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const sent: Array<{ kind: string; action?: string }> = [];
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); __setBridgeForTest(null); sent.length = 0; });
async function render(node: React.ReactNode) {
  if (!root) { const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement); }
  await act(async () => root!.render(node));
}
function fixture() {
  const state = structuredClone(FIXTURE_STATE), production = state.world!.productions[0]!;
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 1, startFrame: 0, durationFrames: 240 });
  effect.audioInput = { kind: "composition-mix" };
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, tracks: [
    { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
    { id: "tr_audio", kind: "audio", name: "Audio", order: 1, muted: false, clips: [] },
    { id: "tr_fx", kind: "effect", name: "Effects", order: 2, muted: false, clips: [], effects: [effect] },
  ] };
  const plan: RenderPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 10, revision: 0, range: { startSec: 0, endSec: 10 }, scope: { kind: "production" }, mix: DEFAULT_MIX, speech: [], subtitles: null,
    effectRender: { rendererVersion: "software-rgba-v1", width: 1280, height: 720, frameRate: 24, startFrame: 0, endFrame: 240, pictureLayers: [], ...projectEffectLayers(timeline) } };
  const context: EffectAnalysisContext = { worldId: state.world!.meta.worldId, production, artifacts: [], timeline };
  state.effectAnalyses = [{ worldId: context.worldId, productionId: production.meta.id, canPrepare: true, byEffectId: { cl_dust: { status: "off" } } }];
  __setStateForTest(state);
  __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  return { timeline, effect, plan, context };
}
function Draft({ timeline, plan, selection }: { timeline: ProductionTimeline; plan: RenderPlan; selection: string }) {
  const result = useHumanEffectDraft(timeline, selection, plan, () => {});
  return <><button onClick={() => result.preview([{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: .9 } } }])}>Preview</button>
    <output>{result.draft ? "draft" : "saved"}</output></>;
}
test("a cancelled selection/base never resurrects an earlier human effect gesture", async () => {
  const f = fixture();
  await render(<Draft timeline={f.timeline} plan={f.plan} selection="cl_dust" />);
  await act(async () => dom.document.querySelector("button")!.click()); assert.equal(dom.document.querySelector("output")!.textContent, "draft");
  await render(<Draft timeline={f.timeline} plan={f.plan} selection="cl_other" />); assert.equal(dom.document.querySelector("output")!.textContent, "saved");
  await render(<Draft timeline={f.timeline} plan={f.plan} selection="cl_dust" />); assert.equal(dom.document.querySelector("output")!.textContent, "saved");
  await act(async () => dom.document.querySelector("button")!.click());
  await render(<Draft timeline={{ ...f.timeline, revision: 1 }} plan={f.plan} selection="cl_dust" />);
  await render(<Draft timeline={f.timeline} plan={f.plan} selection="cl_dust" />); assert.equal(dom.document.querySelector("output")!.textContent, "saved");
  assert.deepEqual(sent, [], "transient preview never sends authored or analysis commands");
});
function Analyses({ context, plan }: { context: EffectAnalysisContext; plan: RenderPlan }) {
  const result = useEffectAnalyses(context, plan, 50);
  return <output>{result.readiness.map(row => row.state.status).join(",")}</output>;
}
test("preview cannot start saved analysis for an unsaved On or binding; saving the exact binding enables preparation", async () => {
  const f = fixture();
  const draftEffect = { ...f.effect, reaction: { ...f.effect.reaction, enabled: true } };
  const draft = { ...f.plan, effectRender: { ...f.plan.effectRender!, effectLayers: [{ trackId: "tr_fx", trackOrder: 2, effect: draftEffect }] } };
  await render(<Analyses context={f.context} plan={draft} />); assert.equal(sent.length, 0); assert.equal(dom.document.querySelector("output")!.textContent, "source-changed");
  const saved = structuredClone(f.timeline); saved.tracks[2]!.effects![0]!.reaction.enabled = true;
  const savedContext = { ...f.context, timeline: saved };
  await render(<Analyses context={savedContext} plan={draft} />);
  assert.equal(sent.filter(value => value.kind === "editor-effect-analysis" && value.action === "prepare").length, 1);
  const rebound = { ...draft, effectRender: { ...draft.effectRender, effectLayers: [{ ...draft.effectRender.effectLayers[0]!, effect: { ...draftEffect, audioInput: { kind: "audio-track" as const, trackId: "tr_audio" } } }] } };
  await render(<Analyses context={savedContext} plan={rebound} />);
  assert.equal(sent.length, 1, "an unsaved binding must not prepare the old saved source under the new label");
});
