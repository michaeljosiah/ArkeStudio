import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, EffectCommandSchema, applyTimelineCommands, defaultEffectClip, undoTimelineHistory, type EffectClip, type ProductionTimeline, type TimelineCommand } from "@arke-studio/contracts";
import { EffectInspector } from "../src/screens/editor-effect-inspector.js";
import { EffectAreaEditor, effectAreaGesture } from "../src/screens/editor-effect-area.js";
import { EffectCurves, editEffectCurve } from "../src/screens/editor-effect-curves.js";
import { effectTimeFrames } from "../src/screens/editor-effect-fields.js";
import type { EffectAuthoringProps } from "../src/lib/editor-effect-authoring.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });

function initial(effect?: EffectClip): ProductionTimeline {
  return { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, tracks: [
    { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
    { id: "tr_effect", kind: "effect", name: "Atmosphere", order: 1, muted: false, clips: [], effects: [effect ?? defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 24, durationFrames: 240, seed: 8 })] },
  ] };
}
const effectOf = (timeline: ProductionTimeline) => timeline.tracks[1]!.effects![0]!;
const apply = (timeline: ProductionTimeline, commands: TimelineCommand[]) => applyTimelineCommands(timeline, commands.map(command => EffectCommandSchema.parse(command)), { effectAuthority: "human" });
async function mount(Component: (props: EffectAuthoringProps) => ReactNode = EffectInspector, original = initial(), playheadFrame = 48) {
  let saved = original, preview: TimelineCommand[] | null = null, disabled = false;
  let refresh = () => {};
  const calls: TimelineCommand[][] = [], previews: Array<TimelineCommand[] | null> = [], scrubbed: number[] = [];
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  function Harness() {
    const [, render] = useState(0);
    refresh = () => render(value => value + 1);
    const shown = preview ? apply(saved, preview) : saved;
    return <Component effect={effectOf(shown)} timeline={shown} frameRate={24} playheadFrame={playheadFrame} authoringRevision={saved.revision} disabled={disabled}
      onCommands={commands => { calls.push(commands); saved = apply(saved, commands); render(value => value + 1); }}
      onPreview={commands => { previews.push(commands); preview = commands; render(value => value + 1); }} onScrub={frame => scrubbed.push(frame)} />;
  }
  await act(async () => root.render(<Harness />));
  return { container, calls, previews, scrubbed, saved: () => saved, shown: () => preview ? apply(saved, preview) : saved,
    externally: async (commands: TimelineCommand[]) => { await act(async () => { saved = apply(saved, commands); refresh(); }); },
    setDisabled: async (value: boolean) => { await act(async () => { disabled = value; refresh(); }); } };
}
async function fire(element: Element, type: string, values: Record<string, unknown> = {}) {
  await act(async () => { const event = new dom.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, values); element.dispatchEvent(event); });
}
function button(container: Element, text: string) { const found = [...container.querySelectorAll("button")].find(value => value.textContent === text); assert.ok(found, `button ${text}`); return found; }
function field(container: Element, text: string) {
  const label = [...container.querySelectorAll("label")].find(value => value.childNodes[0]?.textContent === text || value.textContent === text); assert.ok(label, `label ${text}`);
  const id = label.getAttribute("for"), result = id ? document.getElementById(id) : label.querySelector("input"); assert.ok(result, `input ${text}`); return result as HTMLInputElement;
}
async function type(container: Element, label: string, value: string) { const input = field(container, label); input.value = value; await fire(input, "input"); await fire(input, "keydown", { key: "Enter" }); }

describe("manual effect Inspector (SPEC-053 R-2, R-6–8)", () => {
  it("edits protected values directly and refuses invalid typed values visibly", async () => {
    const original = applyTimelineCommands(initial(), [{ kind: "effect-protect", rule: { id: "pr_amount", kind: "property", lineageId: "ef_dust", property: "appearance.amount", scope: { kind: "whole" } } }], { effectAuthority: "human" });
    const test = await mount(EffectInspector, original);
    await type(test.container, "Amount", "140"); assert.equal(test.calls.length, 0); assert.match(test.container.textContent!, /Use a value from 0 to 100/);
    assert.equal(field(test.container, "Amount").value, "140");
    await type(test.container, "Amount", "65"); assert.equal(test.calls.length, 1); assert.equal(effectOf(test.saved()).appearance.amount, 0.65);
    assert.notEqual(test.saved().effectProtection![0]!.baselineFingerprint, original.effectProtection![0]!.baselineFingerprint);
    assert.deepEqual(effectOf(undoTimelineHistory(test.saved())), effectOf(original));
  });

  it("previews a slider against the shown draft but commits once, and Escape cancels", async () => {
    const test = await mount(); const slider = test.container.querySelector('[aria-label="Amount slider"]') as HTMLInputElement;
    slider.value = "45"; await fire(slider, "input"); slider.value = "75"; await fire(slider, "input");
    assert.equal(test.calls.length, 0); assert.equal(effectOf(test.shown()).appearance.amount, 0.75);
    await fire(slider, "pointerup"); assert.equal(test.calls.length, 1); assert.equal(effectOf(test.saved()).appearance.amount, 0.75);
    slider.value = "20"; await fire(slider, "input"); await fire(slider, "keydown", { key: "Escape" }); await fire(slider, "pointerup");
    assert.equal(test.calls.length, 1); assert.equal(effectOf(test.shown()).appearance.amount, 0.75); assert.equal(test.previews.at(-1), null);
  });

  it("changes target alone, trims without restarting phase/fades, and moves the envelope explicitly", async () => {
    const test = await mount(); const before = structuredClone(effectOf(test.saved()));
    const select = test.container.querySelector('select[aria-label="Visual target"]'); assert.ok(select);
    Object.defineProperty(select, "value", { configurable: true, value: "track:tr_picture" }); await fire(select, "change");
    assert.deepEqual(effectOf(test.saved()).target, { kind: "picture-track", trackId: "tr_picture" });
    assert.deepEqual(effectOf(test.saved()).audioInput, before.audioInput);
    assert.equal(effectOf(test.saved()).startFrame, before.startFrame);
    await type(test.container, "Start", "2.125");
    assert.equal(effectOf(test.saved()).startFrame, 51); assert.equal(effectOf(test.saved()).simulationOriginFrame, before.simulationOriginFrame);
    assert.deepEqual(effectOf(test.saved()).fades, before.fades);
    await type(test.container, "Move to", "3"); assert.equal(effectOf(test.saved()).startFrame, 72);
    assert.equal(effectOf(test.saved()).simulationOriginFrame, before.simulationOriginFrame + 21);
    assert.equal(effectOf(test.saved()).fades.startFrame, before.fades.startFrame + 21);
  });

  it("explains retained preset settings and only commits an explicit choice", async () => {
    const test = await mount(); const before = structuredClone(effectOf(test.saved()));
    const select = test.container.querySelector('[aria-label="Atmosphere preset"]')!;
    Object.defineProperty(select, "value", { configurable: true, value: "snow" }); await fire(select, "change");
    assert.equal(test.calls.length, 0); assert.match(test.container.textContent!, /no conversion is needed/);
    await fire(button(test.container, "Use Snow"), "click"); assert.equal(test.calls.length, 1);
    assert.deepEqual(effectOf(test.saved()), { ...before, preset: { id: "snow", version: 1 } });
  });

  it("rounds decimal seconds once and rejects malformed or unsafe timing", () => {
    assert.equal(effectTimeFrames("2.125", 24), 51); assert.equal(effectTimeFrames("00:02:03", 24), 51);
    assert.equal(effectTimeFrames("00:02:24", 24), null); assert.equal(effectTimeFrames("NaN", 24), null); assert.equal(effectTimeFrames("999999999999999999999", 24), null);
  });

  it("clears an invalid draft when selection changes to another effect", async () => {
    function Switching(props: EffectAuthoringProps) {
      const [second, setSecond] = useState(false);
      return <><button type="button" onClick={() => setSecond(true)}>Select second effect</button>
        <EffectInspector {...props} effect={second ? { ...props.effect, id: "cl_second", lineageId: "ef_second", appearance: { ...props.effect.appearance, amount: 0.7 } } : props.effect} /></>;
    }
    const test = await mount(Switching); await type(test.container, "Amount", "140");
    assert.equal(field(test.container, "Amount").getAttribute("aria-invalid"), "true");
    await fire(button(test.container, "Select second effect"), "click");
    assert.equal(field(test.container, "Amount").value, "70"); assert.equal(field(test.container, "Amount").getAttribute("aria-invalid"), null); assert.equal(test.calls.length, 0);
  });

  it("cancels stale typed and held slider drafts without replacing their focused nodes or curve tab", async () => {
    const test = await mount(); await fire(button(test.container, "Audio reaction"), "click");
    const amount = field(test.container, "Amount"); amount.value = "85"; await fire(amount, "input");
    const time = field(test.container, "Start"); time.value = "3"; await fire(time, "input");
    await test.externally([{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: 0.6 } } }]);
    assert.equal(field(test.container, "Amount"), amount); assert.equal(field(test.container, "Start"), time);
    assert.equal(amount.value, "60"); assert.equal(time.value, "00:00:01:00");
    await fire(amount, "keydown", { key: "Enter" }); await fire(time, "focusout"); assert.equal(test.calls.length, 0);
    const slider = test.container.querySelector('[aria-label="Amount slider"]') as HTMLInputElement;
    slider.value = "95"; await fire(slider, "input"); assert.equal(effectOf(test.shown()).appearance.amount, 0.95);
    await test.externally([{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { opacity: 0.2 } } }]);
    await fire(slider, "pointerup"); assert.equal(test.calls.length, 0); assert.equal(effectOf(test.shown()).appearance.amount, 0.6);
    assert.equal(button(test.container, "Audio reaction").getAttribute("aria-selected"), "true");
  });

  it("drops typed and slider gestures across lost editing access at the same revision, and on lost capture", async () => {
    const test = await mount(), before = structuredClone(effectOf(test.saved()));
    const amount = field(test.container, "Amount"); amount.value = "85"; await fire(amount, "input");
    await test.setDisabled(true); await test.setDisabled(false);
    await fire(amount, "keydown", { key: "Enter" }); await fire(amount, "focusout");
    assert.equal(test.calls.length, 0); assert.equal(amount.value, String(before.appearance.amount * 100));
    const slider = test.container.querySelector('[aria-label="Amount slider"]') as HTMLInputElement;
    slider.value = "95"; await fire(slider, "input"); assert.equal(effectOf(test.shown()).appearance.amount, 0.95);
    await test.setDisabled(true); assert.deepEqual(effectOf(test.shown()), before); assert.equal(test.previews.at(-1), null);
    await test.setDisabled(false); await fire(slider, "pointerup"); await fire(slider, "focusout");
    assert.equal(test.calls.length, 0); assert.equal(test.saved().revision, 0);
    slider.value = "75"; await fire(slider, "input"); await fire(slider, "lostpointercapture");
    await fire(slider, "pointerup"); await fire(slider, "focusout");
    assert.equal(test.calls.length, 0); assert.deepEqual(effectOf(test.shown()), before); assert.equal(test.previews.at(-1), null);
  });
});

describe("normalized emitting area", () => {
  it("keeps pointer move and resize bounded without changing a target or timeline interval", () => {
    const area = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    assert.deepEqual(effectAreaGesture(area, "move", 2, -2), { x: 0.5, y: 0, width: 0.5, height: 0.5 });
    assert.deepEqual(effectAreaGesture(area, "se", 1, 1), { x: 0.25, y: 0.25, width: 0.75, height: 0.75 });
    const squeezed = effectAreaGesture(area, "nw", 1, 1); assert.ok(squeezed.width > 0 && squeezed.height > 0);
  });

  it("visibly rejects an overflowing typed rectangle and commits one pointer gesture", async () => {
    const test = await mount(EffectAreaEditor);
    await type(test.container, "Left", "10"); assert.equal(test.calls.length, 0); assert.match(test.container.textContent!, /Keep the area inside/);
    await type(test.container, "Width", "50"); await type(test.container, "Height", "50");
    const root = test.container.querySelector(".fx-area-overlay") as HTMLDivElement;
    root.getBoundingClientRect = () => ({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    const handle = test.container.querySelector('[aria-label="Move emitting area"]')!;
    const before = test.calls.length;
    await fire(handle, "pointerdown", { button: 0, pointerId: 1, clientX: 50, clientY: 25 });
    await fire(handle, "pointermove", { pointerId: 1, clientX: 100, clientY: 50 });
    assert.equal(test.calls.length, before); assert.deepEqual(effectOf(test.shown()).motion.area, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    await fire(handle, "pointerup", { pointerId: 1 }); assert.equal(test.calls.length, before + 1);
    await fire(handle, "pointerdown", { button: 0, pointerId: 2, clientX: 100, clientY: 50 });
    await fire(handle, "pointermove", { pointerId: 2, clientX: 150, clientY: 75 }); await fire(handle, "pointercancel", { pointerId: 2 });
    assert.equal(test.calls.length, before + 1); assert.equal(effectOf(test.shown()).motion.area.x, 0.25);
  });

  it("drops a held area gesture when saved authority changes", async () => {
    const original = initial(); effectOf(original).motion.area = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const test = await mount(EffectAreaEditor, original), root = test.container.querySelector(".fx-area-overlay") as HTMLDivElement;
    root.getBoundingClientRect = () => ({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    const handle = test.container.querySelector('[aria-label="Move emitting area"]')!;
    await fire(handle, "pointerdown", { button: 0, pointerId: 1, clientX: 50, clientY: 25 });
    await fire(handle, "pointermove", { pointerId: 1, clientX: 100, clientY: 50 });
    await test.externally([{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { opacity: 0.3 } } }]);
    await fire(handle, "pointerup", { pointerId: 1 });
    assert.equal(test.calls.length, 0); assert.deepEqual(effectOf(test.shown()).motion.area, effectOf(original).motion.area); assert.equal(test.previews.at(-1), null);
  });

  it("cancels an area gesture on lost editing access before a later pointer release", async () => {
    const original = initial(); effectOf(original).motion.area = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const test = await mount(EffectAreaEditor, original), root = test.container.querySelector(".fx-area-overlay") as HTMLDivElement;
    root.getBoundingClientRect = () => ({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    const handle = test.container.querySelector('[aria-label="Move emitting area"]')!;
    await fire(handle, "pointerdown", { button: 0, pointerId: 1, clientX: 50, clientY: 25 });
    await fire(handle, "pointermove", { pointerId: 1, clientX: 100, clientY: 50 });
    await test.setDisabled(true); assert.deepEqual(effectOf(test.shown()).motion.area, effectOf(original).motion.area);
    await test.setDisabled(false); await fire(handle, "pointerup", { pointerId: 1 });
    assert.equal(test.calls.length, 0); assert.equal(test.saved().revision, 0); assert.equal(test.previews.at(-1), null);
  });
});

describe("independent effect curves", () => {
  it("authors an extended-head point and leaves the other curve unchanged", async () => {
    const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 50, durationFrames: 200, seed: 8 });
    effect.startFrame = 25; effect.durationFrames = 225;
    const test = await mount(EffectCurves, initial(effect), 25);
    await fire(button(test.container, "Add point at playhead"), "click");
    assert.equal(effectOf(test.saved()).intensityCurve.points[0]!.offsetFrames, -25);
    assert.deepEqual(effectOf(test.saved()).reactionCurve.points, []);
    await type(test.container, "Point value", "35"); assert.equal(effectOf(test.saved()).intensityCurve.points[0]!.value, 0.35);
    await fire(button(test.container, "Audio reaction"), "click"); await fire(button(test.container, "Add point at playhead"), "click");
    assert.equal(effectOf(test.saved()).reactionCurve.points.length, 1); assert.equal(effectOf(test.saved()).intensityCurve.points[0]!.value, 0.35);
    await fire(button(test.container, "Delete point"), "click"); assert.equal(effectOf(test.saved()).reactionCurve.points.length, 0);
  });

  it("requires explicit replacement at coincident frames and allows cancellation", async () => {
    const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 100, seed: 8 });
    effect.intensityCurve.points = [{ id: "ep_one", offsetFrames: 10, value: 0.2, interpolation: "linear" }, { id: "ep_two", offsetFrames: 11, value: 0.9, interpolation: "smooth" }];
    const test = await mount(EffectCurves, initial(effect), 10);
    await fire(button(test.container, "Add point at playhead"), "click"); assert.equal(test.calls.length, 0);
    await fire(button(test.container, "Cancel replacement"), "click"); assert.equal(test.calls.length, 0);
    const point = test.container.querySelector('[aria-label="Intensity point at 00:00:00:10"]')!; assert.ok(point);
    await fire(point, "keydown", { key: "ArrowRight" }); assert.equal(test.calls.length, 0);
    await fire(button(test.container, "Replace point"), "click"); assert.equal(test.calls.length, 1);
    assert.deepEqual(effectOf(test.saved()).intensityCurve.points, [{ id: "ep_one", offsetFrames: 11, value: 0.2, interpolation: "linear" }]);
    assert.throws(() => editEffectCurve(effect.intensityCurve, { ...effect.intensityCurve.points[0]!, offsetFrames: 11 }, "ep_one"), /Replace point/);
  });

  it("keeps drag replacement explicit through the following click, and commits or cancels one curve gesture", async () => {
    const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 100, seed: 8 });
    effect.intensityCurve.points = [{ id: "ep_one", offsetFrames: 10, value: 0.2, interpolation: "linear" }, { id: "ep_two", offsetFrames: 11, value: 0.9, interpolation: "smooth" }];
    const test = await mount(EffectCurves, initial(effect), 10), graph = test.container.querySelector(".fx-curves__graph") as HTMLDivElement;
    graph.getBoundingClientRect = () => ({ width: 99, height: 100, left: 0, top: 0, right: 99, bottom: 100, x: 0, y: 0, toJSON() {} });
    const point = test.container.querySelector('[aria-label="Intensity point at 00:00:00:10"]')!;
    await fire(point, "pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 80 });
    await fire(point, "pointermove", { pointerId: 1, clientX: 11, clientY: 60 });
    await fire(point, "pointerup", { pointerId: 1 }); await fire(point, "click");
    assert.equal(test.calls.length, 0); assert.ok(button(test.container, "Replace point"));
    await fire(button(test.container, "Cancel replacement"), "click");
    await fire(point, "pointerdown", { button: 0, pointerId: 2, clientX: 10, clientY: 80 });
    await fire(point, "pointermove", { pointerId: 2, clientX: 20, clientY: 60 });
    assert.equal(effectOf(test.shown()).intensityCurve.points.at(-1)!.offsetFrames, 20);
    await fire(point, "keydown", { key: "Escape" }); await fire(point, "pointerup", { pointerId: 2 });
    assert.equal(test.calls.length, 0); assert.deepEqual(effectOf(test.shown()).intensityCurve, effect.intensityCurve);
    await fire(point, "pointerdown", { button: 0, pointerId: 3, clientX: 10, clientY: 80 });
    await fire(point, "pointermove", { pointerId: 3, clientX: 20, clientY: 60 }); await fire(point, "pointerup", { pointerId: 3 });
    assert.equal(test.calls.length, 1); assert.equal(effectOf(test.saved()).intensityCurve.points.at(-1)!.value, 0.4);
    await type(test.container, "Point time", "0.875"); assert.equal(effectOf(test.saved()).intensityCurve.points.at(-1)!.offsetFrames, 21);
    const interpolation = test.container.querySelector('[aria-label="Point interpolation"]')!;
    Object.defineProperty(interpolation, "value", { configurable: true, value: "hold" }); await fire(interpolation, "change");
    assert.equal(effectOf(test.saved()).intensityCurve.points.at(-1)!.interpolation, "hold");
    assert.deepEqual(effectOf(test.saved()).reactionCurve.points, []);
  });

  it("cancels a stale held curve gesture and pending replacement while keeping the chosen curve", async () => {
    const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 100, seed: 8 });
    effect.reactionCurve.points = [{ id: "ep_one", offsetFrames: 10, value: 0.2, interpolation: "linear" }];
    const test = await mount(EffectCurves, initial(effect), 10); await fire(button(test.container, "Audio reaction"), "click");
    const graph = test.container.querySelector(".fx-curves__graph") as HTMLDivElement;
    graph.getBoundingClientRect = () => ({ width: 99, height: 100, left: 0, top: 0, right: 99, bottom: 100, x: 0, y: 0, toJSON() {} });
    const point = test.container.querySelector('[aria-label="Audio reaction point at 00:00:00:10"]')!;
    await fire(point, "pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 80 });
    await fire(point, "pointermove", { pointerId: 1, clientX: 20, clientY: 60 });
    await test.externally([{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { opacity: 0.3 } } }]);
    await fire(point, "pointerup", { pointerId: 1 }); assert.equal(test.calls.length, 0);
    assert.deepEqual(effectOf(test.shown()).reactionCurve, effect.reactionCurve);
    await fire(button(test.container, "Add point at playhead"), "click"); assert.ok(button(test.container, "Replace point"));
    await test.externally([{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { opacity: 0.4 } } }]);
    assert.equal([...test.container.querySelectorAll("button")].some(value => value.textContent === "Replace point"), false);
    assert.equal(button(test.container, "Audio reaction").getAttribute("aria-selected"), "true"); assert.equal(test.calls.length, 0);
  });

  it("cancels held curve edits and pending replacement when editing access is lost without a revision change", async () => {
    const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 100, seed: 8 });
    effect.reactionCurve.points = [{ id: "ep_one", offsetFrames: 10, value: 0.2, interpolation: "linear" }];
    const test = await mount(EffectCurves, initial(effect), 10); await fire(button(test.container, "Audio reaction"), "click");
    const graph = test.container.querySelector(".fx-curves__graph") as HTMLDivElement;
    graph.getBoundingClientRect = () => ({ width: 99, height: 100, left: 0, top: 0, right: 99, bottom: 100, x: 0, y: 0, toJSON() {} });
    const point = test.container.querySelector('[aria-label="Audio reaction point at 00:00:00:10"]')!;
    await fire(point, "pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 80 });
    await fire(point, "pointermove", { pointerId: 1, clientX: 20, clientY: 60 });
    await test.setDisabled(true); assert.deepEqual(effectOf(test.shown()).reactionCurve, effect.reactionCurve);
    await test.setDisabled(false); await fire(point, "pointerup", { pointerId: 1 });
    assert.equal(test.calls.length, 0); assert.equal(test.previews.at(-1), null);
    await fire(button(test.container, "Add point at playhead"), "click"); assert.ok(button(test.container, "Replace point"));
    await test.setDisabled(true); await test.setDisabled(false);
    assert.equal([...test.container.querySelectorAll("button")].some(value => value.textContent === "Replace point"), false);
    assert.equal(button(test.container, "Audio reaction").getAttribute("aria-selected"), "true"); assert.equal(test.saved().revision, 0);
  });
});
