import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { pictureMotionAt, pictureMotionWindow, type TimelineClip, type TimelineCommand } from "@arke-studio/contracts";
import { PictureMotionInspector } from "../src/screens/editor-picture-motion.js";
import { PreviewMediaPool } from "../src/lib/editor-preview-media.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
const { createRoot } = await import("react-dom/client");
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
const mount = async (element: React.ReactNode) => { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); };
const clip: TimelineClip = { id: "cl_a", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_example", label: "Still" } };
const move = () => document.querySelector<HTMLSelectElement>('[aria-label="Picture move"]');
const choose = async (value: string) => {
  const select = move()!, key = Object.keys(select).find(name => name.startsWith("__reactProps$"))!;
  await act(async () => (select as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange({ currentTarget: { value } }));
};
const type = async (label: string, value: string) => {
  const found = [...document.querySelectorAll("label")].find(row => row.childNodes[0]?.textContent === label)!;
  const input = document.getElementById(found.getAttribute("for")!) as HTMLInputElement;
  await act(async () => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { const event = new Event("keydown", { bubbles: true }); Object.assign(event, { key: "Enter" }); input.dispatchEvent(event); });
};

test("a still chooses a move and how far; either edge fades for a typed time", async () => {
  const sent: TimelineCommand[][] = [];
  const view = (value: TimelineClip, disabled = false) => <PictureMotionInspector clip={value} still frameRate={24} disabled={disabled} onCommands={commands => sent.push(commands)} />;
  await mount(view(clip));
  assert.equal(move()!.value, "none");
  assert.equal([...document.querySelectorAll("label")].some(row => row.childNodes[0]?.textContent === "Move amount"), false, "nothing to set until the still moves");
  await choose("drift-left");
  assert.deepEqual(sent.pop(), [{ kind: "picture-motion", clipId: "cl_a", motion: { kind: "drift-left", amount: .08 } }]);
  await act(async () => root!.render(view({ ...clip, motion: { kind: "drift-left", amount: .2 }, fade: { outFrames: 12 } })));
  await choose("push-in");
  assert.deepEqual(sent.pop(), [{ kind: "picture-motion", clipId: "cl_a", motion: { kind: "push-in", amount: .2 } }], "a new move keeps the amount");
  await type("Move amount", "35");
  assert.deepEqual(sent.pop(), [{ kind: "picture-motion", clipId: "cl_a", motion: { kind: "drift-left", amount: .35 } }]);
  await choose("none");
  assert.deepEqual(sent.pop(), [{ kind: "picture-motion", clipId: "cl_a", motion: null }]);
  await type("Fade in", "1.5");
  assert.deepEqual(sent.pop(), [{ kind: "picture-fade", clipId: "cl_a", inFrames: 36 }], "the other edge is left alone");
  await type("Fade out", "0");
  assert.deepEqual(sent.pop(), [{ kind: "picture-fade", clipId: "cl_a", outFrames: 0 }]);
  await type("Fade in", "5");
  assert.equal(sent.length, 0, "a fade is no longer than its clip");
  await act(async () => root!.render(view(clip, true)));
  assert.equal(move()!.disabled, true);
});

test("a film clip fades but does not move", async () => {
  await mount(<PictureMotionInspector clip={clip} still={false} frameRate={24} disabled={false} onCommands={() => {}} />);
  assert.equal(move(), null);
  assert.equal(document.querySelector("h3")!.textContent, "Fade");
  assert.deepEqual([...document.querySelectorAll("label")].map(row => row.childNodes[0]?.textContent), ["Fade in", "Fade out"]);
});

test("the preview draws the part of a moving still that the export will", () => {
  const drawn: number[][] = [];
  const image = { complete: true, naturalWidth: 1000, naturalHeight: 2000, addEventListener() {}, removeEventListener() {}, removeAttribute() {} };
  const context = { clearRect() {}, drawImage: (_element: unknown, ...numbers: number[]) => { drawn.push(numbers); }, getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
  const doc = { createElement: (name: string) => name === "img" ? image : { width: 0, height: 0, getContext: () => context } } as unknown as Document;
  const pool = new PreviewMediaPool(doc, path => path, () => {});
  const source = { id: "cl_a", path: "still.png", still: true, sourceSec: 0 };
  pool.capture(source, 540, 960, false, 0, 24);
  assert.deepEqual(drawn.pop(), [0, 0, 480, 960], "a still that does not move is drawn whole");
  const at = pictureMotionAt({ kind: "drift-left", amount: .25 }, .5), part = pictureMotionWindow(at, 1000, 2000);
  assert.deepEqual(part, { x: 100, y: 200, width: 800, height: 1600 });
  pool.capture({ ...source, motion: at }, 540, 960, false, 0, 24);
  assert.deepEqual(drawn.pop(), [100, 200, 800, 1600, 0, 0, 480, 960], "the window fills the place the whole still had");
  pool.destroy();
});
