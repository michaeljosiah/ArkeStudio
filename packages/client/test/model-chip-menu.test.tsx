import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientState } from "@arke-studio/contracts";
import { Composer } from "../src/components/composer.js";
import { ModelChip } from "../src/components/model-chip.js";
import { useOverlay } from "../src/lib/overlays.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The model chip's menu is drawn on the body, fixed beside the chip (2026-10-04). Hung off the
 * chip it was clipped by the composer's own box: in the production dock `.fy-cx` clips, and of
 * ninety models the one or two inside the composer showed, read as the only models there were.
 * linkedom lays nothing out, so the chip's and the menu's boxes are set here, as a window would
 * report them.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1200, innerHeight: 800 });
const focusLog: Element[] = [];
const focused = (): Element | null => focusLog.at(-1) ?? null;
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: focused });
dom.HTMLElement.prototype.focus = function (this: Element) { focusLog.push(this); };
dom.HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(dom.HTMLElement.prototype, "innerText", {
  configurable: true,
  get() { return this.textContent; },
  set(value: string) { this.textContent = value; },
});
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type Box = { top: number; bottom: number; left: number; width: number; height: number };
let chipBox: Box = { top: 700, bottom: 732, left: 40, width: 120, height: 32 };
let menuHeight = 560;
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const box = this.classList.contains("fy-mchip__btn") ? chipBox
    : this.classList.contains("fy-mchip__menu") ? { top: 0, bottom: menuHeight, left: 0, width: 430, height: menuHeight }
    : { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
  return { ...box, x: box.left, y: box.top, right: box.left + box.width, toJSON() { return box; } } as DOMRect;
};

const MODELS = Array.from({ length: 90 }, (_, index) => ({ id: `model-${index}`, provider: "anthropic", displayName: `Model ${index}` }));

function state(): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
      harnessModelStatus: { status: "ready" },
      harnessInfo: { generation: "claude", source: "path", version: "2.0.0", beta: false },
      harnessModels: MODELS,
    },
  };
}

/** A composer carrying the chip, as every chat composer does, holding its own pick. */
function ChatComposer() {
  const [value, setValue] = useState<string | undefined>("anthropic/model-3");
  return <Composer value="" onChange={() => {}} onSubmit={() => {}} placeholder="Say something"
    modelControl={<ModelChip state={state()} value={value} set={false} onPick={setValue} />} />;
}

/** A sheet that opens on the body, as Settings or the Export sheet does, holding a place in the order. */
function Sheet({ open }: { open: boolean }) {
  useOverlay("layer", open);
  return null;
}

function Page({ sheet }: { sheet: boolean }) {
  return <><ChatComposer /><Sheet open={sheet} /></>;
}

let root: Root | undefined;
let container: HTMLDivElement;
async function mount(children: ReactNode) {
  // The production dock's frame and composer both clip: the menu must be drawn outside them.
  container = document.createElement("div");
  container.setAttribute("style", "overflow: hidden");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<div className="fy-prodwrap" style={{ overflow: "clip" }}>{children}</div>));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  focusLog.length = 0;
  chipBox = { top: 700, bottom: 732, left: 40, width: 120, height: 32 };
  menuHeight = 560;
  Object.assign(dom.window, { innerWidth: 1200, innerHeight: 800 });
});

const chip = () => container.querySelector<HTMLButtonElement>(".fy-cx__bar button.fy-mchip__btn")!;
const menu = () => document.querySelector<HTMLElement>(".fy-mchip__menu");
async function open() {
  await act(async () => chip().click());
  const element = menu();
  assert.ok(element, "the menu opened");
  return element;
}
function key(target: Element, name: string) {
  const event = new dom.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
  event.key = name;
  target.dispatchEvent(event);
}
/**
 * A key on the search field. React's input-event polyfill (linkedom has no `oninput`) throws on a
 * native keydown at an input nothing focused, so the key is handed to the handler React holds for
 * it, as the audiobook tests hand it a change.
 */
function typeKey(target: Element, name: string) {
  const props = (target as unknown as Record<string, { onKeyDown?: (event: unknown) => void }>)[Object.keys(target).find((candidate) => candidate.startsWith("__reactProps$"))!];
  props!.onKeyDown!({ key: name, preventDefault() {}, stopPropagation() {} });
}
function press(target: Element) {
  target.dispatchEvent(new dom.Event("mousedown", { bubbles: true, cancelable: true }));
}

describe("the model chip's menu is out of the composer's clip", () => {
  it("is drawn on the body, outside the clipping composer, with every model in it", async () => {
    await mount(<ChatComposer />);
    const element = await open();
    assert.equal(container.contains(element), false, "not inside the clipping dock or composer");
    assert.equal(element.parentElement, document.body);
    assert.equal(element.querySelectorAll("[data-model]").length, 90, "all ninety models, not the two the clip showed");
    assert.equal(chip().getAttribute("aria-expanded"), "true");
    assert.equal(chip().getAttribute("aria-controls"), element.id);
  });

  it("opens upward when there is room above the chip, beside it and inside the window", async () => {
    await mount(<ChatComposer />);
    const element = await open();
    assert.equal(element.getAttribute("data-side"), "up");
    assert.equal(element.style.bottom, `${800 - 700 + 8}px`, "8px above the chip");
    assert.equal(element.id, chip().getAttribute("aria-controls"));
    assert.equal(element.style.top, "");
    assert.equal(element.style.left, "40px");
    assert.equal(element.style.maxHeight, "", "the stylesheet's own cap holds when it fits");
  });

  it("opens downward when the chip is near the top, and clamps to the window's right edge", async () => {
    chipBox = { top: 40, bottom: 72, left: 1100, width: 120, height: 32 };
    await mount(<ChatComposer />);
    const element = await open();
    assert.equal(element.getAttribute("data-side"), "down");
    assert.equal(element.style.top, `${72 + 8}px`);
    assert.equal(element.style.bottom, "");
    assert.equal(element.style.left, `${1200 - 430 - 12}px`, "12 from the window's edge");
  });

  it("takes the roomier side and shortens to fit it when neither side holds the whole menu", async () => {
    Object.assign(dom.window, { innerHeight: 400 });
    chipBox = { top: 150, bottom: 182, left: 40, width: 120, height: 32 };
    await mount(<ChatComposer />);
    const element = await open();
    assert.equal(element.getAttribute("data-side"), "down", "202px below against 134px above");
    assert.equal(element.style.maxHeight, `${400 - 182 - 8 - 12}px`);
  });

  it("closes on Escape and hands focus back to the chip", async () => {
    await mount(<ChatComposer />);
    const element = await open();
    assert.equal(focused(), element.querySelector("input"), "the search holds focus on opening");
    await act(async () => key(element, "Escape"));
    assert.equal(menu(), null);
    assert.equal(focused(), chip());
    assert.equal(chip().getAttribute("aria-expanded"), "false");
  });

  it("closes on a press outside, not on a press inside", async () => {
    await mount(<ChatComposer />);
    const element = await open();
    await act(async () => press(element.querySelector("[data-model]")!));
    assert.ok(menu(), "a press in the menu is the menu being used");
    await act(async () => press(container.querySelector(".fy-cx__editor") ?? container));
    assert.equal(menu(), null);
  });

  it("moves through the models by arrow keys from the search, opens from the keyboard and picks with Enter", async () => {
    await mount(<ChatComposer />);
    await act(async () => key(chip(), "ArrowDown"));
    const element = menu();
    assert.ok(element, "ArrowDown on the chip opens it");
    const search = element.querySelector("input")!;
    const named = () => document.getElementById(search.getAttribute("aria-activedescendant")!)?.getAttribute("data-model");
    assert.equal(named(), "anthropic/model-3", "it opens on the model in force");
    await act(async () => typeKey(search, "ArrowDown"));
    assert.equal(named(), "anthropic/model-4");
    await act(async () => typeKey(search, "ArrowUp"));
    await act(async () => typeKey(search, "ArrowUp"));
    assert.equal(named(), "anthropic/model-2");
    for (let step = 0; step < 3; step++) await act(async () => typeKey(search, "ArrowUp"));
    assert.equal(named(), "anthropic/model-89", "it wraps from the first to the last");
    assert.equal(focused(), search, "keyboard focus stays in the search; the list is followed by aria-activedescendant");
    await act(async () => typeKey(search, "Enter"));
    assert.equal(menu(), null);
    assert.equal(focused(), chip(), "focus back on the chip after a pick");
    assert.match(chip().textContent ?? "", /Model 89/);
  });

  it("presses on a model with the pointer", async () => {
    await mount(<ChatComposer />);
    const element = await open();
    await act(async () => element.querySelector<HTMLElement>('[data-model="anthropic/model-12"]')!.click());
    assert.equal(menu(), null);
    assert.match(chip().textContent ?? "", /Model 12/);
  });

  it("gives way to a sheet opened after it", async () => {
    await mount(<Page sheet={false} />);
    await open();
    await act(async () => root!.render(<div className="fy-prodwrap"><Page sheet /></div>));
    assert.equal(menu(), null, "the later sheet stands in front; the menu goes");
  });

  it("is drawn on a block drawer's dialog when the chip is inside one", async () => {
    await mount(<dialog open><ChatComposer /></dialog>);
    const element = await open();
    assert.equal(element.parentElement, container.querySelector("dialog"), "the body outside a modal dialog is inert");
  });
});
