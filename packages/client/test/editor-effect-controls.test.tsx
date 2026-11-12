import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { captureEffectProtectionRule, DEFAULT_MIX, defaultEffectClip, resolveEffectAudioSource, type EffectClip, type ProductionTimeline, type RenderPlan, type TimelineCommand } from "@arke-studio/contracts";
import { EffectAudioInspector, EffectCueEditor } from "../src/screens/editor-effect-audio.js";
import { EffectProtectionInspector, EFFECT_PROTECTION_LABELS } from "../src/screens/editor-effect-protection.js";
import { useSelectedEffectAnalysis } from "../src/screens/editor-effect-selected-analysis.js";
import type { EffectAnalysisContext } from "../src/screens/editor-effect-analysis.js";
import type { EffectAuthoringProps } from "../src/lib/editor-effect-authoring.js";
import { effectAudioOptions } from "../src/lib/editor-effect-audio-options.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { analysisManifest } from "./effect-analysis-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(dom.HTMLElement.prototype, { focus() {}, select() {} });
let root: Root | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); globalThis.fetch = realFetch; });
async function render(node: React.ReactNode) {
  if (!root) { const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement); }
  await act(async () => root!.render(node));
}
const button = (text: string) => { const node = [...dom.document.querySelectorAll("button")].find(value => value.textContent === text); assert.ok(node, text); return node; };
const click = async (text: string) => { await act(async () => button(text).click()); };
async function select(label: string, value: string) {
  const node = [...dom.document.querySelectorAll("label")].find(row => row.textContent?.startsWith(label))?.querySelector("select"); assert.ok(node, label);
  await act(async () => { Object.defineProperty(node, "value", { configurable: true, value }); node.dispatchEvent(new dom.Event("change", { bubbles: true })); });
}
async function type(label: string, value: string) {
  const text = [...dom.document.querySelectorAll("label")].find(row => row.textContent?.startsWith(label)); assert.ok(text, label);
  const input = dom.document.getElementById(text.getAttribute("for")!); assert.ok(input);
  await act(async () => { (input as unknown as HTMLInputElement).value = value; input.dispatchEvent(new dom.Event("input", { bubbles: true })); });
  await act(async () => { const event = new dom.Event("keydown", { bubbles: true }); Object.assign(event, { key: "Enter" }); input.dispatchEvent(event); });
}
function fixture() {
  const state = structuredClone(FIXTURE_STATE), production = state.world!.productions[0]!;
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 7, startFrame: 0, durationFrames: 240 });
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, tracks: [
    { id: "tr_picture", kind: "picture", name: "Video 1", order: 0, muted: false, clips: [
      { id: "cl_still", startFrame: 0, durationFrames: 120, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_still", label: "Still" } },
      { id: "cl_video", startFrame: 120, durationFrames: 120, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_video", label: "Waves" } },
    ] },
    { id: "tr_audio", kind: "audio", name: "Backing sound", order: 1, muted: true, clips: [{ id: "cl_audio", startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_audio", label: "Backing" } }] },
    { id: "tr_fx", kind: "effect", name: "Effects", order: 2, muted: false, clips: [], effects: [effect] },
  ] };
  const prototype = state.world!.artifacts[0]!;
  const artifacts = [
    { ...prototype, id: "ar_still", kind: "image" as const, file: "still.png", production: production.meta.id },
    { ...prototype, id: "ar_video", kind: "video" as const, file: "waves.mp4", production: production.meta.id, mediaInfo: { durationSec: 10, hasAudio: true, width: 100, height: 100 } },
    { ...prototype, id: "ar_audio", kind: "audio" as const, file: "backing.wav", production: production.meta.id, mediaInfo: { durationSec: 10, hasAudio: true } },
  ];
  const plan: RenderPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 10, revision: 0, range: { startSec: 0, endSec: 10 }, scope: { kind: "production" }, mix: DEFAULT_MIX, speech: [], subtitles: null };
  const context: EffectAnalysisContext = { worldId: state.world!.meta.worldId, production, artifacts, timeline };
  const commands: TimelineCommand[][] = [], scrubs: number[] = [];
  const props: EffectAuthoringProps = { effect, timeline, frameRate: 24, playheadFrame: 37, disabled: false, onCommands: values => commands.push(values), onPreview() {}, onScrub: frame => scrubs.push(frame) };
  __setStateForTest(state);
  return { state, context, plan, effect, timeline, commands, scrubs, props };
}

test("the source chooser names placed whole tracks, audio clips and video sound, disables stills and preserves silent sources", () => {
  const { context, plan } = fixture(), options = effectAudioOptions(context, plan);
  assert.ok(options.find(row => row.input.kind === "audio-track")?.label.includes("Whole audio track · Backing sound"));
  assert.ok(options.find(row => row.input.kind === "audio-clip")?.label.includes("currently silent"));
  assert.match(options.find(row => row.input.kind === "video-sound" && row.input.clipId === "cl_still")!.reason!, /no measured sound/);
  assert.equal(options.find(row => row.input.kind === "video-sound" && row.input.clipId === "cl_video")!.reason, undefined);
  assert.equal(resolveEffectAudioSource({ ...context, plan, input: { kind: "audio-clip", clipId: "cl_video" } }).ok, false);
  assert.equal(resolveEffectAudioSource({ ...context, plan, input: { kind: "video-sound", clipId: "cl_audio" } }).ok, false);
});
test("simple responses report protected conflicts while direct Advanced edits retain human editing", async () => {
  const f = fixture(); f.timeline.effectProtection = [captureEffectProtectionRule({ id: "pr_beat", lineageId: f.effect.lineageId, kind: "property", property: "reaction.beat", scope: { kind: "whole" } }, [f.effect], 0)];
  await render(<EffectAudioInspector {...f.props} context={f.context} plan={f.plan} />);
  await select("Response", "beat-pulse"); assert.equal(f.commands.length, 0); assert.match(dom.document.body.textContent!, /would change protected settings: beat/);
  await type("Beat weight", "65");
  assert.deepEqual(f.commands.at(-1), [{ kind: "effect-patch", clipId: f.effect.id, patch: { reaction: { beat: .65, preset: "custom" } } }]);
  await select("Audio source", JSON.stringify({ kind: "audio-clip", clipId: "cl_audio" }));
  assert.deepEqual(f.commands.at(-1), [{ kind: "effect-patch", clipId: f.effect.id, patch: { audioInput: { kind: "audio-clip", clipId: "cl_audio" } } }]);
  assert.deepEqual(f.scrubs, []);
});
test("beat movement is one durable suppression/accent edit and authored accents are independent of analysis", async () => {
  const f = fixture(), manifest = analysisManifest(); manifest.likelyBeats = [{ frame: 24, strength: .8, confidence: .7 }];
  await render(<EffectCueEditor {...f.props} manifest={manifest} />);
  await type("Move likely beat to", "2");
  const command = f.commands.at(-1)![0]!; assert.equal(command.kind, "effect-patch");
  if (command.kind === "effect-patch") assert.deepEqual(command.patch.cueOverrides!.map(cue => [cue.kind, cue.frame]), [["suppress", 24], ["accent", 48]]);
  assert.equal(f.commands.length, 1); assert.deepEqual(f.scrubs, []);
  await render(<EffectCueEditor {...f.props} manifest={null} />); await click("Add accent at playhead");
  const added = f.commands.at(-1)![0]!; assert.equal(added.kind, "effect-patch"); if (added.kind === "effect-patch") assert.equal(added.patch.cueOverrides![0]!.frame, 37);
});
test("protection separates exact outer boundaries, all individual properties, fixed coverage and named Release", async () => {
  const f = fixture(); f.timeline.tracks[2]!.effects = [{ ...f.effect, durationFrames: 120 }, { ...f.effect, id: "cl_right", startFrame: 120, durationFrames: 120 }];
  f.timeline.effectProtection = [captureEffectProtectionRule({ id: "pr_gap", lineageId: f.effect.lineageId, kind: "passage-coverage", startFrame: 0, endFrame: 300 }, f.timeline.tracks[2]!.effects, 0)];
  await render(<EffectProtectionInspector {...f.props} />);
  assert.equal(dom.document.querySelectorAll("select")[0]!.querySelectorAll("option").length, Object.keys(EFFECT_PROTECTION_LABELS).length);
  assert.match(dom.document.body.textContent!, /Uncovered passage:.*10.*12/);
  const end = [...dom.document.querySelectorAll("button")].find(value => value.textContent?.startsWith("Protect exact End"))!;
  await act(async () => end.click());
  assert.equal(f.commands.at(-1)![0]!.kind, "effect-protect");
  const command = f.commands.at(-1)![0]!; if (command.kind === "effect-protect") assert.deepEqual({ kind: command.rule.kind, ...("boundary" in command.rule ? { boundary: command.rule.boundary } : {}) }, { kind: "boundary", boundary: "end" });
  await click("Release Passage coverage"); assert.deepEqual(f.commands.at(-1), [{ kind: "effect-release", ruleId: "pr_gap" }]);
  const intercepted: string[] = [];
  await render(<EffectProtectionInspector {...f.props} scopeLabel="Pending version" onRelease={rule => intercepted.push(rule.id)} />);
  const count = f.commands.length; await click("Release Passage coverage"); assert.deepEqual(intercepted, ["pr_gap"]); assert.equal(f.commands.length, count);
});

function Probe({ effect, context, plan }: { effect: EffectClip; context: EffectAnalysisContext; plan: RenderPlan }) {
  const analysis = useSelectedEffectAnalysis(effect, context, plan);
  return <output data-key={analysis.manifest?.manifestKey ?? ""}>{analysis.state.status}{analysis.error}</output>;
}
test("the selected manifest aborts on source changes and never retains an earlier Ready result", async () => {
  const f = fixture(); f.effect.audioInput = { kind: "composition-mix" }; f.effect.reaction.enabled = true;
  const source = resolveEffectAudioSource({ ...f.context, plan: f.plan, input: f.effect.audioInput }); assert.ok(source.ok);
  const manifest = analysisManifest();
  f.state.effectAnalyses = [{ worldId: f.context.worldId, productionId: f.context.production.meta.id, canPrepare: false, byEffectId: { [f.effect.id]: { status: "ready", requestFingerprint: source.requestFingerprint, sourceFingerprint: manifest.sourceFingerprint, manifestKey: manifest.manifestKey, silent: false, cueConflicts: [] } } }];
  __setStateForTest(f.state);
  let finish!: (response: Response) => void; const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init) => { signals.push(init!.signal!); return new Promise<Response>(resolve => { finish = resolve; }); };
  await render(<Probe effect={f.effect} context={f.context} plan={f.plan} />); assert.equal(signals.length, 1);
  f.timeline.tracks[1]!.muted = false;
  const changedContext = { ...f.context, timeline: structuredClone(f.timeline) };
  await render(<Probe effect={f.effect} context={changedContext} plan={f.plan} />);
  assert.equal(signals[0]!.aborted, true); assert.match(dom.document.body.textContent!, /source-changed/);
  await act(async () => { finish(new Response(JSON.stringify(manifest))); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(dom.document.querySelector("output")!.getAttribute("data-key"), "");
  assert.equal(signals.length, 1, "a stale Ready row does not trigger a second manifest fetch");
});
