import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { orderedShots, resolvedShotStaging, stageProblems, STAGE_FRAME_RATE, type ClientMessage, type SceneRecord, type Shot } from "@arke-studio/contracts";
import { SceneStage, keysLensWords } from "../src/screens/scene-workspace/stage.js";
import { sameLine } from "../src/screens/scene-workspace/stage-inspector.js";
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
      <MemoryRouter><SelectionProvider value={{ subject: { kind: "shot", shotId: shot.id }, select: () => {} }}>
        <SceneStage scene={scene} production={production} world={world} aspect="16:9" sceneFile={undefined}
          locked={locked} generatorPending={false} refusalVersion={0} onCommand={command => { sent.push(command); return true; }} onRenderShot={() => {}} />
      </SelectionProvider></MemoryRouter>,
    ));
  };
  await render();
  const q = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  return { q, render, shot, scene, sent, world };
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
/** The Stage inspector's list (turn 144): one line per thing on the stage, pressed to select it. */
const stageItem = (q: (selector: string) => HTMLElement, name: string): HTMLElement =>
  [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__item")].find((item) => item.querySelector("span:nth-child(2)")?.textContent === name)!;
const selectedItem = (q: (selector: string) => HTMLElement): string => q('.fy-swstage__item[data-selected="true"]')?.textContent ?? "";
/** linkedom's select has no value setter: mark the option chosen, then say so. */
const choose = async (select: HTMLElement, value: string) => {
  for (const option of select.querySelectorAll("option")) {
    if (option.getAttribute("value") === value) option.setAttribute("selected", ""); else option.removeAttribute("selected");
  }
  await act(async () => { select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
};
/** Add set opens the kit (issue 1819, design turn 229e); a plain box is its first primitive. */
const addBox = async (q: (selector: string) => HTMLElement) => {
  await click([...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Add set")!);
  await click([...q('[data-testid="stage-kit-menu"]').querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Box")!);
};
const tick = async () => {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => { for (const callback of pending) callback(0); });
};

it("links the blockout controls directly to the Stage designer model", async () => {
  const { q } = await mount();
  const link = q('.fy-swstage__construction a');
  assert.equal(link.textContent, "Stage model");
  assert.equal(link.getAttribute("href"), "/settings/harness?agent=stage-designer");
  assert.ok(q('.fy-swstage__construction').textContent?.includes("Build with Arke"));
});

it("scrubs with pointer capture, pauses playback and clamps at the shot boundaries (#1040)", async () => {
  const { q } = await mount();
  const track = q('[aria-label="Stage playhead"]');
  assert.equal(track.querySelector("button"), null, "key buttons are not flattened under the slider role");
  assert.equal(q('[aria-label="Camera start at 0.00 seconds"]').closest('[role="slider"]'), null);
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
  assert.match(performance.getAttribute("style") ?? "", /2f7fd8/i, "the viewport's cast colour (design turn 229 rule 3)");
  const first = performance.querySelector<HTMLElement>("button")!;
  await click(first);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "1");
  assert.match(selectedItem(q), /Maren/, "a pressed mark selects its figure, whose form shows the mark");
  assert.match(q('[data-motion-mark="selected"]').textContent ?? "", /1\.00 s/);
  capturePointer(performance);
  capturePointer(first);
  await pointer(first, "pointerdown", 200);
  await pointer(first, "pointermove", 500);
  await pointer(first, "pointerup", 500);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "2.9", "cannot cross the next mark");
  assert.match(q('[data-testid="stage-draft"]').textContent ?? "", /^Changes~Maren Kest /, "motion edits are the figure's in the draft bar, not the camera start's (231b)");
  await pointer(first, "pointerdown", 390);
  await pointer(first, "pointermove", 225);
  await pointer(first, "pointerup", 225);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "1.25", "the first action mark is not pinned");
  await click(performance.querySelectorAll<HTMLElement>("button")[1]!);
  assert.match(selectedItem(q), /Maren Kest/);
  assert.match(q('[data-motion-mark="selected"]').textContent ?? "", /3\.00 s/, "mark 2");
  const last = object.querySelectorAll<HTMLElement>("button")[2]!;
  capturePointer(object);
  capturePointer(last);
  await pointer(last, "pointerdown", 450);
  assert.match(selectedItem(q), /Cart/, "an object mark selects a set of its group");
  assert.ok(q('[data-motion-mark="selected"]'));
  await pointer(last, "pointermove", 600);
  await pointer(last, "pointerup", 600);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "4");
  assert.equal(sent.length, 0, "timing stays in the local draft");
  await click([...q('[data-testid="stage-draft"]').querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Keep")!);
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
  assert.equal(q('[data-testid="stage-draft"]'), null, "old drag bounds cannot edit a retimed track");
  await pointer(mark, "pointerdown", 150);
  await render(true);
  await pointer(mark, "pointermove", 400);
  assert.equal(q('[aria-label="Stage playhead"]').getAttribute("aria-valuenow"), "0.5");
  assert.equal(q('[data-testid="stage-draft"]'), null);
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
  capturePointer(track.parentElement!);
  capturePointer(edge);
  await pointer(edge, "pointerdown", 300);
  await pointer(edge, "pointermove", 350);
  await pointer(edge, "pointerup", 350);
  assert.equal(track.getAttribute("aria-valuenow"), "2.5");
  assert.ok(q('[aria-label="Hold from 0.00 to 2.50 seconds"]'));
  await click([...q('[data-testid="stage-draft"]').querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Keep")!);
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
  await click(stageItem(q, "camera"));
  await render(true);
  assert.equal((q('[aria-label="Ease in"]') as HTMLInputElement).disabled, true);
});

it("clears a motion selection when its mark is removed or an earlier mark is inserted", async () => {
  const { q } = await mount(movingShot);
  await click(q('[aria-label="Maren Kest mark 2 at 3.00 seconds"]'));
  assert.ok(q('[data-motion-mark="selected"]'));
  const links = () => [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__link")];
  await click(links().find(button => button.textContent === "Remove mark")!);
  assert.equal(q('[data-motion-mark="selected"]'), null);
  assert.match(selectedItem(q), /Maren Kest/, "the figure the mark belonged to stays selected");
  await click(q('[aria-label="cart mark 2 at 2.00 seconds"]'));
  assert.ok(q('[data-motion-mark="selected"]'));
  await key(q('[aria-label="Stage playhead"]'), "Home");
  await click(links().find(button => button.textContent === "Mark here")!);
  assert.equal(q('[data-motion-mark="selected"]'), null, "an earlier mark inserted renumbers the marks, so none is the chosen one");
  assert.match(selectedItem(q), /Cart/);
});

it("edits gait, ease and hold with a single-key camera through retiming and Keep (#1044, #1046)", async () => {
  const { q, sent, shot, render } = await mount(shot => {
    shot.staging!.cast = [{ sheetId: "maren-kest", x: 0, z: 0 }];
    shot.staging!.performances = [{ sheetId: "maren-kest", keys: [{ t: 0, x: 0, z: 0 }, { t: 1, x: 5, z: 0 }] }];
    shot.staging!.keys = [shot.staging!.keys[0]!];
  });
  assert.match(stageItem(q, "Maren Kest").textContent ?? "", /walk.*too fast/);
  // The figure's form shows one mark's fields at a time: the mark pressed on the timeline.
  await click(q('[aria-label="Maren Kest mark 1 at 0.00 seconds"]'));
  const select = q('[aria-label="Maren Kest 0s gait"]');
  const propsKey = Object.keys(select).find(key => key.startsWith("__reactProps$"))!;
  const props = (select as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[propsKey]!;
  await act(async () => props.onChange({ target: { value: "run" } }));
  assert.match(stageItem(q, "Maren Kest").textContent ?? "", /run/);
  assert.doesNotMatch(stageItem(q, "Maren Kest").textContent ?? "", /too fast/);
  for (const [mark, label, value] of [["1 at 0.00", "0s easeOut", "0.25"], ["2 at 1.00", "1s easeIn", "0.5"], ["1 at 0.00", "0s hold", "0.25"]]) {
    await click(q(`[aria-label="Maren Kest mark ${mark} seconds"]`));
    const input = q(`[aria-label="Maren Kest ${label}"]`);
    const key = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
    const handlers = (input as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
    await act(async () => handlers.onChange({ target: { value: value! } }));
  }
  assert.ok(q('[aria-label="Maren Kest hold from 0.00 to 0.25 seconds"]'));
  shot.durationSec = 8;
  await render();
  assert.ok(q('[aria-label="Maren Kest hold from 0.00 to 0.50 seconds"]'));
  await click([...q('[data-testid="stage-draft"]').querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Keep")!);
  const command = sent.at(-1)!;
  assert.equal(command.kind, "edit-stage");
  if (command.kind === "edit-stage") {
    const keys = command.staging?.performances?.[0]?.keys;
    assert.equal(keys?.[0]?.gait, "run");
    assert.equal(keys?.[0]?.easeOut, .25);
    assert.equal(keys?.[0]?.hold, .5);
    assert.equal(keys?.[1]?.easeIn, .5);
    assert.equal(keys?.[1]?.t, 2);
  }
});

it("puts a chosen camera move in the draft and Keeps it without changing timed action (#1048)", async () => {
  const { q, sent, shot, render } = await mount(movingShot);
  const action = structuredClone(shot.staging!.performances);
  const objects = structuredClone(shot.staging!.objectMotions);
  await click(stageItem(q, "camera"));
  const select = q('[aria-label="Camera move"]');
  const propsKey = Object.keys(select).find(key => key.startsWith("__reactProps$"))!;
  const props = (select as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[propsKey]!;
  await act(async () => props.onChange({ target: { value: "orbit-360" } }));
  assert.equal(sent.length, 0, "choosing a move only authors a draft");
  assert.equal(q('[data-key-track="1"]')?.querySelectorAll("button.fy-swstage__key").length, 9);
  await click([...q('[data-testid="stage-draft"]').querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "Keep")!);
  const command = sent.at(-1)!;
  assert.equal(command.kind, "edit-stage");
  if (command.kind !== "edit-stage") return;
  assert.equal(command.staging?.keys.length, 9);
  assert.deepEqual(command.staging?.performances, action);
  assert.deepEqual(command.staging?.objectMotions, objects);
  await render(true);
  assert.equal((q('[aria-label="Camera move"]') as HTMLSelectElement).disabled, true);
});

// ---- The panel as an inspector (design turn 144) ------------------------------------------------

it("names the lens the keys are drawn through on the camera's line, a key's own before the shot's (issue 1865 §7)", async () => {
  const { q } = await mount((shot) => { shot.framing = { lens: "35mm" }; for (const key of shot.staging!.keys) key.focalMm = 14; });
  assert.match(stageItem(q, "camera").textContent ?? "", /· 14 mm$/);
  const { q: zoom } = await mount((shot) => { shot.staging!.keys[2]!.focalMm = 50; });
  assert.match(stageItem(zoom, "camera").textContent ?? "", /· \d+–50 mm$/, "a zoom says its range, the other keys at the lens they are drawn through");
});

it("captions the picture with the lens the camera's line names (issue 1888)", () => {
  assert.equal(keysLensWords([{}, {}], undefined, "16:9"), undefined, "nothing named: the caption says the lens is unset");
  assert.equal(keysLensWords([{}, {}], "35mm", "16:9"), "35 mm");
  assert.match(keysLensWords([{ focalMm: 50 }, {}], undefined, "16:9") ?? "", /^\d+–50 mm$/, "one key at 50 mm with the shot's unset: a range, not 'lens unset'");
  assert.equal(keysLensWords([{ focalMm: 14 }, { focalMm: 14 }], "35mm", "16:9"), "14 mm");
});

it("lists what is on the stage with its state, and shows one form for the selection (turn 144)", async () => {
  const { q } = await mount((shot) => { movingShot(shot); shot.framing = { lens: "35mm" }; });
  const items = () => [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__item")].map((item) => item.textContent);
  assert.deepEqual(items(), ["cameralocked off · 35 mm", "Maren Kestwalks 2.2 m · stands", "Cartbox"], "camera, every figure, every set, each with its state, in 229a's words");
  const eyebrows = () => [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__eyebrow > span:first-child")].map((span) => span.textContent);
  assert.deepEqual(eyebrows(), ["Stage", "Shot"], "nothing selected: the shot's form");
  assert.ok(q('[aria-label="Camera rig"]'), "the rig is chosen on the shot's form");
  assert.equal(q('[aria-label="Camera move"]'), null);

  await click(stageItem(q, "camera"));
  assert.deepEqual(eyebrows(), ["Stage", "Camera"]);
  assert.match(selectedItem(q), /camera/);
  for (const label of ["Camera move", "Camera height", "Camera back", "Camera aim target", "Camera roll", "Camera lens", "Ease in", "Ease out"]) assert.ok(q(`[aria-label="${label}"]`), label);
  assert.equal(q('[aria-label="Camera height"]').nextElementSibling?.textContent, "m", "a number carries its unit");
  assert.equal(q('[aria-label="Camera lens"]').getAttribute("placeholder"), "35", "an unset lens reads the shot's, muted");

  await click(stageItem(q, "Maren Kest"));
  assert.deepEqual(eyebrows(), ["Stage", "Figure"]);
  assert.ok(q('[aria-label="Maren Kest pose"]'));
  assert.equal([...q('[data-testid="workspace-stage"]').querySelectorAll(".fy-swstage__markrow")].length, 2, "the figure's marks, one line each");

  await click(stageItem(q, "Cart"));
  assert.deepEqual(eyebrows(), ["Stage", "Set"]);
  for (const label of ["Set 1 name", "Cart shape", "Cart solid", "Set 1 x", "Set 1 elevation", "Set 1 z", "Set 1 width", "Set 1 height", "Set 1 depth", "Cart pitch", "Cart turn", "Cart roll", "Set 1 group"]) assert.ok(q(`[aria-label="${label}"]`), label);
  assert.equal([...q('[data-testid="workspace-stage"]').querySelectorAll(".fy-swstage__markrow")].length, 3, "the group's motion marks");

  await click(stageItem(q, "Cart"));
  assert.deepEqual(eyebrows(), ["Stage", "Shot"], "pressing the selected line again clears the selection");
  assert.ok([...q('[data-testid="workspace-stage"]').querySelectorAll("button")].some((button) => button.textContent === "Render with this"), "the ways on stay under every form");
});

it("every row starts its control at the label column's edge: one grammar, no browser input (turn 144)", async () => {
  const { q } = await mount(movingShot);
  await click(stageItem(q, "Cart"));
  const rows = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__row")];
  assert.ok(rows.length >= 8);
  for (const row of rows) {
    assert.equal(row.firstElementChild?.className, "fy-swstage__rowlabel", "the label column comes first on every row");
    assert.equal(row.querySelector("input:not([class]):not(.fy-swstage__triad input):not(.fy-swstage__stepper input):not(.fy-swstage__check input)"), null, "no bare input");
  }
  const kinds = new Set(rows.map((row) => row.children[1]?.className.replace(/ .*/, "")));
  for (const kind of ["fy-swstage__field", "fy-swstage__select", "fy-swstage__check", "fy-swstage__triad", "fy-swstage__value", "fy-swstage__link"]) assert.ok(kinds.has(kind), kind);
});

it("a set's form writes its place, size, rotation and group, and Add set selects the new set (turn 144)", async () => {
  const { q, sent, shot, scene } = await mount(movingShot);
  await click(stageItem(q, "Cart"));
  const commit = async (label: string, value: string) => {
    const input = q(`[aria-label="${label}"]`) as HTMLInputElement;
    input.value = value;
    const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onBlur: (event: { currentTarget: HTMLInputElement }) => void }>)[key]!;
    await act(async () => props.onBlur({ currentTarget: input }));
  };
  await commit("Set 1 elevation", "0.5");
  await commit("Cart turn", "90");
  await commit("Set 1 group", "Wagon Train");
  await click([...q('[data-testid="stage-draft"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Keep")!);
  const command = sent.at(-1)!;
  assert.equal(command.kind, "edit-stage");
  if (command.kind !== "edit-stage") return;
  const set = command.staging?.sets?.[0];
  assert.equal(set?.y, 0.5);
  assert.deepEqual(set?.rotation, [0, 90, 0]);
  assert.equal(set?.group, "wagon-train", "a group is a slug");
  assert.equal(command.staging?.objectMotions?.[0]?.group, "wagon-train", "the group's motion track follows its last set's new name");
  assert.deepEqual(stageProblems(resolvedShotStaging(scene, { ...shot.staging!, ...command.staging! }), 4), [], "what was Kept passes the write boundary");
  await addBox(q);
  assert.match(selectedItem(q), /set 2/, "the new set is the thing to name next");
  assert.ok(q('[aria-label="Set 2 name"]'));
});

/** A field's value, committed the way a person leaves the box: onBlur, since linkedom fires no focusout of its own. */
async function leaveField(input: HTMLInputElement, value: string) {
  input.value = value;
  const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onBlur: (event: { currentTarget: HTMLInputElement }) => void }>)[key]!;
  await act(async () => props.onBlur({ currentTarget: input }));
}

it("a group's references follow it: cleared, its track and the camera's anchor go; removing the selected set clears the selection", async () => {
  const { q, sent, shot, scene } = await mount((candidate) => {
    movingShot(candidate);
    candidate.staging!.keys[1]!.anchor = "cart";
    candidate.staging!.cast![0]!.parent = "cart";
  });
  await click(stageItem(q, "Cart"));
  await leaveField(q('[aria-label="Set 1 group"]') as HTMLInputElement, "");
  await click([...q('[data-testid="stage-draft"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Keep")!);
  const command = sent.at(-1)!;
  assert.equal(command.kind, "edit-stage");
  if (command.kind !== "edit-stage") return;
  assert.equal(command.staging?.sets?.[0]?.group, undefined);
  assert.deepEqual(command.staging?.objectMotions, [], "a track cannot name a group nothing carries");
  assert.equal(command.staging?.keys[1]?.anchor, undefined, "the camera's anchor on the group goes with it");
  assert.equal(command.staging?.cast?.[0]?.parent, undefined, "so does the figure's parent");
  assert.deepEqual(stageProblems(resolvedShotStaging(scene, { ...shot.staging!, ...command.staging! }), 4), []);

  const links = () => [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__link")];
  await click(links().find((link) => link.textContent === "Remove set")!);
  assert.equal(q('.fy-swstage__item[data-selected="true"]'), null, "the removed set is no longer the selection");
  assert.ok(q('[aria-label="Camera rig"]'), "with nothing selected the shot's form is back, not a stale set's or none");
  assert.equal(stageItem(q, "Cart"), undefined);
});

it("Escape restores the whole authored draft after valid live numeric edits", async () => {
  const { q } = await mount(shot => {
    movingShot(shot);
    shot.staging!.authorship = { model: "test/vision", sourceVersion: 1, sourceFingerprint: "a".repeat(64),
      instruction: "Frame the doorway", assumptions: [], assessment: "Reviewed framing", inspectedFrames: 3 };
  });
  const input = q('[aria-label="Rig intensity"]') as HTMLInputElement;
  const props = () => (input as unknown as Record<string, {
    onFocus: () => void;
    onKeyDown: (event: { key: string; currentTarget: HTMLInputElement; preventDefault: () => void; stopPropagation: () => void }) => void;
    onChange: (event: { target: { value: string } }) => void;
    onBlur: (event: { currentTarget: HTMLInputElement }) => void;
  }>)[Object.keys(input).find(key => key.startsWith("__reactProps$"))!]!;
  await act(async () => props().onFocus());
  await act(async () => props().onChange({ target: { value: "1.75" } }));
  assert.ok(q('[data-testid="stage-draft"]'), "valid typing previews the change");
  await act(async () => props().onKeyDown({ key: "Escape", currentTarget: input, preventDefault() {}, stopPropagation() {} }));
  await act(async () => props().onBlur({ currentTarget: input }));
  assert.equal(input.value, "1.00");
  assert.equal(q('[data-testid="stage-draft"]'), null);
});

it("Escape in a field is the field's: it drops what was typed without committing, and stops there; other keys pass", async () => {
  const { q, shot } = await mount(movingShot);
  const reached: string[] = [];
  const listen = (event: Event) => reached.push((event as KeyboardEvent).key);
  dom.document.addEventListener("keydown", listen);
  try {
    const intensity = q('[aria-label="Rig intensity"]') as HTMLInputElement;
    const propsKey = Object.keys(intensity).find((candidate) => candidate.startsWith("__reactProps$"))!;
    const props = (intensity as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void; onBlur: (event: { currentTarget: HTMLInputElement }) => void }>)[propsKey]!;
    await act(async () => props.onChange({ target: { value: "999" } }));
    assert.equal(intensity.value, "999", "typing out of range shows but does not land");
    assert.equal(q('[data-testid="stage-draft"]'), null);
    await key(intensity, "ArrowUp");
    await key(intensity, "Escape");
    // The Escape's blur has no focusout in linkedom; the one a browser fires must not commit either.
    await act(async () => props.onBlur({ currentTarget: intensity }));
    assert.equal(intensity.value, "1.00", "Escape reverts to the value that stands");
    assert.equal(q('[data-testid="stage-draft"]'), null, "and nothing was clamped into the draft on the way out");
    assert.deepEqual(reached, ["ArrowUp"], "Escape stopped at the field; the arrow reached the page");

    await click(stageItem(q, "Cart"));
    const turn = q('[aria-label="Cart turn"]') as HTMLInputElement;
    turn.value = "45";
    await key(turn, "Escape");
    assert.equal(turn.value, "0", "a triad cell reverts the same way");
    assert.equal(shot.staging?.sets?.[0]?.rotation, undefined);
    assert.deepEqual(reached, ["ArrowUp"]);
  } finally {
    dom.document.removeEventListener("keydown", listen);
  }
});

it("a scene with no shots keeps the way out of full screen", async () => {
  const world = structuredClone(FIXTURE_STATE.world!);
  const production = world.productions.find(p => p.meta.id === "saltlight")!;
  const at = production.scenes.findIndex(s => s.id === "sc_04");
  // A legacy scene shape with no flow and no shots: the Stage has nothing to stage.
  const scene = { ...production.scenes[at], shots: [] } as unknown as SceneRecord;
  delete (scene as { flow?: unknown }).flow;
  production.scenes[at] = scene;
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  let left = 0;
  await act(async () => root!.render(
    <SelectionProvider value={{ subject: { kind: "scene" }, select: () => {} }}>
      <SceneStage scene={scene} production={production} world={world} aspect="16:9" sceneFile={undefined} fullscreen={{ leave: () => { left += 1; } }}
        locked={false} generatorPending={false} refusalVersion={0} onCommand={() => true} onRenderShot={() => {}} />
    </SelectionProvider>,
  ));
  const exit = container.querySelector<HTMLElement>(".fy-swstage--empty .fy-swstage__exit");
  assert.ok(exit, "no head row to carry it, so the exit stands alone in the empty state");
  await click(exit!);
  assert.equal(left, 1);
});

it("a list line stands for every pick of its thing, and a line that leaves the list takes the selection with it", async () => {
  // The viewport picks the camera's aim or the end of a walk; the list shows one line for each thing.
  assert.equal(sameLine({ kind: "aim" }, { kind: "rig" }), true, "the camera line, whichever end of it the viewport holds");
  assert.equal(sameLine({ kind: "walkend", sheetId: "maren-kest" }, { kind: "cast", sheetId: "maren-kest" }), true, "a figure's line, at either end of its walk");
  assert.equal(sameLine({ kind: "cast", sheetId: "maren-kest" }, { kind: "cast", sheetId: "bray" }), false);
  assert.equal(sameLine({ kind: "set", index: 0 }, { kind: "set", index: 1 }), false);
  assert.equal(sameLine(null, { kind: "rig" }), false);

  const { q } = await mount(movingShot);
  await addBox(q);
  assert.match(selectedItem(q), /set 2/);
  await click(q('[aria-label="Discard"]'));
  assert.equal(stageItem(q, "set 2"), undefined, "the discarded draft takes its set");
  assert.equal(q('.fy-swstage__item[data-selected="true"]'), null, "and the selection that pointed at it");
  assert.ok(q('[aria-label="Camera rig"]'), "the shot's form, not an empty panel");
});

// The location plate (issue 1818, design turn 229c).
const PLATE_PICTURE = { id: "ar_01J8G0000000000000000000P1", kind: "image" as const, file: "lobby-plate.png", hash: "sha256:aaaabbbbccccdddd", origin: { by: "user" as const }, links: [], created: "2026-10-17T09:00:00.000Z" };

it("opens the blockout line with a dashed Add plate, and a pick writes the plate with the scene's marks", async () => {
  const { q, render, world, sent } = await mount();
  world.artifacts.push(PLATE_PICTURE as never);
  await render();
  const chip = q('[data-testid="stage-plate-chip"]');
  assert.equal(chip.textContent, "Add plate");
  assert.equal(chip.getAttribute("data-empty"), "true");
  assert.equal(chip.parentElement?.nextElementSibling?.getAttribute("aria-label"), "Blockout instruction", "the plate opens the line");
  await click(chip);
  const options = [...q('[data-testid="stage-plate-picker"]').querySelectorAll<HTMLElement>('[role="option"]')];
  assert.ok(options.length >= 1);
  await click(options.find((option) => option.title === "lobby-plate.png") ?? options[0]!);
  const write = sent.at(-1);
  assert.equal(write?.kind, "edit-stage");
  const blocking = write?.kind === "edit-stage" ? write.blocking : undefined;
  assert.deepEqual(blocking?.plate?.source, { source: "artifact", artifactId: PLATE_PICTURE.id, hash: PLATE_PICTURE.hash });
  assert.equal(blocking?.plate?.label, "Location");
  assert.deepEqual(blocking?.cast, [], "the plate rides on the marks it found, and moves none of them");
});

it("writes a first plate with the scene's marks, never this shot's own, from this production's pictures (issue 1818)", async () => {
  const { q, render, scene, world, sent } = await mount((shot) => {
    shot.staging = { ...shot.staging!, cast: [{ sheetId: "maren-kest", x: 1, z: 0 }], sets: [{ name: "rail", x: 0, z: -2, w: 4, h: 1, d: .2 }] };
  });
  scene.blocking = undefined;
  world.artifacts.push(PLATE_PICTURE as never, { ...PLATE_PICTURE, id: "ar_01J8G0000000000000000000P2", file: "elsewhere.png", production: "another" } as never);
  await render();
  await click(q('[data-testid="stage-plate-chip"]'));
  const titles = [...q('[data-testid="stage-plate-picker"]').querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.title);
  assert.ok(titles.includes("lobby-plate.png"));
  assert.equal(titles.includes("elsewhere.png"), false, "another production's picture is not this one's to use");
  await click([...q('[data-testid="stage-plate-picker"]').querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.title === "lobby-plate.png")!);
  const write = sent.at(-1);
  const blocking = write?.kind === "edit-stage" ? write.blocking : undefined;
  assert.deepEqual([blocking?.cast, blocking?.sets], [[], []], "this shot's marks stay its own: every inheriting shot would get them");
});

it("offers no Stage render as a plate, and names a tile by what it is of (issue 1865 §9)", async () => {
  const { q, render, world } = await mount();
  world.artifacts.push(
    PLATE_PICTURE as never,
    { ...PLATE_PICTURE, id: "ar_01J8G0000000000000000000P3", file: "stage-opening.png", origin: { by: "system", producedBy: "stage:sh_12" }, links: ["saltlight", "sc_04", "sh_12"] } as never,
    { ...PLATE_PICTURE, id: "ar_01J8G0000000000000000000P4", file: "maren.png", links: ["maren-kest"] } as never,
  );
  await render();
  await click(q('[data-testid="stage-plate-chip"]'));
  const tiles = [...q('[data-testid="stage-plate-picker"]').querySelectorAll<HTMLElement>('[role="option"]')];
  assert.equal(tiles.some((tile) => tile.title.includes("Shot 12")), false, "the greybox's own still is not a picture of the place");
  assert.ok(tiles.some((tile) => tile.textContent === "Maren Kest"), "a portrait says whose it is rather than \"picture\"");
  assert.equal(tiles.some((tile) => tile.textContent === "picture"), false);
});

it("lists the plate second, opens its form, and Match camera puts the opening key where the plate was taken", async () => {
  const { q, render, scene, world, sent } = await mount();
  world.artifacts.push(PLATE_PICTURE as never);
  scene.blocking = { version: 1, cast: [], sets: [], plate: {
    source: { source: "artifact", artifactId: PLATE_PICTURE.id, hash: PLATE_PICTURE.hash }, label: "Lobby", shotId: "sh_12",
    camera: { p: [0.5, 1.1, 6], l: [0.9, 0.4, -6], focalMm: 18 },
  } };
  await render();
  assert.equal(q('[data-testid="stage-plate-chip"]').textContent, "Lobby · plate");
  const items = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__item")];
  assert.equal(items[1]?.querySelector("span:nth-child(2)")?.textContent, "plate", "second, under the camera");
  assert.equal(items[1]?.querySelector("span:nth-child(3)")?.textContent, "Lobby · matched");
  await click(items[1]!);
  const form = q('[data-testid="stage-plate-form"]');
  assert.match(form.textContent ?? "", /Plate/);
  assert.match(form.textContent ?? "", /Match camera/);
  const match = [...form.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Match camera")!;
  await click(match);
  assert.ok(q('[data-testid="stage-draft"]'), "matching is an edit to keep or discard");
  await click(q(".fy-swstage__keep"));
  const kept = sent.at(-1);
  const opening = kept?.kind === "edit-stage" ? kept.staging?.keys[0] : undefined;
  assert.deepEqual(opening?.p, [0.5, 1.1, 6]);
  assert.deepEqual(opening?.l, [0.9, 0.4, -6]);
  assert.equal(opening?.focalMm, 18);
});

// The set kit (issue 1819, design turn 229e).
it("adds a room from the kit, with its own rows in place of a shape, and keeps it as one entry", async () => {
  const { q, sent } = await mount();
  const add = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__add")].find((button) => button.textContent === "Add set")!;
  await click(add);
  const menu = q('[data-testid="stage-kit-menu"]');
  const labels = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);
  assert.deepEqual(labels.slice(0, 3), ["Roomwalls · openings", "Doorway", "Window"], "the room says it is walls and openings (229e)");
  assert.deepEqual(labels.slice(-3), ["Box", "Cylinder", "Sphere"], "primitives after the kit");
  await click([...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Room"))!);
  assert.equal(selectedItem(q).startsWith("room"), true, "the new item is selected");
  assert.ok(q('[aria-label="room kit"]'), "the kit row");
  assert.equal(q('[aria-label="room shape"]'), null, "no shape for a kit item");
  assert.equal(q('[aria-label="room open sides"] [aria-pressed="true"]')?.textContent, "Front", "a room starts open where the camera stands");
  await click([...q('[data-testid="stage-kit-openings"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Opening")!);
  assert.match(q('[data-testid="stage-kit-openings"]').textContent ?? "", /door · back wall/);
  await click(q(".fy-swstage__keep"));
  const kept = sent.at(-1);
  const sets = kept?.kind === "edit-stage" ? (kept.staging?.sets ?? kept.blocking?.sets) : undefined;
  const room = sets?.find((set) => set.name === "room");
  assert.deepEqual(room?.kit, { kind: "room", open: ["front"], openings: [{ wall: "back", kind: "door", at: 0, w: 1, h: 2.2 }] });
  assert.deepEqual([room?.w, room?.h, room?.d], [6, 3, 8]);
});

// The Stage's look and lights (issue 1825, design turn 229a/229e).
it("offers Greybox · Lit · Plate in the viewport's corner, Plate only once a plate is matched", async () => {
  const { q, render, scene, world } = await mount();
  const options = () => [...q('[data-testid="stage-look"]').querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  assert.deepEqual(options().map((option) => option.textContent), ["Greybox", "Lit", "Plate"]);
  assert.equal(options()[2]!.disabled, true, "no plate, no Plate look");
  assert.equal(q('[data-testid="stage-look"]').nextElementSibling?.className.includes("fy-swstage__ghost"), true, "before the ghost toggle");
  await click(options()[0]!);
  assert.equal(options()[0]!.getAttribute("aria-checked"), "true");
  world.artifacts.push(PLATE_PICTURE as never);
  scene.blocking = { version: 1, cast: [], sets: [], plate: { source: { source: "artifact", artifactId: PLATE_PICTURE.id, hash: PLATE_PICTURE.hash }, label: "Lobby", camera: { p: [0, 1, 5], l: [0, 1, 0], focalMm: 24 } } };
  await render();
  assert.equal(options()[2]!.disabled, false, "a matched plate can be looked through");
  await click(options()[2]!);
  assert.equal(options()[2]!.getAttribute("aria-checked"), "true");
  // The plate goes: Plate is remembered, but what is drawn, and what an export would say, is Lit.
  scene.blocking = { version: 2, cast: [], sets: [] };
  await render();
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "true", "false"]);
});

it("adds a light to a scene without blocking with the scene's marks, never this shot's own (issue 1825)", async () => {
  const { q, render, scene, sent } = await mount((shot) => {
    shot.staging = { ...shot.staging!, cast: [{ sheetId: "maren-kest", x: 1, z: 0 }], sets: [{ name: "rail", x: 0, z: -2, w: 4, h: 1, d: .2 }] };
  });
  scene.blocking = undefined;
  await render();
  await click([...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Add light")!);
  const added = sent.at(-1);
  const blocking = added?.kind === "edit-stage" ? added.blocking : undefined;
  assert.equal(blocking?.lights?.length, 1);
  assert.deepEqual([blocking?.cast, blocking?.sets], [[], []], "this shot's marks stay its own");
});

it("adds a light, opens its form with the scene's Look beneath, and writes both with the scene's marks", async () => {
  const { q, render, scene, sent } = await mount();
  scene.blocking = { version: 1, cast: [], sets: [{ name: "planter", x: 0, z: -5, w: .6, h: 1.4, d: .6 }] };
  await render();
  await click([...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Add light")!);
  const added = sent.at(-1);
  const lights = added?.kind === "edit-stage" ? added.blocking?.lights : undefined;
  assert.equal(lights?.length, 1);
  assert.equal(lights?.[0]?.name, "light");
  assert.equal(lights?.[0]?.kelvin, 3200);
  assert.deepEqual(added?.kind === "edit-stage" ? added.blocking?.sets : undefined, scene.blocking.sets, "the scene's marks ride along unchanged");
  scene.blocking = { ...scene.blocking, lights: lights! };
  await render();
  assert.equal(q('[data-testid="stage-light-line"]').getAttribute("data-selected"), "true", "a new light is the thing to set next");
  const form = q('[data-testid="stage-light-form"]');
  assert.match(form.textContent ?? "", /Light/);
  assert.ok(q('[data-testid="stage-atmosphere"]'), "the scene's Look sits under the light");
  await click([...form.querySelectorAll<HTMLElement>('[role="radio"]')].find((option) => option.textContent === "Spot")!);
  const spot = sent.at(-1);
  assert.equal(spot?.kind === "edit-stage" ? spot.blocking?.lights?.[0]?.kind : undefined, "spot");
  await click([...q('[data-testid="stage-atmosphere"]').querySelectorAll<HTMLElement>('[role="radio"]')].find((option) => option.textContent === "Off")!);
  const shading = sent.at(-1);
  assert.deepEqual(shading?.kind === "edit-stage" ? shading.blocking?.atmosphere : undefined, { shading: "off" });
});

it("brings a Lamp's light with it, held with the draft until Keep (229e rule 7, issue 1865)", async () => {
  const { q, sent, scene } = await mount();
  await click([...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Add set")!);
  const lamp = [...q('[data-testid="stage-kit-menu"]').querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Lamp"))!;
  assert.equal(lamp.textContent, "Lampwith light", "the menu says what else a lamp brings");
  await click(lamp);
  assert.equal(sent.length, 0, "the light waits with the lamp rather than landing on the scene at once");
  const held = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>('[data-testid="stage-light-line"]')].find((line) => line.querySelector("span:nth-child(2)")?.textContent === "lamp");
  assert.equal(held?.querySelector("span:last-child")?.textContent, "point · 8", "the held light is listed beside the scene's");
  assert.equal(held?.querySelector(".fy-swstage__glyph")?.textContent, "+", "and marked new in the draft (231b)");
  const addLight = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add light")!;
  assert.equal(addLight.disabled, true);
  assert.equal(addLight.title, "Keep the move first", "a shut Add light says why");
  await click(q(".fy-swstage__keep"));
  const kept = sent.at(-1);
  const lights = kept?.kind === "edit-stage" ? kept.blocking?.lights : undefined;
  assert.equal(lights?.length, (scene.blocking?.lights?.length ?? 0) + 1);
  assert.deepEqual(lights?.at(-1) && [lights.at(-1)!.name, lights.at(-1)!.y], ["lamp", 1.45], "in the lamp's shade");
  const sets = kept?.kind === "edit-stage" ? (kept.staging?.sets ?? kept.blocking?.sets) : undefined;
  assert.equal(sets?.some((set) => set.kit?.kind === "lamp"), true, "and the lamp with it");
});

it("gives a plain set a material and a room its surfaces, kept with the set", async () => {
  const { q, sent } = await mount();
  await addBox(q);
  await choose(q('[aria-label="set 1 material"]'), "wood");
  await click([...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Add set")!);
  await click([...q('[data-testid="stage-kit-menu"]').querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Room"))!);
  assert.ok(q('[aria-label="room right wall"]'), "a room names its walls by side");
  await choose(q('[aria-label="room right wall"]'), "wood");
  await click(q(".fy-swstage__keep"));
  const kept = sent.at(-1);
  const sets = kept?.kind === "edit-stage" ? (kept.staging?.sets ?? kept.blocking?.sets) : undefined;
  assert.equal(sets?.find((set) => set.name === "set 1")?.material, "wood");
  assert.deepEqual(sets?.find((set) => set.name === "room")?.surfaces, { "right wall": "wood" });
});

// The camera in words (issue 1820, design turn 229a).
it("writes the camera in words, hides the numbers behind Edit as numbers, and drops the words on a hand edit", async () => {
  const { q, sent } = await mount((shot) => { shot.staging!.cast = [{ sheetId: "maren-kest", x: 0, z: 0 }]; });
  await click(stageItem(q, "camera"));
  assert.ok(q('[data-testid="stage-camera-words"]'), "words first");
  assert.ok(q('[aria-label="Camera height"]'), "a key with no words shows its numbers");
  await click([...q('[aria-label="Shot size"]').querySelectorAll<HTMLElement>('[role="radio"]')].find((option) => option.textContent === "MCU")!);
  assert.equal(q('[aria-label="Camera height"]'), null, "words put the numbers away");
  assert.equal(q('[aria-label="Shot size"] [aria-checked="true"]')?.textContent, "MCU");
  assert.match(q('[data-testid="stage-camera-words"]').textContent ?? "", /aim/);
  await click([...q('[data-testid="stage-camera-words"]').querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Edit as numbers")!);
  assert.ok(q('[aria-label="Camera height"]'));
  await click(q(".fy-swstage__keep"));
  const kept = sent.at(-1);
  const opening = kept?.kind === "edit-stage" ? kept.staging?.keys[0] : undefined;
  assert.equal(opening?.frame?.size, "medium close-up");
  assert.equal(opening?.frame?.subject, "maren-kest");
  assert.equal(opening?.track, "maren-kest");
  await click(stageItem(q, "camera"));
  await click(stageItem(q, "camera"));
  const height = q('[aria-label="Camera height"]') as HTMLInputElement;
  await leaveField(height, "2.4");
  await click(q(".fy-swstage__keep"));
  const edited = sent.at(-1);
  assert.equal(edited?.kind === "edit-stage" ? edited.staging?.keys[0]?.frame : "missing", undefined, "a hand edit makes the key numbers again");
});

// Poses, contacts and turns (issue 1821, design turn 229d).
it("poses a mark by name, puts a hand on someone, looks at them, and warns of a spin", async () => {
  const { q, sent } = await mount((shot) => {
    shot.staging!.cast = [{ sheetId: "maren-kest", x: 0, z: 0 }, { sheetId: "ivo-rell", x: 1, z: 0 }];
    shot.staging!.performances = [{ sheetId: "ivo-rell", keys: [{ t: 0, x: 1, z: 0, facing: 0 }, { t: 0.5, x: 1, z: 0, facing: 200 }] }];
  });
  const ivo = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__item")].find((item) => item.querySelector(".fy-swstage__warnstate"));
  assert.ok(ivo, "a spin between marks is said on the figure's line");
  assert.match(ivo.textContent ?? "", /turns too fast at 0\.0 s/);
  await click(ivo);
  const marks = [...q('[data-testid="workspace-stage"]').querySelectorAll<HTMLElement>(".fy-swstage__markrow")];
  await click(marks[1]!);
  const posture = q('[aria-label$="0.5s posture"]');
  assert.equal(posture.querySelectorAll("option").length, 14, "every named pose");
  await choose(posture, "lean-on");
  await click([...q('[aria-label$="0.5s hand"]').querySelectorAll<HTMLElement>('[role="radio"]')].find((option) => option.textContent === "Left")!);
  assert.ok(q('[aria-label$="0.5s hand on"]'), "a hand names what it is on");
  await choose(q('[aria-label$="0.5s looks at"]'), "maren-kest");
  await click(q(".fy-swstage__keep"));
  const kept = sent.at(-1);
  const mark = kept?.kind === "edit-stage" ? kept.staging?.performances?.[0]?.keys[1] : undefined;
  assert.equal(mark?.pose, "lean-on");
  assert.deepEqual(mark?.hand, { side: "left", on: "maren-kest", part: "left shoulder" });
  assert.equal(mark?.look, "maren-kest");
});

/** Shots 12 and 13 as Board A, each with its own camera, Maren crossing in the first (issue 1824). */
async function mountBoard(stageSecond = true) {
  const world = structuredClone(FIXTURE_STATE.world!);
  const production = world.productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(s => s.id === "sc_04")!;
  const [first, second] = ["sh_12", "sh_13"].map(id => orderedShots(scene).find(s => s.id === id)!);
  first!.durationSec = 4;
  second!.durationSec = 6;
  first!.staging = { version: 1, cast: [{ sheetId: "maren-kest", x: 0, z: 0 }], sets: [], keys: [0, 4].map(t => ({ t, p: [0, 1.5, 3], l: [0, 1, 0] })),
    performances: [{ sheetId: "maren-kest", keys: [{ t: 0, x: 0, z: 0 }, { t: 4, x: 2, z: 0 }] }] };
  // The second cut brings in Bray, who walks: a figure only a later cut has.
  if (stageSecond) second!.staging = { version: 1, cast: [{ sheetId: "maren-kest", x: 0, z: 0 }, { sheetId: "bray-half-hitch", x: 2, z: 0 }], sets: [], keys: [0, 6].map(t => ({ t, p: [1, 1.6, 2.5], l: [0, 1, 0] })),
    performances: [{ sheetId: "bray-half-hitch", keys: [{ t: 0, x: 2, z: 0 }, { t: 6, x: 3, z: 0 }] }] };
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  const rendered: string[][] = [];
  await act(async () => root!.render(
    <MemoryRouter><SelectionProvider value={{ subject: { kind: "shot", shotId: "sh_12" }, select: () => {} }}>
      <SceneStage scene={scene} production={production} world={world} aspect="16:9" sceneFile={undefined}
        locked={false} generatorPending={false} refusalVersion={0} onCommand={() => true} onRenderShot={() => {}}
        board={{ letter: "A", memberShotIds: ["sh_12", "sh_13"], capSec: 10 }} onRenderBoard={members => rendered.push(members)} />
    </SelectionProvider></MemoryRouter>,
  ));
  return { q: (selector: string) => container.querySelector<HTMLElement>(selector)!, container, rendered };
}
const scopeButton = (q: (selector: string) => HTMLElement, label: string) =>
  [...q('[data-testid="stage-scope"]').querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;

it("opens a board on one clock: the cut list, the line check, the shared action and the animatic (issue 1824, turn 229g)", async () => {
  const { q, container } = await mountBoard();
  assert.equal(q('[data-testid="stage-board"]'), null, "the Stage opens on This shot");
  await click(scopeButton(q, "Board A"));
  const form = q('[data-testid="stage-board"]');
  assert.match(form.textContent ?? "", /Board A/);
  assert.match(form.textContent ?? "", /10\.0 of 10 s/);
  const members = [...form.querySelectorAll(".fy-swstage__item")].map(item => item.textContent);
  assert.deepEqual(members, ["12 · Maren at the rail, listening4.0 s", "13 · The lamps answer6.0 s"]);
  assert.match(form.textContent ?? "", /180° · clear/);
  // Maren ends the first shot two metres from where the second starts her: a jump at the cut.
  assert.match(form.textContent ?? "", /jumps 2\.0 m at the cut to 13/);
  const perShot = [...form.querySelectorAll<HTMLButtonElement>('[aria-label="Board action"] button')].find(button => button.textContent === "Per shot")!;
  await click(perShot);
  assert.doesNotMatch(q('[data-testid="stage-board"]').textContent ?? "", /jumps/, "per-shot action is not held to continuity");
  // The track is the cut list on the board's clock, and the stage list reads rather than picks.
  const cuts = [...q('[data-testid="stage-cuts"]').querySelectorAll(".fy-swstage__cut")];
  assert.deepEqual(cuts.map(cut => cut.getAttribute("style")), ["left:0%;width:calc(40% - 3px)", "left:40%;width:calc(60% - 3px)"]);
  assert.match(q(".fy-swstage__time").textContent ?? "", /\/ 10\.0s/);
  const lanes = [...container.querySelectorAll(".fy-swstage__lane-label")].map((label) => label.textContent);
  assert.ok(lanes.some((name) => /bray/i.test(name ?? "")), `every member's cast has its lane, not only the opening shot's: ${JSON.stringify(lanes)}`);
  assert.equal(stageItem(q, "camera").textContent, "camera2 cameras");
  assert.equal((stageItem(q, "camera") as HTMLButtonElement).disabled, true);
  assert.match(container.textContent ?? "", /animatic/);
  assert.match(container.textContent ?? "", /not filed/);
  const render = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Render with this")!;
  assert.equal(render.disabled, true, "a board renders with its animatic once one is filed");
  await click(scopeButton(q, "This shot"));
  assert.equal(q('[data-testid="stage-board"]'), null);
});

it("keeps the board shut until every member is staged (issue 1824)", async () => {
  const { q } = await mountBoard(false);
  const board = scopeButton(q, "Board A");
  assert.equal(board.disabled, true);
  assert.equal(board.getAttribute("title"), "Stage every shot of the board first");
});
