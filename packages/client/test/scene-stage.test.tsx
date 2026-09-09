import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { orderedShots, STAGE_FRAME_RATE, type ClientMessage } from "@arke-studio/contracts";
import { SceneStage } from "../src/screens/scene-workspace/stage.js";
import { SelectionProvider } from "../src/screens/scene-workspace/selection.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
  frames.clear();
});

async function mount() {
  const world = structuredClone(FIXTURE_STATE.world!);
  const production = world.productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(s => s.id === "sc_04")!;
  const shot = orderedShots(scene).find(s => s.id === "sh_12")!;
  shot.durationSec = 4;
  shot.staging = { version: 1, cast: [], sets: [], keys: [0, 2, 4].map(t => ({ t, p: [0, 1.5, 3], l: [0, 1, 0] })) };
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  const sent: Extract<ClientMessage, { kind: "scene-command" }>["command"][] = [];
  const render = async (locked = false) => {
    await act(async () => root!.render(
      <SelectionProvider value={{ subject: { kind: "shot", shotId: shot.id }, select: () => {} }}>
        <SceneStage scene={scene} production={production} world={world} aspect="16:9" sceneFile={undefined}
          locked={locked} generatorPending={false} refusalVersion={0} onCommand={command => { sent.push(command); return true; }} onRenderShot={() => {}} />
      </SelectionProvider>,
    ));
  };
  await render();
  const q = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  return { q, render, shot, scene, sent };
}

async function key(target: HTMLElement, value: string) {
  const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function pointer(target: HTMLElement, type: string, x: number) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, button: 0, clientX: x });
  await act(async () => target.dispatchEvent(event));
}
function capturePointer(target: HTMLElement) {
  let captured: number | null = null;
  Object.assign(target, {
    setPointerCapture: (id: number) => { captured = id; },
    hasPointerCapture: (id: number) => captured === id,
    releasePointerCapture: () => { captured = null; },
    getBoundingClientRect: () => ({ left: 100, width: 400 }),
  });
}
const click = async (target: HTMLElement) => { await act(async () => target.click()); };
const tick = async () => {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => { for (const callback of pending) callback(0); });
};

it("scrubs with pointer capture, pauses playback and clamps at the shot boundaries (#1040)", async () => {
  const { q } = await mount();
  const track = q('[aria-label="Stage playhead"]');
  capturePointer(track);
  await click(q('[aria-label="Play"]'));
  await pointer(track, "pointerdown", 200);
  assert.equal(track.getAttribute("aria-valuenow"), "1");
  assert.ok(q('[aria-label="Play"]'), "scrubbing pauses");
  assert.equal(track.hasPointerCapture(1), true);
  await pointer(track, "pointermove", 600);
  assert.equal(track.getAttribute("aria-valuenow"), "4");
  await pointer(track, "pointermove", 0);
  assert.equal(track.getAttribute("aria-valuenow"), "0");
  await pointer(track, "pointerup", 0);
  await pointer(track, "pointermove", 300);
  assert.equal(track.getAttribute("aria-valuenow"), "0", "released pointers no longer scrub");
});

it("supports Stage shortcuts without stealing field input or allowing frozen gestures (#1040)", async () => {
  const { q, render } = await mount();
  const stage = q('[data-testid="workspace-stage"]');
  const track = q('[aria-label="Stage playhead"]');
  const time = () => Number(track.getAttribute("aria-valuenow"));
  capturePointer(track);
  await key(stage, "ArrowRight");
  assert.equal(time(), 1 / STAGE_FRAME_RATE);
  await key(stage, "ArrowLeft");
  assert.equal(time(), 0);
  await key(stage, "End");
  assert.equal(time(), 4);
  await key(stage, "Home");
  assert.equal(time(), 0);
  await key(stage, "2");
  assert.equal(time(), 2);
  assert.match(q('.fy-swstage__key[data-on="true"]').textContent ?? "", /key 1/);
  const input = q('[aria-label="Camera roll"]');
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  await act(async () => input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
  assert.equal((await key(input, "Home")).defaultPrevented, false);
  await key(input, " ");
  assert.equal(time(), 2);
  assert.ok(q('[aria-label="Play"]'));
  await key(stage, " ");
  assert.ok(q('[aria-label="Pause"]'));
  await render(true);
  assert.ok(q('[aria-label="Play"]'));
  await key(stage, "End");
  await pointer(track, "pointerdown", 450);
  await click(q(".fy-swstage__loop"));
  assert.equal(time(), 2);
  assert.equal(track.hasPointerCapture(1), false);
  assert.equal(q(".fy-swstage__loop").getAttribute("aria-pressed"), "false");
});

it("stops at the end by default and loops using elapsed wall time only when enabled (#1040)", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const { q } = await mount();
  const track = q('[aria-label="Stage playhead"]');
  assert.equal(q(".fy-swstage__loop").getAttribute("aria-pressed"), "false");
  await click(q('[aria-label="Play"]'));
  now += 4500;
  await tick();
  assert.equal(track.getAttribute("aria-valuenow"), "4");
  assert.ok(q('[aria-label="Play"]'));
  await click(q(".fy-swstage__loop"));
  await click(q('[aria-label="Play"]'));
  now += 8500;
  await tick();
  assert.equal(track.getAttribute("aria-valuenow"), "0.5");
  assert.ok(q('[aria-label="Pause"]'));
  await click(q(".fy-swstage__loop"));
  now += 3000;
  await tick();
  assert.equal(track.getAttribute("aria-valuenow"), "3.5", "turning Loop off finishes the current pass");
  now += 1000;
  await tick();
  assert.equal(track.getAttribute("aria-valuenow"), "4");
  assert.ok(q('[aria-label="Play"]'));
});
