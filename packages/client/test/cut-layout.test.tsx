import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { type ClientMessage, type TimelineClip } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest, importEditorMedia } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { startClipGesture, type GestureUpdate } from "../src/screens/editor-gesture.js";
import { cutLayoutFixture } from "./cut-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let width = 390;
const listeners = new Set<() => void>();
Object.assign(dom.window, {
  innerWidth: 390, innerHeight: 797, location: { origin: "http://fixture.test" }, getComputedStyle: () => ({ direction: "ltr" }),
  matchMedia: (query: string) => ({
    matches: query.split(",").some(part => !part.includes("orientation: landscape") && (!part.includes("hover:") || part.includes("hover: none")) && (!part.includes("pointer:") || part.includes("pointer: coarse")) && [...part.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([, kind, value]) => kind === "min" ? width >= Number(value) : width <= Number(value))),
    addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }),
});
Object.assign(dom.HTMLElement.prototype, {
  getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 60, width: 1000, height: 60 }),
  showModal(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); },
  scrollIntoView() {}, setPointerCapture() {}, releasePointerCapture() {}, select() {},
});
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { get: () => 1000, configurable: true });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let sent: ClientMessage[] = [];
const fixture = cutLayoutFixture();
const base = "/w/" + fixture.world!.meta.worldId + "/p/saltlight";
async function mount(size = 390, remote = false) {
  width = size; sent = [];
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  if (remote) { const marker = dom.document.createElement("meta"); marker.name = "arke-remote"; marker.content = "true"; dom.document.head.append(marker); }
  const bridge = { connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge;
  Object.assign(dom.window, { arke: remote ? undefined : bridge });
  await act(async () => { __setBridgeForTest(bridge); __setStateForTest(cutLayoutFixture()); __connectionStatusForTest("open"); root!.render(<MemoryRouter initialEntries={[base + "/cut"]}><App /></MemoryRouter>); });
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; dom.document.body.replaceChildren(); dom.document.head.replaceChildren(); __setBridgeForTest(null); __connectionStatusForTest("closed"); });
const find = (selector: string) => dom.document.querySelector<HTMLElement>(selector)!;
const click = async (element: HTMLElement) => { assert.ok(element); await act(async () => element.click()); };
function props(element: HTMLElement): Record<string, (event: never) => void> { const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))!; return (element as unknown as Record<string, Record<string, (event: never) => void>>)[key]!; }
function pointer(target: EventTarget, type: string, x: number, y = 20) { const event = new dom.Event(type, { bubbles: true }); Object.assign(event, { button: 0, pointerId: 1, pointerType: "touch", clientX: x, clientY: y }); target.dispatchEvent(event); }
const timelineCommands = () => sent.filter((m): m is Extract<ClientMessage, { kind: "timeline-command" }> => m.kind === "timeline-command").flatMap(m => m.commands);

it("touch moves require a picked clip and at least eight pixels", () => {
  const target = document.createElement("button"); document.body.append(target);
  const clip: TimelineClip = { id: "cl_test", startFrame: 100, durationFrames: 100, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_sound", label: "Sound" } };
  let result: GestureUpdate | null = null, captures = 0;
  target.setPointerCapture = () => { captures++; };
  const begin = (selected: boolean) => startClipGesture({ event: { button: 0, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 20, currentTarget: target, preventDefault() {}, stopPropagation() {} }, selected, lane: target, canvas: null, clip, totalFrames: 1000, gesture: "move", snapFrames: null, onUpdate() {}, onEnd: value => { result = value; } });
  assert.equal(begin(false), false); assert.equal(captures, 0);
  begin(true); pointer(target, "pointermove", 107); pointer(target, "pointerup", 107); assert.equal(result, null);
  begin(true); pointer(target, "pointermove", 108); pointer(target, "pointerup", 108); assert.equal((result as GestureUpdate | null)?.deltaFrames, 8);
});

it("audio long press opens a menu without moving the clip, and Snap is available", async () => {
  await mount(); const audio = find('[data-clip="cl_maren"]'); assert.ok(audio);
  await act(async () => { pointer(audio, "pointerdown", 300); await new Promise(resolve => setTimeout(resolve, 470)); });
  assert.ok(find('dialog[open] [role="menu"]')); assert.equal(timelineCommands().length, 0);
  const snap = find('[role="menuitemcheckbox"]'); assert.equal(snap.getAttribute("aria-checked"), "true");
  await click(snap); assert.equal(snap.getAttribute("aria-checked"), "false");
});

it("a pan cancels an unpicked clip's pending long press", async () => {
  await mount(); const audio = find('[data-clip="cl_maren"]');
  await act(async () => { pointer(audio, "pointerdown", 300); pointer(window, "pointermove", 315); await new Promise(resolve => setTimeout(resolve, 470)); pointer(window, "pointerup", 315); });
  assert.equal(find('dialog[open] [role="menu"]'), null); assert.equal(timelineCommands().length, 0);
});

it("remote Library disables import and the store refuses it before sending", async () => {
  await mount(390, true); await click(find('.fy-cut-tools button:first-child'));
  assert.ok(find('.fy-cut-library-import').hasAttribute("disabled")); assert.match(find('.fy-cut-library-import').textContent!, /on the desktop app/);
  const result = importEditorMedia(fixture.world!.meta.worldId, { productionId: "saltlight", destination: "library", sourceFingerprint: "fixture", baseRevision: 0 });
  assert.equal(result.requestId, null); assert.match(result.reason!, /desktop app/); assert.equal(sent.filter(m => m.kind === "upload-artifacts").length, 0);
});

it("trim steps a single frame", async () => {
  await mount(); await click(find('[data-clip="cl_12"]')); await click(find('.fy-cut-tools button:nth-child(3)'));
  const input = find('.fy-cut-trim-sheet input[aria-label="In timecode"]') as HTMLInputElement;
  assert.equal(input.getAttribute('inputMode'), "decimal"); assert.equal(input.value, "0:00.00");
  await click(find('.fy-cut-trim-sheet [aria-label="In one frame later"]'));
  assert.deepEqual(timelineCommands()[0], { kind: "trim", clipId: "cl_12", edge: "start", deltaFrames: 1 });
});
it("trim parses compact source timecodes", async () => {
  await mount(); await click(find('[data-clip="cl_12"]')); await click(find('.fy-cut-tools button:nth-child(3)'));
  const input = find('.fy-cut-trim-sheet input[aria-label="In timecode"]') as HTMLInputElement;
  input.value = "0:00.12";
  await act(async () => props(input).onBlur!({ currentTarget: input } as never));
  assert.deepEqual(timelineCommands()[0], { kind: "trim", clipId: "cl_12", edge: "start", deltaFrames: 12 });
});

it("the inspector retains its field and uncommitted draft across phone and desktop", async () => {
  await mount(); await click(find('[data-clip="cl_12"]')); await click(find('.fy-cut-tools button:nth-child(3)'));
  const input = find('.fy-cut-trim-sheet input[aria-label="In timecode"]') as HTMLInputElement;
  await act(async () => props(input).onFocus!({ currentTarget: input } as never)); input.value = "0:00.12";
  await act(async () => { width = 1360; for (const listener of listeners) listener(); });
  assert.equal(find('input[aria-label="In timecode"]'), input); assert.equal(input.value, "0:00.12");
  await act(async () => props(input).onBlur!({ currentTarget: input } as never));
  assert.deepEqual(timelineCommands()[0], { kind: "trim", clipId: "cl_12", edge: "start", deltaFrames: 12 });
});

it("the base Picture lane cannot be removed from its sheet", async () => {
  await mount(); await click(find('[aria-label="Picture lane"]'));
  assert.ok([...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === "Remove lane")!.hasAttribute("disabled"));
});

it("phone Library places and appends shots through explicit actions", async () => {
  await mount(); await click(find('.fy-cut-tools button:first-child')); await click(find('.fy-artrow__pick'));
  const actions = [...document.querySelectorAll<HTMLElement>('.fy-artrow__actions button')];
  assert.ok(actions.find(button => button.textContent?.includes("Place at playhead")));
  await click(actions.find(button => button.textContent === "Append")!);
  assert.equal(timelineCommands()[0]?.kind, "place");
  const placement = timelineCommands()[0]; if (placement?.kind === 'place') assert.equal(placement.clip.startFrame, 67 * 24);
  assert.equal(find('.fy-artrow').getAttribute("draggable"), "false");
});

it("phone Split cuts the picture at the held playhead before a clip is picked", async () => {
  await mount(); await click(find('[aria-label="Next frame"]'));
  assert.equal(find('[data-clip][aria-pressed="true"]'), null);
  await click(find('.fy-cut-tools button:nth-child(2)'));
  const command = timelineCommands()[0]; assert.equal(command?.kind, "split");
  if (command?.kind === "split") { assert.equal(command.clipId, "cl_6"); assert.equal(command.atFrame, 1); }
});
