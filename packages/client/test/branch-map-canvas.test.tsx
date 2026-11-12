import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { storyIdentity, storyReplay, storyVisibleBeats, type ClientMessage, type ClientState, type RoutingCommand, type Routing, type Scene } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { beatPreviewOptions, BranchMapScreen, sceneClips } from "../src/screens/branch-map.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The branch map as a canvas (design turn 157), pressed: each gesture sends one closed routing
 * command, the findings count opens the findings in the words the map uses, and a removal names
 * what it breaks before anything is sent.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
/** Set by a test that wants the narrow window (157i); every other test is wide. */
let narrowWindow = false;
let compactWindow = false;
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: narrowWindow && query === "(max-width: 599px)" || compactWindow && query === "(max-width: 1099px)", media: query, addEventListener() {}, removeEventListener() {} }),
});
// linkedom keeps no focus; this does, so a test can ask where it went.
const focusLog: unknown[] = [];
Object.assign(dom.HTMLElement.prototype, {
  focus(this: unknown) {
    focusLog.push(this);
  },
  setPointerCapture() {},
  scrollIntoView() {},
});
const focused = () => focusLog[focusLog.length - 1] ?? null;
Object.defineProperty(dom.document, "activeElement", { get: focused, configurable: true });
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

const all = (item: Mounted, selector: string) => [...item.container.ownerDocument.querySelectorAll(selector)] as unknown as HTMLElement[];
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
/** linkedom lays nothing out; a test that needs the viewport's size gives it one, then takes it back. */
async function sized<T>(run: () => Promise<T>, width = 1200): Promise<T> {
  const proto = dom.HTMLElement.prototype as unknown as object;
  Object.defineProperty(proto, "clientWidth", { get: () => width, configurable: true });
  Object.defineProperty(proto, "clientHeight", { get: () => 800, configurable: true });
  try {
    return await run();
  } finally {
    delete (proto as Record<string, unknown>)["clientWidth"];
    delete (proto as Record<string, unknown>)["clientHeight"];
  }
}

/** React's own pointer handler on `el`, called as a browser would at the end of a gesture. */
async function pointer(el: Element | undefined, handler: "onPointerDown" | "onPointerMove" | "onPointerUp") {
  assert.ok(el);
  await act(async () => {
    const k = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = k === undefined ? undefined : (el as unknown as Record<string, Record<string, ((event: unknown) => void) | undefined>>)[k];
    props?.[handler]?.({ clientX: 0, clientY: 0, pointerId: 1, stopPropagation() {}, preventDefault() {}, currentTarget: el, target: el });
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

  it("draws a lone way as a plain link with its note, and its inspector says it plays through (turn 246g)", async () => {
    const item = await mount();
    // Let it sleep and Climb to the lamp are each the only way out of their scene, in every state.
    assert.deepEqual(all(item, ".bm-label--link").map(text).sort(), ["Climb to the lamp", "Let it sleep"], "a link: its note beside the line, no pill");
    assert.equal(all(item, ".bm-label:not(.bm-label--link)").length, 4, "the choices keep their pills");
    assert.match(text(all(item, ".bm-head__meta")[0]!), /6 scenes · 4 choices · 2 links · 1 ending · v12/, "the count names links apart");
    assert.equal(all(item, "path.bm-edge").length, 6, "every way on is still a line, walked solid or dashed");
    await click(all(item, ".bm-label--link").find((el) => text(el) === "Let it sleep"));
    const inspector = all(item, '.bm-insp[aria-label="Link"]')[0];
    assert.ok(inspector, "the inspector is titled Link");
    assert.match(text(inspector!), /The bell towers\s*Let it sleep\s*The bell towers → The pier at dusk\s*Plays through/);
    assert.match(text(inspector!), /Note/, "its label is the author's note");
    assert.doesNotMatch(text(inspector!), /\bLabel\b/);
    assert.match(text(inspector!), /Available when\s*Always\s*Remember\s*Nothing\s*Preview\s*Not walked/);
    assert.ok(button(item, "Edit link"), "and one way to edit it");
    assert.match(text(all(item, ".aip-strip")[0] ?? null), /^$/, "nothing previews until asked");
    await click(button(item, "Preview"));
    assert.match(text(all(item, ".aip-strip")[0]!), /4 choices not walked/, "the preview counts choices, not links (246e)");
  });

  it("keeps the pill of a choice lone on only some routes, and says it sometimes plays through (call 7)", async () => {
    const story: Routing = {
      ...ROUTING,
      schemaVersion: 2,
      facts: [{ id: "lamp", label: "Lamp lit", type: "boolean", default: false }],
      choices: [
        { id: "ch_follow", from: "sc_quarter", label: "Follow the lantern", to: "sc_causeway", effects: [{ fact: "lamp", value: true }] },
        { id: "ch_stay", from: "sc_quarter", label: "Stay with the boat", to: "sc_causeway" },
        { id: "ch_cross", from: "sc_causeway", label: "Cross before the tide", to: "sc_towers", when: { op: "eq", fact: "lamp", value: true } },
        { id: "ch_wait", from: "sc_causeway", label: "Wait for low water", to: "sc_vigil" },
        { id: "ch_sleep", from: "sc_towers", label: "Let it sleep", to: "sc_pier" },
        { id: "ch_climb", from: "sc_vigil", label: "Climb to the lamp", to: "sc_pier" },
      ],
    };
    const item = await mount(story);
    const wait = all(item, ".bm-label").find((el) => /Wait for low water/.test(text(el)));
    assert.ok(wait && !wait.classList.contains("bm-label--link"), "alone only while the lamp is dark: a listener reads its label on the other route");
    assert.deepEqual(all(item, ".bm-label--link").map(text).sort(), ["Climb to the lamp", "Let it sleep"]);
    await click(wait);
    const inspector = all(item, '.bm-insp[aria-label="Choice"]')[0];
    assert.match(text(inspector!), /Sometimes plays through/);
  });

  it("offers the Ending control for a stateful ending with choices and warns in the connector (#2238)", async () => {
    const item = await mount({ ...ROUTING, schemaVersion: 2, endings: [...ROUTING.endings, { sceneId: "sc_quarter", title: "Too soon" }] });
    await click(all(item, ".bm-count")[0]);
    await click(button(item, "Review Ending"));
    const ending = all(item, 'button[role="switch"][aria-label="Ending"]')[0];
    assert.ok(ending, "the repair action opens the inspector's Ending switch");
    await click(button(item, "Draw a choice from here"));
    assert.match(text(item.container.ownerDocument.body), /This scene is an ending.*turn off Ending in the scene inspector/);
    assert.equal(commands(item).length, 0, "reviewing the fault does not edit the story");
  });

  it("counts the findings in the header and lists them by name when the count is pressed", async () => {
    const item = await mount();
    const count = all(item, ".bm-count")[0];
    assert.match(text(count!), /7 block\s*2 warn/, "the undertow and six unwalked choices block; two scenes are reached two ways");
    assert.match(text(button(item, "Export blocked · 7")!), /Export blocked · 7/, "the header and the export say one number");
    assert.match(text(all(item, ".bm-insp")[0]!), /The drowned quarter/, "the opening scene makes the inspector useful immediately");
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
    const cancel = all(item, '[role="alertdialog"] button').find((el) => text(el) === "Cancel");
    assert.equal(focused(), cancel, "the question takes focus, so Enter on the label cannot close it unanswered");
    await click(cancel);
    assert.equal(all(item, '[role="alertdialog"]').length, 0);
    assert.equal(focused(), all(item, ".bm-label").find((el) => text(el) === "Wait for low water"), "and focus goes back to the choice");
  });

  it("retargets a selected choice by dragging its arrowhead to another scene (157d)", async () => {
    const item = await mount();
    await click(all(item, ".bm-label").find((el) => text(el) === "Wait for low water"));
    const handle = all(item, ".bm-handle")[0];
    assert.ok(handle, "the selected choice's arrowhead is a handle");
    const doc = dom.document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const before = doc.elementFromPoint;
    doc.elementFromPoint = () => card(item, "sc_towers") ?? null;
    try {
      await pointer(handle, "onPointerDown");
      await pointer(handle, "onPointerUp");
    } finally {
      doc.elementFromPoint = before;
    }
    assert.deepEqual(commands(item), [{ operation: "edit-choice", choiceId: "ch_wait", changes: { to: "sc_towers" } }]);
  });

  it("lists the map below 600 wide: layers in order, each choice a goes-to row (turn 172)", async () => {
    narrowWindow = true;
    try {
      const item = await mount();
      assert.equal(all(item, ".bm-viewport").length, 0, "no canvas to pan about in");
      const list = all(item, ".bm-list")[0]!;
      assert.match(text(list), /^Layer 1\s*The drowned quarter · 2 ways out\s*start\s*Follow the lantern\s*goes to\s*The causeway/);
      assert.match(text(list), /Not on a route · 1\s*The undertow · 0 ways out\s*unreachable/);
      const rows = all(item, ".bm-goes");
      assert.equal(rows.length, ROUTING.choices.length, "every choice, once");
      assert.ok(rows.every((row) => row.classList.contains("bm-goes--unwalked")), "dashed: nobody has walked them");
      await click(rows.find((row) => /Wait for low water/.test(text(row))));
      const label = all(item, '.bm-insp input[aria-label="Label"]')[0] as unknown as HTMLInputElement | undefined;
      assert.equal(label?.value, "Wait for low water", "a row selects what it names, and the Inspector edits it");
    } finally {
      narrowWindow = false;
    }
  });

  it("previews the cut as it plays: a trimmed range, a pass segment, and a covering pass once", () => {
    const shot = (id: string) => ({ id, number: 1, title: id }) as never;
    const scn = { ...scene("sc_x", 9, "X"), shots: [shot("sh_1"), shot("sh_2"), shot("sh_3"), shot("sh_4")] } as never;
    const production = {
      meta: { id: "saltlight" },
      selections: { sh_3: { acceptedTakeId: "tk_pass" }, sh_4: { acceptedTakeId: "tk_pass" } },
      takes: [{ id: "tk_pass", kind: "clip", media: "pass.mp4", coversShots: ["sh_3", "sh_4"] }],
    } as never;
    const entry = (path: string, inSec: number | undefined, outSec: number | undefined, durationSec: number) =>
      ({ media: { path, ...(inSec !== undefined ? { inSec } : {}), ...(outSec !== undefined ? { outSec } : {}) }, durationSec }) as never;
    const cut = new Map([
      ["sh_1", entry("productions/saltlight/takes/tk_a/a.mp4", 1.5, undefined, 4)],
      ["sh_2", entry("productions/saltlight/takes/tk_p/p.mp4", 10, 13, 6)],
    ]);
    const clips = sceneClips(production, "the-undersong", scn, cut);
    assert.deepEqual(
      clips.map((clip) => [clip.src.replace(/^.*\/takes\//, ""), clip.from, clip.to]),
      [
        ["tk_a/a.mp4", 1.5, 5.5],
        ["tk_p/p.mp4", 10, 13],
        ["tk_pass/pass.mp4", undefined, undefined],
      ],
      "a trim starts late and the slot ends it; a segment keeps its range; a whole pass plays once, from its start",
    );
  });

  it("keeps the scene unselected when a drag from its port ends in a click", async () => {
    const item = await mount();
    await click(all(item, '[data-scene="sc_vigil"] .bm-port')[0]);
    assert.equal(all(item, ".bm-insp").length, 0, "the click after a drag does not select the scene under the port");
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

  it("defines a connector in the dialog from the Inspector entry point", async () => {
    const item = await mount();
    await click(card(item, "sc_vigil"));
    await click(button(item, "Draw a choice from here"));
    await change(all(item, 'textarea[aria-label="Choice text"]')[0], "Take the bell stair");
    await change(all(item, 'select[aria-label="Destination scene"]')[0], "sc_towers");
    await click(button(item, "Add choice"));
    assert.deepEqual(commands(item), [
      { operation: "add-choice", choice: { id: "ch_take-the-bell-stair", from: "sc_vigil", label: "Take the bell stair", to: "sc_towers" } },
    ]);
  });

  it("the node plus defines one connector and retains typed rules across map selection", async () => {
    const item = await mount({ ...ROUTING, schemaVersion: 2, facts: [{ id: "dev", label: "Dev Malik", type: "enum", values: ["Alive", "Lost at release"], default: "Alive" }] });
    await click(card(item, "sc_quarter"));
    await click(all(item, '[data-scene="sc_quarter"] .bm-port')[0]);
    assert.ok(all(item, 'dialog.story-dialog')[0]);
    assert.equal(button(item, "Add choice")!.hasAttribute("disabled"), true);
    await change(all(item, 'textarea[aria-label="Choice text"]')[0], "Ask Dev to hold the release");
    await click(button(item, "Add condition"));
    await click(button(item, "Remember a value"));
    assert.equal((all(item, 'select[aria-label="Remember value"]')[0] as HTMLSelectElement).value, "Lost at release", "a new remembered value differs from the starting value");
    await change(all(item, 'select[aria-label="Remember value"]')[0], "Lost at release");
    await click(button(item, "Choose on map"));
    assert.equal(all(item, 'dialog.story-dialog').length, 0);
    await click(card(item, "sc_towers"));
    assert.equal((all(item, 'textarea[aria-label="Choice text"]')[0] as HTMLInputElement).value, "Ask Dev to hold the release");
    assert.equal(button(item, "Add choice")!.hasAttribute("disabled"), false);
    await click(button(item, "Add choice"));
    assert.deepEqual(commands(item), [{ operation: "add-choice", choice: { id: "ch_ask-dev-to-hold-the-release", from: "sc_quarter", to: "sc_towers", label: "Ask Dev to hold the release", when: { op: "eq", fact: "dev", value: "Alive" }, effects: [{ fact: "dev", value: "Lost at release" }] } }]);
    assert.ok(all(item, 'dialog.story-dialog')[0], "the draft stays until its saved snapshot arrives");
    const add=commands(item)[0]!;
    assert.equal(add.operation,"add-choice");
    if(add.operation!=="add-choice") throw new Error("Expected add");
    await act(async()=>__setStateForTest(state({...ROUTING,schemaVersion:2,version:ROUTING.version+1,facts:[{id:"dev",label:"Dev Malik",type:"enum",values:["Alive","Lost at release"],default:"Alive"}],choices:[...ROUTING.choices,add.choice]})));
    assert.equal(all(item,'dialog.story-dialog').length,0);
    assert.match(text(all(item,'.bm-insp')[0]!),/Added · not walked.*Dev Malik is Alive.*Dev Malik → Lost at release/);
    await click(button(item,"Edit choice"));
    await click(button(item,"Cancel"));
    assert.ok(button(item,"Edit choice"),"canceling an edit returns to the selected connector");
    await key(all(item,`[data-walk="c:${add.choice.id}"]`)[0],"Delete");
    assert.ok(all(item,'[role="alertdialog"]')[0],"Delete reaches confirmation from the saved summary");
    await click(button(item,"Cancel"));
    await click(button(item,"More choice settings"));
    assert.ok(button(item,"Remove choice"));
    assert.ok(all(item,'select[aria-label="From scene"]')[0],"source editing remains reachable in Choice settings");
  });

  it("forwards a stateful walk witness through the React player wrapper", async () => {
    const routing: Routing = { ...ROUTING, schemaVersion: 2, facts: [{ id: "dev", label: "Dev", type: "boolean", default: true }], choices: ROUTING.choices.map(choice => choice.id === "ch_stay" ? { ...choice, effects: [{ fact: "dev", value: false }] } : choice) };
    const item = await mount(routing);
    await click(button(item, "Preview"));
    await click(all(item, ".aip-choice").find(el => /Stay with the boat/.test(text(el))));
    const walk = item.sent.find(message => message.kind === "record-traversal");
    assert.ok(walk?.kind === "record-traversal");
    assert.deepEqual(walk.story, { identity: storyIdentity(routing), prefix: [], before: storyIdentity(storyReplay(routing).state), after: storyIdentity(storyReplay(routing, ["ch_stay"]).state), provenance: "human" });
  });

  it("creates an incoming connector when the finding supplies only its destination", async () => {
    const item = await mount();
    await click(all(item, ".bm-count")[0]);
    await click(button(item, "Draw a choice to it"));
    await change(all(item, 'select[aria-label="From scene"]')[0], "sc_quarter");
    await change(all(item, 'textarea[aria-label="Choice text"]')[0], "Reach the undertow");
    await click(button(item, "Add choice"));
    assert.deepEqual(commands(item), [{ operation: "add-choice", choice: { id: "ch_reach-the-undertow", from: "sc_quarter", to: "sc_undertow", label: "Reach the undertow" } }]);
  });

  it("keyboard activation selects a map destination and retains the draft", async () => {
    const item = await mount();
    await click(card(item, "sc_quarter"));
    await click(all(item, '[data-scene="sc_quarter"] .bm-port')[0]);
    await change(all(item, 'textarea[aria-label="Choice text"]')[0], "Keyboard route");
    await click(button(item, "Choose on map"));
    await key(card(item, "sc_towers"), "Enter");
    assert.ok(all(item, 'dialog.story-dialog')[0]);
    await click(button(item, "Add choice"));
    assert.ok(commands(item).some(command => command.operation === "add-choice" && command.choice.to === "sc_towers" && command.choice.label === "Keyboard route"));
  });

  it("a persisted Connector draft choice cannot turn creation into editing", async () => {
    const item = await mount({ ...ROUTING, choices: [...ROUTING.choices, { id: "ch_connector-draft", from: "sc_quarter", to: "sc_causeway", label: "Connector draft" }] });
    await click(card(item, "sc_quarter"));
    await click(all(item, '[data-scene="sc_quarter"] .bm-port')[0]);
    await change(all(item, 'textarea[aria-label="Choice text"]')[0], "New route");
    await change(all(item, 'select[aria-label="Destination scene"]')[0], "sc_towers");
    await click(button(item, "Add choice"));
    assert.equal(commands(item)[0]!.operation, "add-choice");
  });

  it("the phone list exposes scene settings separately from connector creation", async () => {
    narrowWindow = true;
    try {
      const item = await mount();
      await click(button(item, "Settings for The drowned quarter"));
      assert.ok(all(item, '.bm-insp button[role="switch"][aria-label="Ending"]')[0]);
      assert.ok(button(item, "Show when"));
      assert.ok(button(item, "Draw a choice from here"));
    } finally { narrowWindow = false; }
  });

  it("adds a fact with one save and starts remembered booleans with a change (#2238)", async () => {
    const item = await mount({ ...ROUTING, schemaVersion: 2 });
    await click(button(item, "Story facts"));
    await click(button(item, "+ Add fact"));
    assert.equal(button(item, "Add fact"), undefined, "there is no inner staging step");
    assert.equal(button(item, "Remove fact"), undefined);
    assert.equal(all(item, 'dialog.story-dialog [role="alert"]').length, 0, "an untouched name is not a broken reference");
    assert.equal(button(item, "Keep fact")!.hasAttribute("disabled"), true);
    await change(all(item, 'input[aria-label="Name for fact"]')[0], "Has the key");
    await click(button(item, "Keep fact"));
    const facts = [{ id: "fact", label: "Has the key", type: "boolean" as const, default: false }];
    assert.deepEqual(commands(item), [{ operation: "set-facts", baseVersion: ROUTING.version, facts }]);
    await act(async () => __setStateForTest(state({ ...ROUTING, schemaVersion: 2, version: ROUTING.version + 1, facts })));
    assert.equal(button(item, "Keep fact"), undefined);
    await click(card(item, "sc_quarter"));
    await click(all(item, '[data-scene="sc_quarter"] .bm-port')[0]);
    await click(button(item, "Remember a value"));
    assert.equal((all(item, 'select[aria-label="Remember value"]')[0] as HTMLSelectElement).value, "true");
  });

  it("loading current rules shows the intervening facts before a stale replacement can save", async () => {
    const routing: Routing = { ...ROUTING, schemaVersion: 2, facts: [{ id: "dev", label: "Dev Malik", type: "boolean", default: true }] };
    const item = await mount(routing);
    await click(button(item, "Story facts · 1"));
    await click(button(item, "Edit Dev Malik"));
    await change(all(item, 'input[aria-label="Name for dev"]')[0], "Local draft name");
    const latest: Routing = { ...routing, version: routing.version + 1, facts: [...routing.facts!, { id: "wei", label: "Lin Wei", type: "boolean", default: true }] };
    await act(async () => __setStateForTest(state(latest)));
    assert.equal((all(item, 'input[aria-label="Name for dev"]')[0] as HTMLInputElement).value, "Local draft name");
    assert.equal(button(item, "Keep fact")!.hasAttribute("disabled"), true);
    await click(button(item, "Load current rules"));
    assert.ok(button(item, "Edit Lin Wei"), "the Inspector includes the intervening fact");
    assert.equal((all(item, 'input[aria-label="Name for dev"]')[0] as HTMLInputElement).value, "Dev Malik");
    await click(button(item, "Keep fact"));
    assert.deepEqual(commands(item), [{ operation: "set-facts", baseVersion: latest.version, facts: latest.facts }]);
  });

  it("reviews compact is-not rules and remembered values before one atomic Inspector save", async () => {
    const routing: Routing = { ...ROUTING, schemaVersion: 2, facts:[{ id:"dev",label:"Dev Malik",type:"enum",values:["Alive","Lost"],default:"Alive" }] };
    const item = await mount(routing);
    await click(all(item,'[data-walk="c:ch_follow"]')[0]);
    await click(button(item,"Add condition"));
    await change(all(item,'select[aria-label="Condition comparison"]')[0],"not");
    await click(button(item,"Remember a value"));
    await change(all(item,'select[aria-label="Remember value"]')[0],"Lost");
    await change(all(item,'select[aria-label="If unavailable"]')[0],"disabled");
    assert.ok(button(item,"Review change")!.hasAttribute("disabled"),"an authored reason is required");
    await change(all(item,'textarea[aria-label="Unavailable reason"]')[0],"  Dev cannot reach the release.  ");
    await click(button(item,"Review change"));
    assert.deepEqual(commands(item),[],"review does not write");
    assert.match(text(item.container.ownerDocument.body),/Dev Malik is not Alive/);
    await click(button(item,"Keep change"));
    assert.deepEqual(commands(item),[{operation:"edit-choice",choiceId:"ch_follow",baseVersion:routing.version,changes:{when:{op:"not",arg:{op:"eq",fact:"dev",value:"Alive"}},effects:[{fact:"dev",value:"Lost"}],unavailable:{reason:"Dev cannot reach the release."}}}]);
    await act(async()=>__setStateForTest(state({...routing,version:routing.version+1,choices:routing.choices.map(choice=>choice.id==="ch_follow"?{...choice,when:{op:"not",arg:{op:"eq",fact:"dev",value:"Alive"}},effects:[{fact:"dev",value:"Lost"}],unavailable:{reason:"Dev cannot reach the release."}}:choice)})));
    assert.equal(button(item,"Keep change"),undefined,"acknowledgement closes review");
    assert.equal(button(item,"Load current rules"),undefined,"an acknowledged save is not a conflict");
  });

  it("draws an unsaved connector and excludes its source from destination choices", async () => {
    const item = await mount({...ROUTING,schemaVersion:2});
    await click(all(item,'[data-scene="sc_quarter"] .bm-port')[0]);
    assert.equal(all(item,'select[aria-label="Destination scene"] option').some(option=>option.getAttribute("value")==="sc_quarter"),false);
    await change(all(item,'select[aria-label="Destination scene"]')[0],"sc_towers");
    await change(all(item,'textarea[aria-label="Choice text"]')[0],"An unsaved route");
    assert.match(text(all(item,'.story-draft-label')[0]!),/An unsaved route.*Draft/);
    assert.ok(all(item,'.bm-edge--new')[0]);
    assert.deepEqual(commands(item),[]);
  });

  it("opens the exact witness prefix from a state-dependent finding", async () => {
    const routing: Routing = {...ROUTING,schemaVersion:2,facts:[{id:"dev",label:"Dev Malik",type:"boolean",default:true}],choices:ROUTING.choices.map(choice=>choice.id==="ch_follow"?{...choice,effects:[{fact:"dev",value:false}]}:choice)};
    const item = await mount(routing);
    await click(all(item,'.bm-count')[0]);
    const finding=all(item,'.bm-find').find(el=>text(el).includes("Cross before the tide") && text(el).includes("Witness route"));
    assert.ok(finding);
    assert.match(text(finding),/Follow the lantern.*Dev Malik: false/);
    await click([...finding.querySelectorAll('button')].find(el=>text(el)==="Preview this route") as HTMLElement);
    assert.match(text(all(item,'.aip-strip')[0]!),/from The causeway/);
    assert.equal(all(item,".story-dialog").length,0,"the route starts without a different-prefix picker");
    await click(button(item,"Preview facts"));
    assert.match(text(all(item,".aip-fact-row")[0]!),/Dev Malik.*Follow the lantern.*false/);
    await click(button(item,"Test another route"));
    assert.ok(button(item,"Preview this route"),"another actual prefix is picked explicitly");
  });

  it("preserves spaces while an author types a multiword enum value", async () => {
    const routing: Routing={...ROUTING,schemaVersion:2,facts:[{id:"dev",label:"Dev Malik",type:"enum",values:["Alive","Lost"],default:"Alive"}]};
    const item=await mount(routing);
    await click(button(item,"Story facts · 1"));
    await click(button(item,"Edit Dev Malik"));
    const input=all(item,'input[aria-label="Values for dev"]')[0] as HTMLInputElement;
    await change(all(item,'input[aria-label="Name for dev"]')[0],"  Dev Malik  ");
    for(const value of ["Alive, Lost ","Alive, Lost at ","Alive, Lost at release"]){await change(input,value);assert.equal(input.value,value);}
    await blur(input);
    await click(button(item,"Keep fact"));
    assert.deepEqual(commands(item),[{operation:"set-facts",baseVersion:routing.version,facts:[{id:"dev",label:"Dev Malik",type:"enum",values:["Alive","Lost at release"],default:"Alive"}]}]);
    await act(async()=>__setStateForTest(state({...routing,version:routing.version+1,facts:[{id:"dev",label:"Dev Malik",type:"enum",values:["Alive","Lost at release"],default:"Alive"}]})));
    assert.equal(button(item,"Keep fact"),undefined,"the normalized acknowledgement closes the fact editor");
    assert.equal(button(item,"Load current rules"),undefined);
  });

  it("resolves a requested shot after route guards and refuses a hidden shot", () => {
    const routing:Routing={...ROUTING,schemaVersion:2,facts:[{id:"dev",label:"Dev",type:"boolean",default:false}],presentation:[{sceneId:"sc_quarter",blocks:[],shots:[{shotId:"sh_1",when:{op:"eq",fact:"dev",value:true}}]}]};
    const snapshot=state(routing);
    const production=snapshot.world!.productions.find(p=>p.meta.id==="low-water")!;
    production.scenes=[{...SCENES[0]!,shots:[1,2,3].map(number=>({id:`sh_${number}`,number,title:`Shot ${number}`,description:`Shot ${number}`,audio:{kind:"vo" as const,line:`Line ${number}`}}))}];
    const options=(shotId:string)=>beatPreviewOptions({world:snapshot.world!,production,voices:new Map(),from:routing.start,shotId,unwalked:[],onChoice:()=>{},onClose:()=>{}});
    for(const [shotId,index] of [["sh_2",0],["sh_3",1]] as const){
      const preview=options(shotId);
      const beats=preview.scenes[routing.start]!.beats;
      assert.ok(beats,"the authored scene has preview beats");
      const active=storyVisibleBeats(routing,routing.start,beats,storyReplay(routing,[]).state);
      assert.equal(preview.at??0,index);
      assert.equal(active[preview.at??0]!.shotId,shotId,"the preview opens on the requested visible shot");
    }
    assert.throws(()=>options("sh_1"),/This shot is hidden or unavailable/);
  });

  it("keeps shot-condition controls reachable in a scripted scene", async () => {
    const routing: Routing={...ROUTING,schemaVersion:2,facts:[{id:"dev",label:"Dev",type:"boolean",default:true}],presentation:[{sceneId:"sc_quarter",blocks:[],shots:[{shotId:"sh_rule",when:{op:"eq",fact:"dev",value:true}}]}]};
    const item=await mount(routing);
    const snapshot=state(routing);
    const production=snapshot.world!.productions.find(p=>p.meta.id==="low-water")!;
    production.scenes=production.scenes.map(scene=>scene.id==="sc_quarter"?{...scene,script:{blocks:[{id:"blk_line",kind:"action",text:"The room goes silent."}]},shots:[{id:"sh_rule",number:1,title:"The first shot",description:"A silent room"}]} as Scene:scene);
    await act(async()=>__setStateForTest(snapshot));
    await click(card(item,"sc_quarter"));
    await click(button(item,"Show when"));
    assert.equal(button(item,"Remove condition"),undefined,"the selected line has no guard");
    await click(button(item,"All scene rules"));
    await click(button(item,"Remove condition"));
    await click(button(item,"Review change"));
    await click(button(item,"Keep change"));
    assert.deepEqual(commands(item),[{operation:"set-presentation",baseVersion:routing.version,presentation:{sceneId:"sc_quarter",blocks:[],shots:[]}}]);
  });

  it("keeps a stale unsaved condition repairable when its fact is removed elsewhere", async () => {
    const routing: Routing = { ...ROUTING, schemaVersion: 2, facts: [{ id: "dev", label: "Dev", type: "boolean", default: true }] };
    const item = await mount(routing);
    await click(all(item, '[data-scene="sc_quarter"] .bm-port')[0]);
    await click(button(item, "Add condition"));
    await act(async () => __setStateForTest(state({ ...routing, version: routing.version + 1, facts: [] })));
    assert.match(text(item.container.ownerDocument.body), /Missing fact/);
    assert.ok(all(item, 'select[aria-label="Condition comparison"]')[0]!.hasAttribute("disabled"));
    await click(button(item, "Remove condition"));
    assert.doesNotMatch(text(item.container.ownerDocument.body), /Missing fact/);
    assert.deepEqual(commands(item), []);
  });

  it("retains an ending draft when another author removes its ending", async () => {
    const routing: Routing = { ...ROUTING, schemaVersion: 2 };
    const item = await mount(routing);
    await click(card(item, "sc_pier"));
    await click(button(item, "Ending variants"));
    await change(all(item, 'input[aria-label="Ending title 1"]')[0], "A retained ending");
    await act(async () => __setStateForTest(state({ ...routing, version: routing.version + 1, endings: [] })));
    assert.match(text(item.container.ownerDocument.body), /no longer an ending.*draft is retained/);
    assert.equal((all(item, 'input[aria-label="Ending title 1"]')[0] as HTMLInputElement).value, "A retained ending");
    assert.ok(button(item, "Save endings")!.hasAttribute("disabled"));
    assert.equal(button(item, "Load current rules"), undefined, "a removed ending cannot replace the retained draft");
    assert.deepEqual(commands(item), []);
    await click(button(item, "Cancel"));
    assert.equal(button(item, "Save endings"), undefined, "cancellation safely returns to the map");
  });

  it("obsolete Show when rules can be removed after their targets are deleted", async () => {
    const routing: Routing = { ...ROUTING, schemaVersion: 2, facts: [{ id: "dev", label: "Dev", type: "boolean", default: true }], presentation: [{ sceneId: "sc_quarter", blocks: [{ blockId: "blk_gone", when: { op: "eq", fact: "dev", value: true } }], shots: [{ shotId: "sh_gone", when: { op: "eq", fact: "dev", value: true } }] }] };
    const item = await mount(routing);
    await click(card(item, "sc_quarter"));
    await click(button(item, "Show when"));
    await click(button(item, "Remove rule for blk_gone"));
    await click(button(item, "Remove rule for sh_gone"));
    await click(button(item, "Review change"));
    await click(button(item, "Keep change"));
    assert.deepEqual(commands(item), [{ operation: "set-presentation", baseVersion: routing.version, presentation: { sceneId: "sc_quarter", blocks: [], shots: [] } }]);
  });

  it("previews in the shared player over the window, and a choice pressed there is walk evidence", async () => {
    const item = await mount();
    await click(button(item, "Preview"));
    const player = all(item, ".bm-player.aip")[0];
    assert.ok(player, "the package's own player, mounted by the map (turn 156g)");
    // Six ways on, two of them links: the strip counts the four choices (turn 246e).
    assert.match(text(all(item, ".aip-strip")[0]!), /Preview\s*from The drowned quarter\s*4 choices not walked/);
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

  it("keeps Tab inside the preview, past a Route panel that was opened and closed", async () => {
    const item = await mount();
    await click(button(item, "Preview"));
    const player = all(item, ".bm-player")[0]!;
    const press = async (name: string, shift = false) =>
      act(async () => {
        const event = new dom.Event("keydown", { bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
        Object.assign(event, { key: name, shiftKey: shift });
        (focused() as HTMLElement | null ?? player).dispatchEvent(event);
      });
    await press("r");
    await press("r");
    const panel = player.querySelector("[data-ref=panel]")!;
    assert.ok(panel.hasAttribute("hidden") && panel.querySelectorAll("button").length > 0, "closed, its buttons still in the page");
    const visible = [...player.querySelectorAll<HTMLElement>("button")].filter((el) => el.closest("[hidden]") === null);
    visible[visible.length - 1]!.focus();
    await press("Tab");
    assert.equal(focused(), player, "Tab from the last control that shows wraps to the player, not the map behind it");
  });

  it("opens a long map at readable size and retains an explicit Fit overview (#2238)", () => sized(async () => {
    const routing: Routing = { ...ROUTING, choices: SCENES.slice(1).map((scene, index) => ({ id: `ch_step-${index}`, from: SCENES[index]!.id, to: scene.id, label: "Continue" })) };
    const item = await mount(routing);
    const scale = () => Number(/scale\(([^)]+)\)/.exec(all(item, ".bm-stage")[0]!.getAttribute("style")!)?.[1]);
    assert.ok(scale() >= .65, "opening does not reduce scene labels to an overview");
    await click(button(item, "Fit to view"));
    assert.ok(scale() < .65, "Fit still shows the whole graph when requested");
  }, 800));

  it("brings a newly connected destination into view at the current zoom (#2238)", () => sized(async () => {
    const routing: Routing = { ...ROUTING, choices: SCENES.slice(1, -1).map((scene, index) => ({ id: `ch_step-${index}`, from: SCENES[index]!.id, to: scene.id, label: "Continue" })) };
    const item = await mount(routing);
    const before = all(item, ".bm-stage")[0]!.getAttribute("style")!;
    await click(card(item, "sc_pier"));
    await click(button(item, "Draw a choice from here"));
    await change(all(item, 'textarea[aria-label="Choice text"]')[0], "Into the undertow");
    await change(all(item, 'select[aria-label="Destination scene"]')[0], "sc_undertow");
    await click(button(item, "Add choice"));
    const add = commands(item)[0]!;
    if (add.operation !== "add-choice") throw new Error("Expected add");
    await act(async () => __setStateForTest(state({ ...routing, version: routing.version + 1, choices: [...routing.choices, add.choice] })));
    const after = all(item, ".bm-stage")[0]!.getAttribute("style")!;
    assert.notEqual(after, before, "the saved destination is brought into view");
    assert.equal(/scale\(([^)]+)\)/.exec(after)?.[1], /scale\(([^)]+)\)/.exec(before)?.[1], "the person's zoom is kept");
  }, 800));

  it("fits the canvas when a window opened narrow is widened", () =>
    sized(async () => {
      narrowWindow = true;
      const item = await mount();
      narrowWindow = false;
      await act(async () => {
        __setStateForTest(state(ROUTING));
      });
      const stage = all(item, ".bm-stage")[0];
      assert.ok(stage, "the canvas is back");
      const style = stage.getAttribute("style") ?? "";
      assert.match(style, /translate\([\d.]+px, [\d.]+px\)/, "a real fit");
      assert.doesNotMatch(style, /translate\(0px, 0px\) scale\(1\)/, "fitted, not left at actual size from the corner");
    }));

  it("keeps an unsaved fact draft when a compact map becomes desktop (#2238)", () => sized(async () => {
    compactWindow = true;
    try {
      const routing: Routing = { ...ROUTING, schemaVersion: 2, facts: [{ id: "dev", label: "Dev Malik", type: "boolean", default: true }] };
      const item = await mount(routing);
      await click(button(item, "Story facts · 1"));
      await click(button(item, "Edit Dev Malik"));
      await change(all(item, 'input[aria-label="Name for dev"]')[0], "Dev's promise");
      compactWindow = false;
      await act(async () => __setStateForTest(state(routing)));
      assert.equal((all(item, 'input[aria-label="Name for dev"]')[0] as HTMLInputElement).value, "Dev's promise");
    } finally { compactWindow = false; }
  }));

  it("offers to remove a choice whose scene is gone, from its finding", async () => {
    const broken: Routing = { ...ROUTING, choices: [...ROUTING.choices, { id: "ch_ghost", from: "sc_gone", label: "Into the dark", to: "sc_pier" }] };
    const item = await mount(broken);
    await click(all(item, "button").find((el) => /block/.test(text(el)) && el.closest(".bm-head") !== null));
    const card = all(item, ".bm-find").find((el) => /Into the dark/.test(text(el)));
    assert.ok(card, "the finding names the choice");
    await click([...card.querySelectorAll("button")].find((el) => text(el as unknown as HTMLElement) === "Remove choice") as unknown as HTMLElement);
    assert.deepEqual(commands(item), [{ operation: "remove-choice", choiceId: "ch_ghost" }], "drawn nowhere else, the finding is where it is removed");
  });

  it("keeps focus in the choice sheet when a removal is cancelled on a phone", async () => {
    narrowWindow = true;
    try {
      const item = await mount();
      const row = all(item, ".bm-goes").find((el) => /Wait for low water/.test(text(el)));
      await click(row);
      await click(button(item, "Remove choice"));
      await click(all(item, '[role="alertdialog"] button').find((el) => text(el) === "Cancel"));
      assert.equal(focused(), all(item, '.bm-inspector-sheet input[aria-label="Label"]')[0], "the map stays inert behind the open sheet");
    } finally {
      narrowWindow = false;
    }
  });

  it("lays day one out narrow too, below 600 wide", async () => {
    narrowWindow = true;
    try {
      const item = await mount(null);
      assert.equal(all(item, '.bm[data-narrow="true"]').length, 1, "the start picker is not squeezed beside the Arke column");
    } finally {
      narrowWindow = false;
    }
  });

  it("drops the grab cursor when a drag across the canvas ends", async () => {
    const item = await mount();
    const viewport = all(item, ".bm-viewport")[0]!;
    await pointer(viewport, "onPointerDown");
    assert.ok(viewport.classList.contains("bm-viewport--panning"));
    await pointer(viewport, "onPointerUp");
    assert.ok(!viewport.classList.contains("bm-viewport--panning"), "cleared at once, not at the next unrelated render");
  });

  it("plays a take the cut trimmed away as a slate, not as its whole file", () => {
    const shot = (id: string) => ({ id, number: 1, title: id }) as never;
    const scn = { ...scene("sc_x", 9, "X"), shots: [shot("sh_1")] } as never;
    const production = {
      meta: { id: "saltlight" },
      selections: { sh_1: { acceptedTakeId: "tk_a", trimInSec: 9 } },
      takes: [{ id: "tk_a", kind: "clip", media: "a.mp4", coversShots: ["sh_1"] }],
    } as never;
    // The cut's entry for sh_1 has no media: its 9s trim runs past the take's end.
    const clips = sceneClips(production, "the-undersong", scn, new Map([["sh_1", { media: null, durationSec: 4 } as never]]));
    assert.deepEqual(clips, [], "nothing to play is a slate, as the export refuses it");
  });

  it("pans with the wheel after a narrow window is widened", () => sized(async () => {
    narrowWindow = true;
    const item = await mount();
    narrowWindow = false;
    await act(async () => {
      __setStateForTest(state(ROUTING));
    });
    const stage = () => all(item, ".bm-stage")[0]!.getAttribute("style") ?? "";
    const before = stage();
    await act(async () => {
      const wheel = new dom.Event("wheel", { bubbles: true, cancelable: true }) as unknown as WheelEvent;
      Object.assign(wheel, { deltaX: 40, deltaY: 0, ctrlKey: false, metaKey: false });
      all(item, ".bm-viewport")[0]!.dispatchEvent(wheel);
    });
    assert.notEqual(stage(), before, "the wheel reaches the canvas that mounted after the list");
  }));

  it("plays a covering pass once, even with a replacement between shots it covers", () => {
    const shot = (id: string) => ({ id, number: 1, title: id }) as never;
    const scn = { ...scene("sc_x", 9, "X"), shots: [shot("sh_1"), shot("sh_2"), shot("sh_3")] } as never;
    const production = {
      meta: { id: "saltlight" },
      selections: { sh_1: { acceptedTakeId: "tk_pass" }, sh_3: { acceptedTakeId: "tk_pass" } },
      takes: [{ id: "tk_pass", kind: "clip", media: "pass.mp4", coversShots: ["sh_1", "sh_2", "sh_3"] }],
    } as never;
    const cut = new Map([["sh_2", { media: { path: "productions/saltlight/takes/tk_new/new.mp4" }, durationSec: 4 } as never]]);
    const clips = sceneClips(production, "the-undersong", scn, cut);
    assert.deepEqual(clips.map((clip) => clip.src.replace(/^.*\/takes\//, "")), ["tk_pass/pass.mp4", "tk_new/new.mp4"]);
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
