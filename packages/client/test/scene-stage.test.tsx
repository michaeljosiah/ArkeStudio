import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { orderedShots, resolvedShotStaging, stageProblems, STAGE_FRAME_RATE, type ClientMessage, type Shot } from "@arke-studio/contracts";
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

async function mount(configure?: (shot: Shot) => void) {
  const world = structuredClone(FIXTURE_STATE.world!);
  const production = world.productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(s => s.id === "sc_04")!;
  const shot = orderedShots(scene).find(s => s.id === "sh_12")!;
  shot.durationSec = 4;
  shot.staging = { version: 1, cast: [], sets: [], keys: [0, 2, 4].map(t => ({ t, p: [0, 1.5, 3], l: [0, 1, 0] })) };
  configure?.(shot);
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

function movingShot(shot: Shot) {
  shot.staging!.cast = [{ sheetId: "maren-kest", x: 0, z: 0 }];
  shot.staging!.sets = [{ name: "Cart", group: "cart", x: 0, z: 0, w: 2, h: 1, d: 1 }];
  shot.staging!.performances = [{ sheetId: "maren-kest", keys: [{ t: 1, x: 0, z: 0, pose: "sit" }, { t: 3, x: 2, z: 1 }] }];
  shot.staging!.objectMotions = [{ group: "cart", keys: [{ t: 0.5, p: [0, 0, 0] }, { t: 2, p: [1, 0, 0] }, { t: 3.5, p: [2, 0, 0] }] }];
}

it("selects timed marks, retimes within neighbours, and Keeps the same performance/object tracks (#1041)", async () => {
  const { q, sent, scene } = await mount(movingShot);
  const performance = q('[data-key-track="performance"]');
  const object = q('[data-key-track="object"]');
  assert.equal(performance.querySelectorAll("button").length, 2);
  assert.equal(object.querySelectorAll("button").length, 3);
  assert.match(performance.getAttribute("style") ?? "", /7a2e43/, "the viewport's cast colour");
  const first = performance.querySelector<HTMLElement>("button")!;
  await click(first);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "1");
  assert.ok(q('[data-motion-mark="selected"]').closest("details")!.open);
  assert.match(q(".fy-swstage__sel").textContent ?? "", /Maren/);
  assert.equal((await key(q('[data-motion-mark="selected"]').closest("details")!.querySelector("summary")!, " ")).defaultPrevented, false);
  assert.ok(q('[aria-label="Play"]'), "Space leaves summary activation to the browser");
  capturePointer(performance);
  capturePointer(first);
  await pointer(first, "pointerdown", 200);
  await pointer(first, "pointermove", 500);
  await pointer(first, "pointerup", 500);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "2.9", "cannot cross the next mark");
  assert.match(q('[data-testid="stage-moved"]').textContent ?? "", /^Stage changed/, "motion edits do not claim the camera start moved");
  await pointer(first, "pointerdown", 390);
  await pointer(first, "pointermove", 225);
  await pointer(first, "pointerup", 225);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "1.25", "the first action mark is not pinned");
  await click(performance.querySelectorAll<HTMLElement>("button")[1]!);
  assert.match(q(".fy-swstage__sel").textContent ?? "", /Maren Kest · mark 2/);
  const last = object.querySelectorAll<HTMLElement>("button")[2]!;
  capturePointer(object);
  capturePointer(last);
  await pointer(last, "pointerdown", 450);
  assert.match(q(".fy-swstage__sel").textContent ?? "", /cart/);
  assert.ok(q('[data-motion-mark="selected"]').closest("details")!.open);
  await pointer(last, "pointermove", 600);
  await pointer(last, "pointerup", 600);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "4");
  assert.equal(sent.length, 0, "timing stays in the local draft");
  await click([...q('[data-testid="stage-moved"]').querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Keep")!);
  const command = sent.at(-1)!;
  assert.equal(command.kind, "edit-stage");
  if (command.kind !== "edit-stage") return;
  assert.deepEqual(command.staging?.performances?.[0]?.keys, [{ t: 1.25, x: 0, z: 0, pose: "sit" }, { t: 3, x: 2, z: 1 }]);
  assert.deepEqual(command.staging?.objectMotions?.[0]?.keys.map(key => key.t), [0.5, 2, 4]);
  assert.deepEqual(command.staging?.keys.map(key => key.t), [0, 2, 4]);
  assert.deepEqual(stageProblems(resolvedShotStaging(scene, { ...command.staging!, version: 2 }), 4), [], "Keep passes the coordinator's write-boundary validation");
});

it("scales every lane and stops a drag when duration or editability changes (#1041)", async () => {
  const { q, shot, render } = await mount(movingShot);
  shot.durationSec = 8;
  await render();
  assert.ok(q('[aria-label="Maren Kest mark 1 at 2.00 seconds"]'));
  assert.ok(q('[aria-label="cart mark 3 at 7.00 seconds"]'));
  const track = q('[data-key-track="object"]');
  const mark = track.querySelector<HTMLElement>("button")!;
  capturePointer(track);
  capturePointer(mark);
  await pointer(mark, "pointerdown", 150);
  shot.durationSec = 4;
  await render();
  await pointer(mark, "pointermove", 400);
  assert.equal(q('[data-testid="stage-moved"]'), null, "old drag bounds cannot edit a retimed track");
  await pointer(mark, "pointerdown", 150);
  await render(true);
  await pointer(mark, "pointermove", 400);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "0.5");
  assert.equal(q('[data-testid="stage-moved"]'), null);
});

it("edits camera easing through Keep and preserves duplicate-key holds when their edge is dragged (#1042)", async () => {
  const { q, sent } = await mount(shot => {
    shot.staging!.keys[0]!.anchorSpace = "local"; // A detached anchor's space flag no longer changes world coordinates.
    shot.staging!.keys[2]!.p = [2, 1.5, 3];
  });
  const setEase = async (label: string, value: string) => {
    const input = q(`[aria-label="${label}"]`) as HTMLInputElement;
    assert.equal(input.getAttribute("min"), "0");
    assert.equal(input.getAttribute("max"), "0.5");
    input.value = value;
    const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onChange: (event: { target: HTMLInputElement }) => void }>)[propsKey]!;
    await act(async () => props.onChange({ target: input }));
  };
  await click(q('[aria-label="Camera key 1 at 2.00 seconds"]'));
  await setEase("Ease in", "0.25");
  await setEase("Ease out", "0.5");
  await setEase("Ease out", "0.75");
  const track = q('[aria-label="Stage playhead"]');
  const edge = q('[aria-label="Retime hold ending at 2.00 seconds"]');
  capturePointer(track);
  capturePointer(edge);
  await pointer(edge, "pointerdown", 300);
  await pointer(edge, "pointermove", 350);
  await pointer(edge, "pointerup", 350);
  assert.equal(track.getAttribute("aria-valuenow"), "2.5");
  assert.ok(q('[aria-label="Hold from 0.00 to 2.50 seconds"]'));
  await click([...q('[data-testid="stage-moved"]').querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Keep")!);
  const command = sent.at(-1)!;
  assert.equal(command.kind, "edit-stage");
  if (command.kind !== "edit-stage") return;
  assert.deepEqual(command.staging?.keys.map(key => key.t), [0, 2.5, 4]);
  assert.deepEqual(command.staging?.keys[0]?.p, command.staging?.keys[1]?.p);
  assert.equal(command.staging?.keys[1]?.easeIn, 0.25);
  assert.equal(command.staging?.keys[1]?.easeOut, 0.5);
  assert.equal(command.staging?.keys.length, 3, "a hold remains the same pair of keys");
});

it("distinguishes equal coordinates in different anchor spaces and pins a terminal hold (#1042)", async () => {
  const { q, render } = await mount(shot => {
    shot.staging!.cast = [{ sheetId: "maren-kest", x: 3, z: 0 }];
    shot.staging!.keys[1]!.anchor = "maren-kest";
    shot.staging!.keys[2]!.anchor = "maren-kest";
  });
  assert.equal(q('[aria-label="Hold from 0.00 to 2.00 seconds"]'), null);
  assert.ok(q('[aria-label="Hold from 2.00 to 4.00 seconds"]'));
  assert.equal((q('[aria-label="Retime hold ending at 4.00 seconds"]') as HTMLButtonElement).disabled, true);
  await render(true);
  assert.equal((q('[aria-label="Ease in"]') as HTMLInputElement).disabled, true);
});
