import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { PLACE_POSITION_NAME_MAX, orderedShots, placePositionCamera, placePositionNameLength, planBounds, planFrame, planSides, planSpot, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { PLAN_SETS, SOUTH_WORDS, planScene, planState, vigilPlan } from "./scene-plan-fixture.js";

/**
 * The Plan on a scene (design turn 285, issue 2302).
 *
 * What is asserted is what the turn's rules bind: the tab is the place's, the inspector counts
 * what contracts count, a crossing is one fact said in three places, and every change is one
 * `place-plan` command that names the scene it was made in. The picture itself needs WebGL, which
 * this DOM has none of, so the canvas stays empty and what is written over it is what is read.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
let width = 1360;
Object.assign(dom.window, {
  getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768,
  matchMedia: (query: string) => ({
    matches: query.split(",").some((part) => {
      const widths = [...part.matchAll(/\((min|max)-width: (\d+)px\)/g)];
      return widths.length > 0 && widths.every(([, kind, value]) => (kind === "min" ? width >= Number(value) : width <= Number(value)));
    }),
    addEventListener() {}, removeEventListener() {},
  }),
});
Object.assign(dom.HTMLElement.prototype, {
  getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44 }),
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
  scrollIntoView() {},
});
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const SCENE_PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;
const FROM = { productionId: "saltlight", sceneFile: "04-the-verse-rises", sceneId: "sc_04" };
type PlanCommand = Extract<ClientMessage, { kind: "place-plan" }>;

let root: Root | null = null;
let sent: ClientMessage[] = [];
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  width = 1360;
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

async function mount(state: ClientState, size = 1360): Promise<void> {
  width = size;
  sent = [];
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw) as ClientMessage); } } as unknown as ArkeBridge);
    __setStateForTest(state);
    root!.render(<MemoryRouter initialEntries={[SCENE_PATH]}><App /></MemoryRouter>);
  });
}

const q = (selector: string): HTMLElement | null => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const all = (selector: string): HTMLElement[] => [...dom.document.querySelectorAll(selector)] as unknown as HTMLElement[];
const texts = (selector: string): string[] => all(selector).map((element) => element.textContent ?? "");
/** A line's own cells: its direct spans, not the spans inside them. */
const spans = (element: Element): Array<string | null> => [...element.children].filter((child) => child.tagName === "SPAN").map((child) => child.textContent);
const click = async (element: HTMLElement | null | undefined): Promise<void> => {
  assert.ok(element, "the control is on the page");
  await act(async () => element.click());
};
const tabs = (): string[] => texts(".fy-sw__tab");
const openPlan = async (): Promise<void> => click(all(".fy-sw__tab").find((tab) => tab.textContent === "Plan"));
const planCommands = (): PlanCommand[] => sent.filter((message): message is PlanCommand => message.kind === "place-plan");
/** A position's line in the inspector, by its name. */
const line = (name: string): HTMLElement | undefined => all('[aria-label="Plan inspector"] button.fy-swstage__item').find((item) => item.querySelector("span:nth-child(2)")?.textContent === name);
/** linkedom fires no input events React hears, so a control's own handler is called as a keystroke would call it. */
const props = (element: HTMLElement) => {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void; onBlur: () => void }>)[key]!;
};
const type = async (element: HTMLElement, value: string): Promise<void> => { await act(async () => props(element).onChange({ target: { value } })); };
const leave = async (element: HTMLElement): Promise<void> => { await act(async () => props(element).onBlur()); };
const nameBox = (): HTMLInputElement => q('[aria-label="Position name"]') as unknown as HTMLInputElement;
const snapshot = async (state: ClientState): Promise<void> => { await act(async () => __setStateForTest(state)); };

describe("the Plan is the place's (design turn 285)", () => {
  it("is a view after Flow and before Preview, offered only to a scene with a place", async () => {
    await mount(planState());
    assert.deepEqual(tabs(), ["Storyboard", "Flow", "Plan", "Preview"]);
    assert.equal(q('[data-testid="workspace-plan"]'), null, "Storyboard is still the view the page opens on");

    const placeless = planState();
    delete planScene(placeless).inherits;
    await snapshot(placeless);
    assert.deepEqual(tabs(), ["Storyboard", "Flow", "Preview"], "a scene with no place has no Plan");
  });

  it("goes back to the storyboard when the place is taken away under it", async () => {
    await mount(planState());
    await openPlan();
    assert.ok(q('[data-testid="workspace-plan"]'));
    const placeless = planState();
    delete planScene(placeless).inherits;
    await snapshot(placeless);
    assert.equal(q('[data-testid="workspace-plan"]'), null);
    assert.ok(q('[data-testid="workspace-rows"]'), "the page is on a view that still has a tab");
  });

  it("adds nothing to the toolbar that a later slice owns", async () => {
    await mount(planState());
    await openPlan();
    const page = q('[data-testid="scene-workspace"]')!.textContent ?? "";
    for (const later of ["Export plan", "Draw picture", "Redraw picture", "Start from"]) assert.ok(!page.includes(later), `${later} is not this slice's`);
    assert.equal(q(".fy-sw__full"), null, "Full screen stays Flow's");
  });
});

describe("the Plan's inspector is the Stage's", () => {
  it("counts the positions, then the placed shots against the scene's, and each line's own", async () => {
    await mount(planState());
    await openPlan();
    const inspector = q('[aria-label="Plan inspector"]')!;
    assert.ok(inspector.classList.contains("fy-swstage__panel"), "the Stage inspector's own panel");
    assert.deepEqual([...inspector.querySelectorAll(".fy-swstage__eyebrow")].map((eyebrow) => [...eyebrow.querySelectorAll("span")].map((span) => span.textContent)), [
      ["Positions", "2 · 2 of 2 shots"],
      ["Sides", "left · right"],
    ]);
    assert.deepEqual([...inspector.querySelectorAll("button.fy-swstage__item")].map((item) => spans(item)), [
      ["1", "South", "2 shots"],
      ["2", "North", "0 shots"],
    ]);
    assert.equal(inspector.querySelector(".fy-swstage__add")?.textContent, "Add position");
  });

  it("counts a shot with no position in the scene's total and nowhere else", async () => {
    const state = planState();
    delete orderedShots(planScene(state))[1]!.staging!.position;
    await mount(state);
    await openPlan();
    assert.equal(q('[aria-label="Plan inspector"] .fy-swstage__eyebrow')?.textContent, "Positions2 · 1 of 2 shots");
    assert.equal(line("South")?.textContent, "1South1 shot", "one is one shot, not one shots");
  });

  it("writes on the plan what the Stage writes, once for each name", async () => {
    const state = planState();
    planScene(state).blocking!.sets.push({ name: "chart table", x: 2, z: -2, w: 1.2, h: 0.75, d: 0.8 });
    state.world!.placePlans[0]!.sets = structuredClone(planScene(state).blocking!.sets);
    await mount(state);
    await openPlan();
    const picture = q(".pl-plan__picture")!;
    assert.deepEqual([...picture.querySelectorAll(".fy-swstage__label")].map((label) => [label.textContent, label.getAttribute("data-cast")]), [
      ["Maren", "true"],
      ["Iona", "true"],
      ["chart table", null],
    ], "each person beside their mark, two tables labelled once, the room never");
    assert.deepEqual([...picture.querySelectorAll(".pl-plan__n")].map((body) => [body.textContent, body.getAttribute("aria-label")]), [["1", "South"], ["2", "North"]]);
    assert.equal(picture.querySelector(".pl-plan__scale")?.textContent, "2 m");
    assert.equal(picture.querySelector("canvas")?.getAttribute("aria-hidden"), "true", "the canvas is the picture; what is written over it is what is read");
  });

  it("writes a piece's name clear of the camera that stands over it", async () => {
    // From straight above, a table's name and the position that looks down at it share a spot.
    const state = planState();
    state.world!.placePlans[0]!.positions.push({ n: 3, name: "Table-top", p: [0, 2.3, -2], l: [0, 0.75, -2], focalMm: 24 });
    state.world!.placePlans[0]!.next = 4;
    await mount(state);
    await openPlan();
    const spot = (element: HTMLElement | undefined): [number, number] => {
      const style = element?.getAttribute("style") ?? "";
      return [Number(/left:\s*([\d.]+)px/.exec(style)?.[1]), Number(/top:\s*([\d.]+)px/.exec(style)?.[1])];
    };
    const body = spot(all(".pl-plan__n").find((candidate) => candidate.textContent === "3"));
    const name = spot(all(".pl-plan__picture .fy-swstage__label").find((label) => label.textContent === "chart table"));
    assert.equal(name[0], body[0], "still over its piece");
    assert.ok(name[1] < body[1] - 20, `off the table's north edge, not under the body: ${name[1]} against ${body[1]}`);
  });
});

describe("sides", () => {
  it("writes a pair in picture order with its shots, and clear when every camera keeps the side", async () => {
    const state = planState({ second: "south" });
    const [side] = planSides(planScene(state), "16:9");
    assert.deepEqual([side!.left, side!.right, side!.shotIds, side!.crossings], ["maren-kest", "iona-vale", ["sh_12", "sh_13"], []], "what contracts say of the fixture");
    await mount(state);
    await openPlan();
    const row = q('[data-testid="plan-side"]')!;
    assert.deepEqual(spans(row).slice(1), ["Maren · Iona", "2 shots · clear"]);
    assert.equal(row.querySelector(".pl-plan__ok")?.textContent, "clear");
    assert.equal(row.querySelectorAll(".pl-plan__pair > i").length, 2, "the pair's two colours");
    assert.equal(q(".pl-plan__find"), null, "nothing crosses, so nothing is said on the plan");
    assert.equal(all('[data-warn="true"]').length, 0);
  });

  it("flags a crossing in three places and refuses nothing", async () => {
    const state = planState({ second: "north" });
    assert.deepEqual(planSides(planScene(state), "16:9")[0]!.crossings, ["sh_13"], "shot 13 stands north of the line the earlier shot keeps");
    await mount(state);
    await openPlan();
    assert.equal(q(".pl-plan__find")?.textContent, "Shot 13 crosses Maren · Iona", "one clause on the plan names it");
    assert.equal(q('[data-testid="plan-side"] .pl-plan__warn')?.textContent, "1 crossing", "the pair's count");
    assert.equal(q('[data-testid="plan-side"]')?.textContent, "Maren · Iona2 shots · 1 crossing");
    assert.equal(line("North")?.getAttribute("data-warn"), "true", "the position's line in the list");
    assert.equal(line("South")?.getAttribute("data-warn"), null);
    assert.deepEqual(all(".pl-plan__n").map((body) => body.getAttribute("data-warn")), [null, "true"], "and its body on the plan");
    assert.equal(planCommands().length, 0, "a director may cross on purpose: nothing is corrected");
  });
});

describe("a position", () => {
  it("is added in one change that names the scene, with its default words solved", async () => {
    const state = planState();
    await mount(state);
    await openPlan();
    await click(q(".fy-swstage__add"));
    const camera = placePositionCamera(SOUTH_WORDS, 35, { cast: planScene(state).blocking!.cast, sets: PLAN_SETS }, "16:9")!;
    assert.deepEqual(planCommands(), [{
      kind: "place-plan", worldId: FIXTURE_WORLD_ID, sheetId: "the-vigil", from: FROM,
      change: { op: "add-position", p: camera.p, l: camera.l, focalMm: 35, words: SOUTH_WORDS },
    }]);

    // The place numbers it; the screen selects the number it was told would be next.
    const after = planState();
    after.world!.placePlans[0]!.positions.push({ n: 3, name: "Position 3", p: camera.p, l: camera.l, focalMm: 35, words: SOUTH_WORDS });
    after.world!.placePlans[0]!.next = 4;
    await snapshot(after);
    assert.equal(q('.fy-swstage__item[data-selected="true"]')?.textContent, "3Position 30 shots");
    assert.equal(q('[data-testid="plan-position"] .fy-swstage__eyebrow')?.textContent, "Position3 of 3");
  });

  it("makes the scene's set the place's when the place has no plan yet", async () => {
    await mount(planState({ plan: false }));
    await openPlan();
    assert.equal(q('[aria-label="Plan inspector"] .fy-swstage__eyebrow')?.textContent, "Positions0 · 0 of 2 shots");
    assert.ok(texts(".pl-plan__picture .fy-swstage__label").includes("chart table"), "the scene's own set is what is drawn");
    await click(q(".fy-swstage__add"));
    assert.deepEqual(planCommands().map((command) => [command.from, command.change.op]), [[FROM, "add-position"]]);
  });

  it("folds the list to its line and shows its form in the Stage's rows", async () => {
    await mount(planState());
    await openPlan();
    await click(line("South"));
    assert.deepEqual(texts('[aria-label="Plan inspector"] button.fy-swstage__item'), ["1South2 shots"], "the list folds to the one line");
    assert.equal(q(".fy-swstage__add"), null);
    assert.equal(q('[data-testid="plan-side"]'), null);
    const form = q('[data-testid="plan-position"]')!;
    assert.equal(form.querySelector(".fy-swstage__eyebrow")?.textContent, "Position1 of 2");
    assert.deepEqual([...form.querySelectorAll(".fy-swstage__rowlabel")].map((label) => label.textContent), ["name", "subject", "size", "angle", "side", "lens", ""]);
    assert.equal(nameBox().value, "South");
    assert.equal(nameBox().getAttribute("maxlength"), null, "the DOM counts code units; contracts count letters");
    assert.deepEqual([...form.querySelectorAll('[aria-label="Position subject"] option')].map((option) => option.textContent), ["Maren", "Iona", "watch room", "chart table"]);
    assert.equal(form.querySelector('[aria-label="Shot size"] [data-on="true"]')?.textContent, "Med");
    assert.deepEqual([...form.querySelectorAll('[aria-label="Camera side"] option')].map((option) => option.textContent), ["Front", "Behind", "Left", "Right", "Over the shoulder"]);
    assert.equal(form.querySelector('[aria-label="lens"]')?.getAttribute("value"), "35");
    assert.equal(all(".pl-plan__n").find((body) => body.textContent === "1")?.getAttribute("data-selected"), "true", "the picture and the list hold one selection");

    await click(line("South"));
    assert.equal(texts('[aria-label="Plan inspector"] button.fy-swstage__item').length, 2, "selecting nothing brings the list back");
  });

  it("is selected from its body, and the floor selects nothing", async () => {
    await mount(planState());
    await openPlan();
    await click(all(".pl-plan__n").find((body) => body.textContent === "2"));
    assert.equal(q('[data-testid="plan-position"] .fy-swstage__eyebrow')?.textContent, "Position2 of 2");
    await click(q(".pl-plan__picture"));
    assert.equal(q('[data-testid="plan-position"]'), null);
  });

  it("is moved on the floor by dragging its selected body: one change on release, and the words dropped", async () => {
    const state = planState();
    await mount(state);
    await openPlan();
    const body = () => all(".pl-plan__n").find((candidate) => candidate.textContent === "1")!;
    const pointer = async (type: string, clientX: number, clientY: number) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, button: 0, clientX, clientY });
      await act(async () => body().dispatchEvent(event));
    };
    await pointer("pointerdown", 300, 300);
    await pointer("pointermove", 340, 320);
    await pointer("pointerup", 340, 320);
    assert.equal(planCommands().length, 0, "a body that is not selected is pressed, not moved");

    await click(body());
    await pointer("pointerdown", 300, 300);
    await pointer("pointermove", 301, 301);
    await pointer("pointerup", 301, 301);
    assert.equal(planCommands().length, 0, "a press that barely moves is a press");

    await pointer("pointerdown", 300, 300);
    await pointer("pointermove", 360, 130);
    assert.equal(planCommands().length, 0, "nothing is written while the body is in the hand");
    await pointer("pointerup", 360, 130);
    // The picture is 667 by 440 where nothing measures it, fitted to the room, the marks and the
    // positions; the drop is inside the room, so the view it was dropped in is the view it stays in.
    const plan = state.world!.placePlans[0]!;
    const frame = planFrame(planBounds(PLAN_SETS, [...planScene(state).blocking!.cast.map((figure) => [figure.x, figure.z] as const), ...plan.positions.map((position) => [position.p[0], position.p[2]] as const)]), 667, 440, 0.3);
    const metres = (value: number) => Math.round(value * 100) / 100;
    const dropped = [metres(frame.x0 + 360 / frame.scale), metres(frame.z0 + 130 / frame.scale)] as const;
    assert.deepEqual(planCommands(), [{
      kind: "place-plan", worldId: FIXTURE_WORLD_ID, sheetId: "the-vigil", from: FROM,
      change: { op: "edit-position", n: 1, p: [dropped[0], 1.5, dropped[1]], words: null },
    }], "its height is kept, its aim is left where it was, and words that no longer say where it stands go");
    const [left, top] = planSpot(frame, dropped[0], dropped[1]);
    assert.match(body().getAttribute("style") ?? "", new RegExp(`left:\\s*${left.toFixed(1)}px;\\s*top:\\s*${top.toFixed(1)}px`), "held where it was dropped until the snapshot says the same");

    await act(async () => __applyEventForTest({ at: "2026-11-20T10:00:00Z", type: "command.failed", command: "place-plan", requestId: null, reason: "The world is no longer open." }));
    const [backLeft, backTop] = planSpot(frame, plan.positions[0]!.p[0], plan.positions[0]!.p[2]);
    assert.match(body().getAttribute("style") ?? "", new RegExp(`left:\\s*${backLeft.toFixed(1)}px;\\s*top:\\s*${backTop.toFixed(1)}px`), "a refused move goes back to where the place keeps it");
  });

  it("is renamed on leaving the box, counted in letters, and keeps the name the place keeps otherwise", async () => {
    await mount(planState());
    await openPlan();
    await click(line("South"));

    await type(nameBox(), "  The wide ");
    await leave(nameBox());
    assert.deepEqual(planCommands().map((command) => command.change), [{ op: "edit-position", n: 1, name: "The wide" }]);
    assert.deepEqual(planCommands()[0]!.from, FROM);

    // A Yoruba letter with a dot below and a tone mark is one letter and three code points.
    const marked = "ọ́".repeat(PLACE_POSITION_NAME_MAX);
    assert.equal(marked.length, 48);
    assert.equal(placePositionNameLength(marked), PLACE_POSITION_NAME_MAX);
    await type(nameBox(), marked);
    assert.equal(nameBox().value, marked, "24 letters are 24, however many code units");
    await type(nameBox(), `${marked}a`);
    assert.equal(nameBox().value, marked, "a keystroke past 24 letters is refused");
    await leave(nameBox());
    assert.deepEqual(planCommands()[1]?.change, { op: "edit-position", n: 1, name: marked });

    sent = [];
    for (const kept of ["   ", "South", "north"]) {
      await type(nameBox(), kept);
      await leave(nameBox());
      assert.equal(nameBox().value, "South", `${JSON.stringify(kept)}: the stored name comes back`);
    }
    assert.equal(planCommands().length, 0, "empty, unchanged, or another position's name: nothing is sent");
  });

  it("puts the stored name back when the place refuses the change", async () => {
    await mount(planState());
    await openPlan();
    await click(line("South"));
    await type(nameBox(), "The wide");
    await leave(nameBox());
    assert.equal(nameBox().value, "The wide", "held while the answer is on its way");
    await act(async () => __applyEventForTest({ at: "2026-11-20T10:00:00Z", type: "command.failed", command: "place-plan", requestId: null, reason: "The world is no longer open." }));
    assert.equal(nameBox().value, "South");
  });

  it("writes every word in one change with where they put the camera", async () => {
    const state = planState();
    const stage = { cast: planScene(state).blocking!.cast, sets: PLAN_SETS };
    await mount(state);
    await openPlan();
    await click(line("South"));

    await click(all('[aria-label="Shot size"] button').find((chip) => chip.textContent === "CU"));
    const close = { ...SOUTH_WORDS, size: "close-up" as const };
    assert.deepEqual(planCommands().map((command) => command.change), [{ op: "edit-position", n: 1, words: close, ...placePositionCamera(close, 35, stage, "16:9")! }]);

    await act(async () => props(q('[aria-label="Position subject"]')!).onChange({ target: { value: "set:chart table" } }));
    const table = { ...SOUTH_WORDS, subject: { kind: "set" as const, name: "chart table" } };
    assert.deepEqual(planCommands()[1]?.change, { op: "edit-position", n: 1, words: table, ...placePositionCamera(table, 35, stage, "16:9")! });

    await act(async () => props(q('[aria-label="Camera side"]')!).onChange({ target: { value: "over" } }));
    const over = { ...SOUTH_WORDS, side: "over" as const, over: "iona-vale" };
    assert.deepEqual(planCommands()[2]?.change, { op: "edit-position", n: 1, words: over, ...placePositionCamera(over, 35, stage, "16:9")! }, "over the other person's shoulder");

    await click(q('[aria-label="lens up"]'));
    assert.deepEqual(planCommands()[3]?.change, { op: "edit-position", n: 1, words: SOUTH_WORDS, ...placePositionCamera(SOUTH_WORDS, 36, stage, "16:9")!, focalMm: 36 }, "a lens is one of the words: they are solved again through it");
    assert.ok(planCommands().every((command) => JSON.stringify(command.from) === JSON.stringify(FROM)));
  });

  it("gives a position with no words the words chosen for it, and a lens alone its lens", async () => {
    const state = planState();
    const stage = { cast: planScene(state).blocking!.cast, sets: PLAN_SETS };
    await mount(state);
    await openPlan();
    await click(line("North"));
    const form = q('[data-testid="plan-position"]')!;
    assert.equal(form.querySelector('[aria-label="Shot size"] [data-on="true"]'), null, "a hand-placed camera says no size");
    assert.equal(form.querySelector('[aria-label="Position subject"] option')?.textContent, "—");

    await click(q('[aria-label="lens down"]'));
    assert.deepEqual(planCommands().map((command) => command.change), [{ op: "edit-position", n: 2, focalMm: 34 }], "no words to solve, so the camera stays where it was put");

    await click(all('[aria-label="Camera angle"] button').find((chip) => chip.textContent === "High"));
    const high = { ...SOUTH_WORDS, angle: "high" as const };
    assert.deepEqual(planCommands()[1]?.change, { op: "edit-position", n: 2, words: high, ...placePositionCamera(high, 35, stage, "16:9")! });
  });

  it("is removed by its own quiet link", async () => {
    await mount(planState());
    await openPlan();
    await click(line("North"));
    await click(all(".fy-swstage__link").find((link) => link.textContent === "Remove position"));
    assert.deepEqual(planCommands(), [{ kind: "place-plan", worldId: FIXTURE_WORLD_ID, sheetId: "the-vigil", from: FROM, change: { op: "remove-position", n: 2 } }]);
    assert.equal(q('[data-testid="plan-position"]'), null, "nothing stays selected");
  });

  it("stops adding at the 24 a place holds", async () => {
    const state = planState();
    const plan = state.world!.placePlans[0]!;
    plan.positions = Array.from({ length: 24 }, (_, index) => ({ ...vigilPlan().positions[1]!, n: index + 1, name: `Camera ${index + 1}` }));
    plan.next = 25;
    await mount(state);
    await openPlan();
    assert.ok(q(".fy-swstage__add")?.hasAttribute("disabled"));
  });
});

describe("a place with nothing to draw", () => {
  it("holds one press, which opens the scene's first shot on the Stage", async () => {
    await mount(planState({ plan: false, staged: false }));
    await openPlan();
    const view = q('[data-testid="workspace-plan"]')!;
    assert.equal(view.textContent, "Open the Stage", "one press and no sentence beside it");
    assert.equal(q('[aria-label="Plan inspector"]'), null);
    await click(view.querySelector("button") as unknown as HTMLElement);
    assert.ok(q('[data-testid="shot-page"]'), "the shot's page");
    assert.equal(q('.fy-sw__tab[data-on="true"]')?.textContent, "Stage", "on its Stage");
  });

  it("cannot be pressed in a scene with no shots", async () => {
    const state = planState({ plan: false, staged: false });
    (planScene(state) as unknown as { shots: unknown[] }).shots = [];
    await mount(state);
    await openPlan();
    assert.ok(q('[data-testid="workspace-plan"] button')?.hasAttribute("disabled"));
  });
});

describe("the Plan on a phone (285f)", () => {
  it("is a view between Storyboard and Preview: numbers only, then one list", async () => {
    await mount(planState({ second: "north" }), 390);
    assert.deepEqual(tabs(), ["Storyboard", "Plan", "Preview"]);
    await openPlan();
    const view = q('[data-testid="workspace-plan"]')!;
    assert.deepEqual([...view.querySelectorAll(".pl-plan__head")].map((head) => [...head.querySelectorAll("span")].map((span) => span.textContent)), [
      ["Positions", "2 · 2 of 2 shots"],
      ["Sides", "left · right"],
    ]);
    assert.deepEqual([...view.querySelectorAll(".pl-plan__row")].map((row) => row.textContent), ["1South1 shot", "2North1 shot", "Maren · Iona2 shots · 1 crossing"]);
    assert.equal(view.querySelector('button.pl-plan__row[data-warn="true"]')?.textContent, "2North1 shot");
    const picture = view.querySelector(".pl-plan__picture")!;
    assert.deepEqual([...picture.querySelectorAll(".pl-plan__n")].map((body) => body.textContent), ["1", "2"]);
    assert.equal(picture.querySelector(".fy-swstage__label, .pl-plan__scale, .pl-plan__find"), null, "no set labels, no names, no scale");
    assert.equal(q(".fy-swstage__add"), null, "adding a position is the desk's");
    assert.equal(picture.querySelector('[data-movable="true"]'), null, "and so is moving one");
  });

  it("opens a position's form as a sheet from its row", async () => {
    await mount(planState(), 390);
    await openPlan();
    assert.equal(q('[data-testid="plan-position"]'), null);
    await click(all("button.pl-plan__row").find((row) => row.textContent?.includes("South")));
    const sheet = q(".fy-page-sheet.fy-stage-inspector-sheet[open]")!;
    assert.ok(sheet, "the Stage inspector's own sheet");
    assert.equal(sheet.querySelector("h2")?.textContent, "South");
    assert.equal(sheet.querySelector('[data-testid="plan-position"] .fy-swstage__eyebrow')?.textContent, "Position1 of 2");
    await click(all('[aria-label="Shot size"] button').find((chip) => chip.textContent === "Wide"));
    assert.deepEqual(planCommands().map((command) => [command.from, command.change.op, "words" in command.change ? command.change.words?.size : null]), [[FROM, "edit-position", "wide"]]);
  });
});
