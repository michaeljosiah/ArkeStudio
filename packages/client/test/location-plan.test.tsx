import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { placePositionCamera, type ClientMessage, type ClientState, type PlacePositionPicture } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { shortDate } from "../src/lib/format.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { PLAN_SETS, planScene, planState } from "./scene-plan-fixture.js";

/**
 * The Plan on a location's sheet (design turn 285, frame 285d): a third tab, the place's set with
 * no scene's cast on it, and each position as one of Reference's cards. The page has no scene, so
 * a change made here never names one.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const PLACE = `/w/${FIXTURE_WORLD_ID}/locations/the-vigil`;
let root: Root | null = null;
let sent: ClientMessage[] = [];
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

async function mount(state: ClientState, path = `${PLACE}/plan`): Promise<void> {
  sent = [];
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw) as ClientMessage); } } as unknown as ArkeBridge);
    __setStateForTest(state);
    root!.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  });
}

const q = (selector: string): HTMLElement | null => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const all = (selector: string): HTMLElement[] => [...dom.document.querySelectorAll(selector)] as unknown as HTMLElement[];
const click = async (element: HTMLElement | null | undefined): Promise<void> => {
  assert.ok(element, "the control is on the page");
  await act(async () => element.click());
};
const button = (text: string): HTMLElement | undefined => all("button").find((candidate) => candidate.textContent === text);
const tabs = (): Array<[string | null, boolean]> => [...q(".fy-location-tabs")!.children].map((tab) => [tab.textContent, tab.classList.contains("fy-seg__item--active")]);

function picture(over: Partial<PlacePositionPicture> = {}): PlacePositionPicture {
  return {
    aspect: "16:9",
    file: "takes/tk_01J8F0000000000000000000P1/view.png",
    sourceTakeId: "tk_01J8F0000000000000000000P1" as PlacePositionPicture["sourceTakeId"],
    acceptedAt: "2026-11-18T10:00:00Z",
    setVersion: 3,
    camera: { p: [0, 1.5, 4], l: [0, 1, 0], focalMm: 35 },
    ...over,
  };
}

describe("a location's Plan tab (285d)", () => {
  it("is the third tab on each of the place's pages", async () => {
    await mount(planState(), PLACE);
    assert.deepEqual(tabs(), [["Overview", true], ["Reference", false], ["Plan", false]]);
    await click(button("Plan"));
    assert.ok(q('[data-screen="location-plan"]'));
    assert.deepEqual(tabs(), [["Overview", false], ["Reference", false], ["Plan", true]]);
    await click(button("Reference"));
    assert.ok(q('[data-screen="location-reference"]'));
    assert.deepEqual(tabs(), [["Overview", false], ["Reference", true], ["Plan", false]]);
    assert.equal(q(".fy-character-head p")?.textContent, "locked · location reference set", "Reference keeps its own line");
  });

  it("reads its status, the set's version and the count of positions under the name", async () => {
    const state = planState();
    await mount(state);
    assert.equal(q(".fy-character-head h1")?.textContent, "The Vigil");
    assert.equal(q(".fy-character-head p")?.textContent, "locked · set v3 · 2 positions");

    const one = planState();
    one.world!.placePlans[0]!.positions.pop();
    await act(async () => __setStateForTest(one));
    assert.equal(q(".fy-character-head p")?.textContent, "locked · set v3 · 1 position");
  });

  it("draws the set with no scene's cast, and each position as one of Reference's cards", async () => {
    await mount(planState());
    assert.deepEqual([...q(".fy-locref__sechead")!.children].map((part) => part.textContent), ["Positions", "2"], "none drawn yet, so only the count");
    const plan = q(".pl-place__grid > .pl-plan__picture")!;
    assert.deepEqual([...plan.querySelectorAll(".pl-place__tag")].map((tag) => tag.textContent), ["chart table"], "the set's pieces as small tags, the room never");
    assert.equal(plan.querySelector(".fy-swstage__label"), null, "no cast on a place's own plan");
    assert.deepEqual([...plan.querySelectorAll(".pl-plan__n")].map((body) => body.textContent), ["1", "2"]);
    assert.equal(plan.querySelector(".pl-plan__scale")?.textContent, "2 m");
    assert.equal(plan.querySelector('[data-movable="true"]'), null, "a position is moved on a scene's Plan");
    const cards = all(".pl-place__grid > article.fy-locref__view");
    assert.deepEqual(cards.map((card) => [card.querySelector(".fy-locref__panel")?.textContent, card.querySelector("h3")?.textContent, card.querySelector(".fy-locref__viewfoot p")?.textContent]), [
      ["1", "South", "35 mm · no picture"],
      ["2", "North", "35 mm · no picture"],
    ]);
    const page = q('[data-screen="location-plan"]')!.textContent ?? "";
    for (const later of ["Export plan", "Draw picture"]) assert.ok(!page.includes(later), `${later} is a later slice's`);
  });

  it("shows a position's picture with its date, and says when the camera has moved since", async () => {
    const state = planState();
    const [south, north] = state.world!.placePlans[0]!.positions;
    south!.pictures = [picture()];
    // Drawn from where the camera no longer stands: kept, and marked.
    north!.pictures = [picture({ file: "takes/tk_01J8F0000000000000000000P2/view.png", camera: { p: [2, 1.5, -4], l: [0, 1, 0], focalMm: 35 } })];
    await mount(state);
    assert.equal(q(".fy-locref__sechead .fy-mono")?.textContent, "2 · 2 drawn");
    const cards = all(".pl-place__grid > article.fy-locref__view");
    const date = shortDate("2026-11-18T10:00:00Z");
    assert.deepEqual(cards.map((card) => card.querySelector(".fy-locref__viewfoot p")?.textContent), [`35 mm · picture ${date}`, `35 mm · picture ${date} · stale`]);
    assert.ok(cards[0]!.querySelector("img")?.getAttribute("src")?.includes("references/the-vigil/takes/tk_01J8F0000000000000000000P1/view.png"), "the picture's own file, under the place's references");
    assert.equal(cards[0]!.querySelector(".fy-locref__zoom")?.getAttribute("aria-label"), "View larger: South");

    const portrait = planState();
    portrait.world!.placePlans[0]!.positions[0]!.pictures = [picture({ aspect: "9:16" })];
    await act(async () => __setStateForTest(portrait));
    assert.equal(q(".fy-locref__sechead .fy-mono")?.textContent, "2", "a picture at another shape is not this page's");
  });

  it("adds a position that names no scene, framed on the set's first piece", async () => {
    await mount(planState());
    await click(button("Add position"));
    const words = { subject: { kind: "set" as const, name: "chart table" }, size: "medium" as const, angle: "eye" as const, side: "front" as const };
    const camera = placePositionCamera(words, 35, { cast: [], sets: PLAN_SETS }, "16:9")!;
    assert.deepEqual(sent.filter((message) => message.kind === "place-plan"), [{
      kind: "place-plan", worldId: FIXTURE_WORLD_ID, sheetId: "the-vigil",
      change: { op: "add-position", p: camera.p, l: camera.l, focalMm: 35, words },
    }]);
  });

  it("stands a new position by the room when the set has nothing to frame", async () => {
    const state = planState();
    state.world!.placePlans[0]!.sets = [PLAN_SETS[0]!];
    await mount(state);
    await click(button("Add position"));
    assert.deepEqual(sent.filter((message) => message.kind === "place-plan").map((message) => "change" in message ? message.change : null), [
      { op: "add-position", p: [0, 1.5, 2], l: [0, 1, 0], focalMm: 35 },
    ], "two metres south of the centre at standing height, looking at it");
  });
});

describe("a place with no plan", () => {
  it("offers the Stage of a scene set there, and nothing else", async () => {
    await mount(planState({ plan: false }));
    assert.equal(q(".fy-character-head p")?.textContent, "locked", "the status alone");
    assert.equal(q('[data-screen="location-plan"] main')?.textContent, "Open the Stage");
    assert.equal(button("Add position"), undefined, "there is no set to stand a camera in from here");
    await click(button("Open the Stage"));
    assert.ok(q('[data-testid="shot-page"]'), "the scene's first shot");
    assert.equal(q('.fy-sw__tab[data-on="true"]')?.textContent, "Stage");
  });

  it("holds only its head when no scene is set there", async () => {
    const state = planState({ plan: false });
    delete planScene(state).inherits;
    await mount(state);
    assert.ok(q('[data-screen="location-plan"] .fy-character-head'));
    assert.equal(q('[data-screen="location-plan"] main'), null);
    assert.equal(button("Open the Stage"), undefined);
  });
});
