import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, type ArtifactSidecar, type Crossfade, type ProductionTimeline, type TimelineClipCommand } from "@arke-studio/contracts";
import { TransitionProvider, TransitionJoins, TransitionLibrary, TransitionInspector } from "../src/screens/editor-transitions.js";
import type { CutTransport } from "../src/screens/editor-transport.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1360, innerHeight: 900 });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
Object.assign(dom.HTMLElement.prototype, { getBoundingClientRect: () => ({ left: 200, top: 400, width: 1000, height: 60 }),
  showModal(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); } });
const { createRoot } = await import("react-dom/client");
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
const pair = { trackId: "tr_picture", leftClipId: "cl_left", rightClipId: "cl_right" };

async function mount(value?: Partial<Crossfade>, pending = false) {
  const commands: TimelineClipCommand[][] = [], inspected: Array<boolean | undefined> = [], seeks: number[] = [];
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] },
    tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: ["left", "right"].map((id, index) => ({
      id: `cl_${id}`, startFrame: index * 240, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: `ar_${id}`, label: id } })) }],
    ...(value ? { transitions: [{ ...pair, type: "crossfade", durationFrames: 24, protectJoin: false, protectDuration: false, ...value }] } : {}) };
  const artifacts: ArtifactSidecar[] = ["left", "right"].map(id => ({ id: `ar_${id}`, kind: "image", file: `${id}.png`, hash: id, origin: { by: "user" }, links: [], created: "2026-10-12T00:00:00Z" }));
  const transport = { playing: false, time: 0, timeRef: { current: 0 }, setPlaying() {}, seek: (at: number) => seeks.push(at),
    discontinuityRef: { current: 0 }, loop: false, setLoop() {}, canLoop: true } satisfies CutTransport;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<TransitionProvider timeline={timeline} artifacts={artifacts} disabled={false} selected={pair} select={() => {}}
    send={rows => commands.push(rows)} transport={transport} pending={pending} onInspect={opening => inspected.push(opening)}>
    <TransitionLibrary /><TransitionJoins trackId="tr_picture" totalFrames={480} /><TransitionInspector />
  </TransitionProvider>));
  const click = async (selector: string) => { const button = document.querySelector<HTMLElement>(selector); assert.ok(button, selector); await act(async () => button.click()); };
  return { commands, inspected, seeks, click };
}

test("join picker uses a top-layer dialog; browsing and Cancel author nothing and do not request the phone Inspector", async () => {
  const f = await mount(); await f.click(".xf-join-trigger");
  const dialog = document.querySelector("dialog.xf-picker-scrim"); assert.ok(dialog); assert.ok(dialog.hasAttribute("open"));
  assert.deepEqual(f.inspected, [true]); assert.deepEqual(f.commands, []);
  await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  assert.equal(document.querySelector(".xf-picker-scrim"), null); assert.deepEqual(f.commands, []);
  await f.click(".xf-join-trigger"); await f.click(".xf-transition-picker .xf-transition-tile");
  assert.deepEqual(f.commands, [[{ kind: "transition-set", ...pair, durationFrames: 24 }]]);
  assert.equal(f.inspected.at(-1), undefined, "insertion opens the Inspector");
});

test("replacement names before/after and writes only after Replace; an identical replacement is a no-op", async () => {
  const f = await mount({ durationFrames: 24, protectDuration: true });
  await f.click(".xf-transition-library .xf-transition-tile");
  assert.match(document.querySelector(".xf-transition-picker")!.textContent!, /Current.*1.00s.*New.*1.00s/);
  assert.deepEqual(f.commands, []);
  await f.click(".xf-transition-picker .xf-primary"); assert.deepEqual(f.commands, []);
});

test("pending protection Release is a separate named choice and Preview never authors commands", async () => {
  const f = await mount({ durationFrames: 36, protectDuration: true }, true);
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".xf-inspector button")].find(row => row.textContent === text)!;
  await act(async () => button("▶ Preview transition").click()); assert.deepEqual(f.commands, []); assert.deepEqual(f.seeks, [8.75]);
  await act(async () => button("Release duration…").click()); assert.deepEqual(f.commands, []);
  assert.match(document.querySelector(".xf-inspector")!.textContent!, /Join protection is unchanged/);
  await act(async () => button("Release on Apply").click());
  assert.deepEqual(f.commands, [[{ kind: "transition-release", ...pair, setting: "duration" }]]);
});
