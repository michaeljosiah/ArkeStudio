import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { EffectArrangementDialog, type EffectArrangementDialogProps } from "../src/screens/editor-effect-arrangement.js";
import type { EffectArrangementRequest } from "../src/lib/editor-effect-arrangement.js";
import { effectArrangementFixture } from "./effect-arrangement-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }), innerWidth: 1400, innerHeight: 880 });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
async function mount(node: ReactNode) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), view = { container, root }; mounted.push(view);
  await act(async () => root.render(node)); return view;
}
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.container.remove(); } });
const button = (name: string) => { const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === name); assert.ok(found, name); return found; };
const click = async (name: string) => { await act(async () => button(name).click()); };
const input = (label: string) => { const found = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(found, label); return found; };
async function change(label: string, value: string) {
  const node = input(label);
  await act(async () => {
    Object.defineProperty(node, "value", { configurable: true, writable: true, value });
    const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
    (node as unknown as Record<string, { onChange: (event: { currentTarget: typeof node }) => void }>)[key]!.onChange({ currentTarget: node });
  });
}
async function choosePreset(label: string, checked: boolean) {
  const node = [...document.querySelectorAll("label")].find(row => row.textContent === label)?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(node, label);
  await act(async () => {
    Object.defineProperty(node, "checked", { configurable: true, writable: true, value: checked });
    const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
    (node as unknown as Record<string, { onChange: (event: { currentTarget: typeof node }) => void }>)[key]!.onChange({ currentTarget: node });
  });
}
async function submit() { await act(async () => { document.querySelector(".fx-arrangement")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
function fixture() {
  const f = effectArrangementFixture(), requests: EffectArrangementRequest[] = [], closed: boolean[] = [];
  const props: EffectArrangementDialogProps = { context: f.context, plan: f.plan, selectedPictureId: "cl_video",
    onPrepare: request => requests.push(request), onClose: () => closed.push(true) };
  return { ...f, props, requests, closed };
}

test("arrangement defaults to Off, exposes six presets and Cancel has no authored side effect", async () => {
  const f = fixture(), before = structuredClone(f.timeline); await mount(<EffectArrangementDialog {...f.props} />);
  assert.equal(input("Arrangement audio reaction").value, "off");
  assert.equal(document.querySelectorAll('.fx-arrangement__palette input[type="checkbox"]').length, 6);
  assert.equal(button("Selected range").disabled, true);
  await click("Cancel"); assert.deepEqual(f.closed, [true]); assert.equal(f.requests.length, 0); assert.deepEqual(f.timeline, before);
});

test("Whole song needs an explicit placement and copies a confirmed clipped interval without changing target or reaction", async () => {
  const f = fixture(), before = structuredClone(f.timeline); await mount(<EffectArrangementDialog {...f.props} />);
  await change("Visual target", "clip:cl_video"); await click("Whole song…");
  assert.equal(button("Use this interval").disabled, true);
  await change("Copy interval from placed audio", JSON.stringify({ kind: "audio-clip", clipId: "cl_audio" }));
  assert.match(document.body.textContent!, /Resolved interval: 00:00:02:00–00:00:10:00 · clipped to video delivery/);
  await click("Use this interval"); assert.equal(input("Arrangement audio reaction").value, "off");
  await submit(); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.scope.target, { kind: "visual-clip", clipId: "cl_video" });
  assert.deepEqual(f.requests[0]!.scope.range, { startFrame: 48, endFrame: 240 });
  assert.deepEqual(f.requests[0]!.scope.audio, { kind: "off" }); assert.deepEqual(f.timeline, before);
});

test("the reaction source is independent of selected-picture and typed timing, including silent audio", async () => {
  const f = fixture(); await mount(<EffectArrangementDialog {...f.props} />);
  const audio = JSON.stringify({ kind: "audio-clip", clipId: "cl_audio" });
  const option = [...input("Arrangement audio reaction").querySelectorAll("option")].find(row => row.value === audio)!;
  assert.equal(option.hasAttribute("disabled"), false); assert.match(option.textContent!, /currently silent/);
  const still = [...input("Arrangement audio reaction").querySelectorAll("option")].find(row => row.value === JSON.stringify({ kind: "video-sound", clipId: "cl_still" }))!;
  assert.equal(still.hasAttribute("disabled"), true); assert.match(still.textContent!, /no measured sound/);
  await change("Arrangement audio reaction", audio); await click("Selected picture");
  await change("Arrangement Start", "00:00:04:03"); await change("Arrangement End", "8.5"); await submit();
  const request = f.requests[0]!;
  assert.deepEqual(request.scope.range, { startFrame: 99, endFrame: 204 });
  assert.deepEqual(request.scope.audio, { kind: "source", input: { kind: "audio-clip", clipId: "cl_audio" } });
  assert.deepEqual(request.scope.target, { kind: "composition" });
});

test("invalid typed bounds, empty palette/direction and lost permission cannot prepare an old valid draft", async () => {
  const f = fixture(), view = await mount(<EffectArrangementDialog {...f.props} />);
  for (const end of ["", "not a time", "0", "11"]) {
    await change("Arrangement End", end); await submit(); assert.equal(f.requests.length, 0, end);
  }
  await change("Arrangement End", "10"); await choosePreset("Floating dust", false); await submit(); assert.equal(f.requests.length, 0);
  await choosePreset("Rain", true); await change("Creative direction", " "); await submit(); assert.equal(f.requests.length, 0);
  await change("Creative direction", "Rain against the window");
  await act(async () => view.root.render(<EffectArrangementDialog {...f.props} disabledReason="This world is read-only." />));
  await submit(); assert.equal(f.requests.length, 0); assert.match(document.body.textContent!, /read-only/);
  await act(async () => view.root.render(<EffectArrangementDialog {...f.props} />)); await submit();
  assert.deepEqual(f.requests[0]!.scope.palette, [{ id: "rain", version: 1 }]);
});

test("a missing selected target or reaction source is retained and refused until explicitly replaced", async () => {
  const f = fixture(), view = await mount(<EffectArrangementDialog {...f.props} />);
  await change("Visual target", "clip:cl_video"); await change("Arrangement audio reaction", JSON.stringify({ kind: "audio-clip", clipId: "cl_audio" }));
  const changed = structuredClone(f.context); changed.timeline.tracks[0]!.clips = []; changed.timeline.tracks[1]!.clips = [];
  await act(async () => view.root.render(<EffectArrangementDialog {...f.props} context={changed} />));
  await submit(); assert.equal(f.requests.length, 0); assert.match(document.body.textContent!, /Missing visual clip/); assert.match(document.body.textContent!, /Missing audio source/);
  await change("Visual target", "composition"); await submit(); assert.equal(f.requests.length, 0);
  await change("Arrangement audio reaction", "off"); await submit(); assert.equal(f.requests.length, 1);
});

test("copied intervals stay fixed after a song moves, and empty delivery never enables preparation", async () => {
  const f = fixture(), view = await mount(<EffectArrangementDialog {...f.props} />);
  await click("Whole song…"); await change("Copy interval from placed audio", JSON.stringify({ kind: "audio-clip", clipId: "cl_audio" })); await click("Use this interval");
  const moved = structuredClone(f.context); moved.timeline.tracks[1]!.clips[0]!.startFrame = 96;
  await act(async () => view.root.render(<EffectArrangementDialog {...f.props} context={moved} />));
  assert.equal(input("Arrangement Start").value, "00:00:02:00");
  await act(async () => view.root.render(<EffectArrangementDialog {...f.props} plan={{ ...f.plan, range: { startSec: 0, endSec: 0 }, totalSec: 0 }} />));
  assert.equal(button("Prepare suggestion").disabled, true); await submit(); assert.equal(f.requests.length, 0);
});
