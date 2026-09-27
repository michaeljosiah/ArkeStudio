import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientMessage, ClientState, RoutingCommand, Routing, Scene } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { BranchMapScreen } from "../src/screens/branch-map.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The branch map as a canvas (design turn 157), pressed: each gesture sends one closed routing
 * command, the findings count opens the findings in the words the map uses, and a removal names
 * what it breaks before anything is sent.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { focus() {}, setPointerCapture() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.window.KeyboardEvent ?? dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

function scene(id: string, number: number, title: string): Scene {
  return { id, number, slug: id.replace(/^sc_/, ""), title, status: "draft", version: 1, shots: [] };
}

const SCENES = [
  scene("sc_quarter", 1, "The drowned quarter"),
  scene("sc_causeway", 2, "The causeway"),
  scene("sc_towers", 3, "The bell towers"),
  scene("sc_vigil", 4, "The Vigil"),
  scene("sc_pier", 5, "The pier at dusk"),
  scene("sc_undertow", 6, "The undertow"),
];

const ROUTING: Routing = {
  version: 12,
  start: "sc_quarter",
  choices: [
    { id: "ch_follow", from: "sc_quarter", label: "Follow the lantern", to: "sc_causeway" },
    { id: "ch_stay", from: "sc_quarter", label: "Stay with the boat", to: "sc_towers" },
    { id: "ch_cross", from: "sc_causeway", label: "Cross before the tide", to: "sc_towers" },
    { id: "ch_wait", from: "sc_causeway", label: "Wait for low water", to: "sc_vigil" },
    { id: "ch_sleep", from: "sc_towers", label: "Let it sleep", to: "sc_pier" },
    { id: "ch_climb", from: "sc_vigil", label: "Climb to the lamp", to: "sc_pier" },
  ],
  endings: [{ sceneId: "sc_pier", title: "The harbour, level" }],
  excluded: [],
  groups: [],
};

function state(routing: Routing | null = ROUTING): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: [
        ...world.productions,
        {
          ...salt,
          meta: { ...salt.meta, id: "low-water", title: "Low Water", medium: "video" as const, kind: "interactive" },
          scenes: SCENES,
          sceneFiles: Object.fromEntries(SCENES.map((s) => [s.id, s.id.replace(/^sc_/, "")])),
          routing,
          takes: [],
          selections: {},
        },
      ],
    },
  };
}

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}
const mounted: Mounted[] = [];

async function mount(routing: Routing | null = ROUTING): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state(routing));
    root.render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water/branch-map`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/branch-map" element={<BranchMapScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const item = { container, root, sent };
  mounted.push(item);
  return item;
}

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.container.remove();
  }
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

const all = (item: Mounted, selector: string) => [...item.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

async function click(el: HTMLElement | undefined) {
  assert.ok(el, "the thing to press exists");
  await act(async () => {
    el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
  });
}
function button(item: Mounted, label: string): HTMLElement | undefined {
  return all(item, "button, a").find((el) => text(el) === label || el.getAttribute("aria-label") === label);
}
/** React's own handler, called as the browser would after a value changes (see library.test). */
async function change(el: HTMLElement | undefined, value: string) {
  assert.ok(el, "the field exists");
  await act(async () => {
    // linkedom's <select> has no value setter, so the handler is given the value it reads.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    const target = setter ? el : { value };
    const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = key === undefined ? undefined : (el as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key];
    props?.onChange?.({ target, currentTarget: target });
  });
}
async function key(el: HTMLElement | undefined, name: string) {
  assert.ok(el);
  await act(async () => {
    const k = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = k === undefined ? undefined : (el as unknown as Record<string, { onKeyDown?: (event: unknown) => void }>)[k];
    props?.onKeyDown?.({ key: name, preventDefault() {}, currentTarget: el, target: el });
  });
}
/** A field left: React's own blur handler, called as the browser would. */
async function blur(el: HTMLElement | undefined) {
  assert.ok(el);
  await act(async () => {
    const k = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = k === undefined ? undefined : (el as unknown as Record<string, { onBlur?: (event: unknown) => void }>)[k];
    props?.onBlur?.({ currentTarget: el, target: el });
  });
}
const commands = (item: Mounted): RoutingCommand[] =>
  item.sent.flatMap((message) => (message.kind === "routing-command" ? [message.command] : []));
const card = (item: Mounted, id: string) => all(item, `[role="option"][data-scene="${id}"]`)[0];

describe("the branch map canvas (design turn 157)", () => {
  it("draws every choice as a curve, dashed until walked, with its label on it", async () => {
    const item = await mount();
    assert.equal(all(item, "path.bm-edge").length, 6, "one curve per choice");
    // No evidence served yet, so the local fold has every choice unwalked.
    assert.equal(all(item, "path.bm-edge--unwalked").length, 6);
    assert.deepEqual(all(item, ".bm-label").map(text).sort(), ROUTING.choices.map((choice) => choice.label).sort());
    assert.match(text(item.container), /Not on a route · 1/, "the undertow sits in the tray");
    assert.match(text(card(item, "sc_undertow")!), /unreachable/);
  });

  it("counts the findings in the header and lists them by name when the count is pressed", async () => {
    const item = await mount();
    const count = all(item, ".bm-count")[0];
    assert.match(text(count!), /7 block\s*2 warn/, "the undertow and six unwalked choices block; two scenes are reached two ways");
    assert.match(text(button(item, "Export blocked · 7")!), /Export blocked · 7/, "the header and the export say one number");
    assert.equal(all(item, ".bm-insp").length, 0, "nothing selected, so no Inspector");
    await click(count);
    const panel = text(all(item, ".bm-insp")[0]!);
    assert.match(panel, /The undertow\s*no way in/);
    assert.match(panel, /6 choices not walked/);
    assert.match(panel, /The bell towers\s*2 ways in/);
    assert.doesNotMatch(panel, /sc_undertow|ch_stay/, "titles and labels, never ids");
  });

  it("selects a choice by its label and renames it in place, as one command", async () => {
    const item = await mount();
    await click(all(item, ".bm-label").find((el) => text(el) === "Stay with the boat"));
    const field = all(item, 'input[aria-label="Label"]')[0];
    await change(field, "Keep to the boat");
    await key(field, "Enter");
    assert.deepEqual(commands(item), [{ operation: "edit-choice", choiceId: "ch_stay", changes: { label: "Keep to the boat" } }]);
    // A click away before the new routing arrives is the same edit, not a second one.
    await blur(field);
    assert.equal(commands(item).length, 1, "Enter then leaving the field sends the rename once");
  });

  it("names what a removal breaks before it sends anything, then sends one command", async () => {
    const item = await mount();
    await click(all(item, ".bm-label").find((el) => text(el) === "Wait for low water"));
    await click(button(item, "Remove choice"));
    const confirm = all(item, '[role="alertdialog"]')[0];
    assert.ok(confirm, "the confirmation is open");
    assert.match(text(confirm), /The Vigil — no way in/);
    assert.deepEqual(commands(item), [], "nothing is written while it asks");
    const removes = all(item, '[role="alertdialog"] button').filter((el) => text(el) === "Remove choice");
    await click(removes[0]);
    assert.deepEqual(commands(item), [{ operation: "remove-choice", choiceId: "ch_wait" }]);
  });

  it("selects a scene into the Inspector: make it the start, mark it an ending", async () => {
    const item = await mount();
    await click(card(item, "sc_vigil"));
    assert.equal(card(item, "sc_vigil")!.getAttribute("aria-selected"), "true");
    await click(button(item, "Make this the start"));
    await click(all(item, 'button[role="switch"][aria-label="Ending"]')[0]);
    assert.deepEqual(commands(item), [
      { operation: "set-start", sceneId: "sc_vigil" },
      { operation: "set-ending", sceneId: "sc_vigil", title: "The Vigil" },
    ]);
  });

  it("walks the choices after the cards at the keyboard, and Delete on a choice asks first", async () => {
    const item = await mount();
    const labels = all(item, ".bm-label");
    assert.ok(labels.every((el) => el.getAttribute("tabindex") === "-1"), "one tab stop: the start card, not the choices");
    assert.ok(labels.every((el) => el.getAttribute("data-walk")?.startsWith("c:")), "every choice is in the walk");
    const wait = labels.find((el) => text(el) === "Wait for low water");
    await key(wait, "Delete");
    assert.match(text(all(item, '[role="alertdialog"]')[0] ?? null), /The Vigil — no way in/);
    assert.deepEqual(commands(item), [], "Delete asks; it does not remove");
  });

  it("names each scene to a screen reader with its designations and its choices in and out", async () => {
    const item = await mount();
    assert.equal(card(item, "sc_towers")!.getAttribute("aria-label"), "The bell towers, 2 choices in, 1 out");
    assert.equal(card(item, "sc_pier")!.getAttribute("aria-label"), "The pier at dusk, ending, The harbour, level, 2 choices in, 0 out");
    assert.equal(card(item, "sc_quarter")!.getAttribute("aria-label"), "The drowned quarter, start, 0 choices in, 2 out");
  });

  it("asks for the findings again when the routing changes by another way in", async () => {
    const item = await mount();
    const asked = () => item.sent.filter((message) => message.kind === "list-routing-findings").length;
    const before = asked();
    await act(async () => {
      __setStateForTest(state({ ...ROUTING, version: 13 }));
    });
    assert.equal(asked(), before + 1, "a new routing version is a new fold");
  });

  it("offers no exclusion for a scene a route reaches", async () => {
    const item = await mount();
    await click(card(item, "sc_vigil"));
    assert.match(text(all(item, ".bm-insp")[0]!), /on a route/);
    assert.equal(button(item, "Exclude…"), undefined, "the export would ship its choices with nothing to play");
  });

  it("excludes a scene only with a reason", async () => {
    const item = await mount();
    await click(card(item, "sc_undertow"));
    await click(button(item, "Exclude…"));
    const add = button(item, "Exclude");
    assert.equal(add!.hasAttribute("disabled"), true, "no reason, no exclusion");
    await change(all(item, 'input[aria-label="Reason for excluding"]')[0], "kept for the audio");
    await click(button(item, "Exclude"));
    assert.deepEqual(commands(item), [{ operation: "exclude-scene", sceneId: "sc_undertow", reason: "kept for the audio" }]);
  });

  it("draws a choice from the Inspector, the pointer-free way to what dragging does", async () => {
    const item = await mount();
    await click(card(item, "sc_vigil"));
    await click(button(item, "Draw a choice from here"));
    await change(all(item, 'input[aria-label="Choice label"]')[0], "Take the bell stair");
    await change(all(item, 'select[aria-label="To scene"]')[0], "sc_towers");
    await click(button(item, "Add choice"));
    assert.deepEqual(commands(item), [
      { operation: "add-choice", choice: { id: "ch_take-the-bell-stair", from: "sc_vigil", label: "Take the bell stair", to: "sc_towers" } },
    ]);
  });

  it("previews in the shared player over the window, and a choice pressed there is walk evidence", async () => {
    const item = await mount();
    await click(button(item, "Preview"));
    const player = all(item, ".bm-player.aip")[0];
    assert.ok(player, "the package's own player, mounted by the map (turn 156g)");
    assert.match(text(all(item, ".aip-strip")[0]!), /Preview\s*from The drowned quarter\s*6 choices not walked/);
    await act(async () => {
      player!.querySelector("video")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
    });
    await click(all(item, ".aip-choice").find((el) => /Stay with the boat/.test(text(el))));
    const walks = item.sent.filter((message) => message.kind === "record-traversal");
    assert.deepEqual(
      walks.map((message) => message.kind === "record-traversal" && [message.choiceId, message.from, message.to, message.route]),
      [["ch_stay", "sc_quarter", "sc_towers", ["sc_quarter"]]],
    );
    await click(all(item, "button").find((el) => /Close preview/.test(text(el))));
    assert.equal(all(item, ".bm-player").length, 0, "closed, the map is back");
  });

  it("day one picks the start from the scenes and writes a start and nothing else", async () => {
    const item = await mount(null);
    assert.match(text(item.container), /Draw the first choice from the start scene/);
    assert.equal(all(item, '[role="radio"]').length, SCENES.length, "every scene can be the start");
    await click(all(item, '[role="radio"]').find((el) => /The causeway/.test(text(el))));
    await click(button(item, "Start at The causeway"));
    assert.deepEqual(commands(item), [{ operation: "set-start", sceneId: "sc_causeway" }]);
  });
});
