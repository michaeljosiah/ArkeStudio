import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientState, ModelInfo } from "@arke-studio/contracts";
import { Composer } from "../src/components/composer.js";
import { ModelChip } from "../src/components/model-chip.js";
import { filterGroups, formatDollars, matchSpan, modelCard, modelGroups, modelMatches, squash } from "../src/components/model-picker-data.js";
import { readRecentModels, rememberRecentModel } from "../src/lib/recent-models.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The model picker (design turn 195): search, the models in groups, a card for the one under the
 * pointer, the effort beside the chip. The positioning and closing rules are in
 * model-chip-menu.test.tsx; this is what the picker holds and how it answers. linkedom lays
 * nothing out, so boxes are set here as a window would report them.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1360, innerHeight: 820 });
const focusLog: Element[] = [];
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focusLog.at(-1) ?? null });
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

/** Whether the window is a phone's: `(max-width: 599px)` answers this. */
let phone = false;
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: phone && query.includes("599"), addEventListener() {}, removeEventListener() {} }),
});
/** Where the popover sits, so the card has a side to choose; set per test. */
let popover = { top: 150, bottom: 710, left: 918, width: 430, height: 560 };
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const box = this.classList.contains("fy-mchip__btn") ? { top: 760, bottom: 792, left: 1076, width: 130, height: 32 }
    : this.classList.contains("fy-mchip__menu") ? popover
    : this.classList.contains("fy-mchip__card") ? { top: 0, bottom: 260, left: 0, width: 270, height: 260 }
    : this.classList.contains("fy-mpick__row") ? { top: 400, bottom: 434, left: popover.left, width: 430, height: 34 }
    : { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
  return { ...box, x: box.left, y: box.top, right: box.left + box.width, toJSON() { return box; } } as DOMRect;
};

const MODELS: ModelInfo[] = [
  {
    id: "gpt-5.4", provider: "openai", providerName: "OpenAI", displayName: "GPT-5.4", reasoning: true, tools: true,
    inputModalities: ["text", "image"], inputTokenLimit: 400_000, cost: { inputPerMTok: 1.25, outputPerMTok: 10 },
    variants: { names: ["low", "medium", "high", "xhigh"], default: "medium" },
  },
  { id: "gpt-5.4-fast", provider: "openai", providerName: "OpenAI", displayName: "GPT-5.4 Fast" },
  { id: "claude-sonnet", provider: "anthropic", displayName: "Claude Sonnet 5.5" },
  { id: "claude-haiku", provider: "anthropic", displayName: "Claude Haiku 4.5", tools: false, inputModalities: ["text", "image"], inputTokenLimit: 200_000 },
  { id: "fledge", provider: "opencode", providerName: "OpenCode Zen", displayName: "Fledge Alpha Free", isDefault: true, cost: { inputPerMTok: 0, outputPerMTok: 0 } },
  { id: "mystery", provider: "mystery-co", displayName: "Mystery" },
];

function state(patch: Partial<ClientState["app"]> = {}): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
      harnessModelStatus: { status: "ready" },
      harnessInfo: { generation: "v2", source: "path", version: "2.0.0", beta: false },
      harnessModels: MODELS,
      ...patch,
    },
  };
}

type Chip = Partial<Parameters<typeof ModelChip>[0]>;
function Holder({ chip, start = "openai/gpt-5.4" }: { chip?: Chip; start?: string | undefined }) {
  const [value, setValue] = useState<string | undefined>(start);
  const [variant, setVariant] = useState<string | undefined>();
  return <Composer value="" onChange={() => {}} onSubmit={() => {}} placeholder="Say something"
    modelControl={<ModelChip state={state()} value={value} set={false} onPick={setValue} variant={variant} onVariant={setVariant} {...chip} />} />;
}
function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

let root: Root | undefined;
let container: HTMLDivElement;
async function mount(children: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter>{children}<Where /></MemoryRouter>));
}
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) },
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  focusLog.length = 0;
  popover = { top: 150, bottom: 710, left: 918, width: 430, height: 560 };
  phone = false;
  Reflect.deleteProperty(globalThis, "localStorage");
});

const chips = () => [...container.querySelectorAll<HTMLButtonElement>(".fy-cx__bar button.fy-mchip__btn")];
const chip = () => chips()[0]!;
const menu = () => document.querySelector<HTMLElement>(".fy-mchip__menu:not(.fy-mchip__menu--effort), .fy-msheet");
const search = () => menu()!.querySelector<HTMLInputElement>("input")!;
const options = () => [...menu()!.querySelectorAll<HTMLElement>("[role=option]")];
const names = () => options().map((option) => option.querySelector(".fy-mpick__name")?.textContent);
/** A heading's words, without its mark's letter. */
const headings = () => [...menu()!.querySelectorAll(".fy-mpick__grp")].map((heading) => heading.lastChild?.textContent);
const card = () => document.querySelector<HTMLElement>(".fy-mchip__card");
async function open() {
  await act(async () => chip().click());
  assert.ok(menu(), "the picker opened");
}
function reactProps<T>(target: Element): T {
  return (target as unknown as Record<string, T>)[Object.keys(target).find((candidate) => candidate.startsWith("__reactProps$"))!]!;
}
/** React's input polyfill rejects a native key or input at an input nothing focused (linkedom), so the handler React holds is called. */
async function type(text: string) {
  await act(async () => {
    const input = search();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    reactProps<{ onChange: (event: unknown) => void }>(input).onChange({ target: input, currentTarget: input });
  });
}
async function typeKey(name: string) {
  await act(async () => reactProps<{ onKeyDown: (event: unknown) => void }>(search()).onKeyDown({ key: name, preventDefault() {}, stopPropagation() {} }));
}
const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
async function hover(option: Element) {
  await act(async () => void option.dispatchEvent(new dom.Event("mousemove", { bubbles: true }) as unknown as Event));
}

describe("the picker's groups", () => {
  it("lists providers in the harness's order, named as the harness names them, with the count and the default", async () => {
    await mount(<Holder />);
    await open();
    assert.deepEqual(headings(), ["OpenAI", "Anthropic", "OpenCode Zen", "mystery-co"], "the harness's name, else Arke's, else the id");
    assert.deepEqual(names(), ["GPT-5.4", "GPT-5.4 Fast", "Claude Sonnet 5.5", "Claude Haiku 4.5", "Fledge Alpha Free", "Mystery"], "the harness's order within a group, the default not moved");
    assert.equal(menu()!.querySelector(".fy-mpick__count")!.textContent, "6");
    assert.equal(options().find((option) => option.getAttribute("data-model") === "opencode/fledge")!.querySelector(".fy-mpick__tag")?.textContent, "default");
    assert.equal(options().find((option) => option.getAttribute("data-model") === "openai/gpt-5.4")!.getAttribute("aria-selected"), "true", "the current model is ticked");
    assert.equal(menu()!.querySelectorAll(".fy-mpick__row svg").length, 1, "and only it");
    assert.equal(menu()!.querySelector(".fy-mpick__list")!.getAttribute("role"), "listbox");
  });

  it("draws the provider's mark in the chip and beside each group", async () => {
    await mount(<Holder />);
    assert.equal(chip().querySelector(".fy-mark")?.textContent, "O", "the letter where Arke has no logo");
    await open();
    assert.equal(menu()!.querySelectorAll(".fy-mpick__grp .fy-mark").length, 4);
    assert.ok(chip().querySelector(".fy-mchip__name"));
  });

  it("keeps a remembered choice the catalogue lost at the top, ticked and unpickable", async () => {
    await mount(<Holder start="old/removed" />);
    await open();
    const first = options()[0]!;
    assert.equal(first.getAttribute("data-model"), "old/removed");
    assert.equal(first.getAttribute("aria-selected"), "true");
    assert.equal(first.getAttribute("aria-disabled"), "true");
    assert.equal(first.querySelector(".fy-mpick__tag")?.textContent, "unavailable");
    assert.equal(chip().querySelector(".fy-mark"), null, "no mark for a model the catalogue lacks");
  });

  it("offers letting go of this chat's own choice first, and only while there is one", async () => {
    await mount(<Holder chip={{ set: true, unsetLabel: "Use the saved choice" }} />);
    await open();
    assert.equal(options()[0]!.textContent, "Use the saved choice");
    assert.ok(options()[0]!.className.includes("fy-mpick__row--quiet"));
  });
});

describe("Recent", () => {
  it("holds the last three picked, newest first, only those still listed, and is hidden while searching", async () => {
    for (const reference of ["opencode/fledge", "gone/model", "anthropic/claude-sonnet", "openai/gpt-5.4-fast", "anthropic/claude-haiku"]) rememberRecentModel(reference);
    assert.deepEqual(readRecentModels(), ["anthropic/claude-haiku", "openai/gpt-5.4-fast", "anthropic/claude-sonnet"], "three, newest first");
    await mount(<Holder />);
    await open();
    assert.equal(headings()[0], "Recent");
    const recent = [...menu()!.querySelectorAll("[role=group]")][0]!;
    assert.deepEqual([...recent.querySelectorAll(".fy-mpick__name")].map((name) => name.textContent), ["Claude Haiku 4.5", "GPT-5.4 Fast", "Claude Sonnet 5.5"]);
    await type("gpt");
    assert.equal(headings().includes("Recent"), false);
  });

  it("is absent until something has been picked, and a pick joins it", async () => {
    await mount(<Holder />);
    await open();
    assert.equal(headings().includes("Recent"), false);
    await act(async () => options().find((option) => option.getAttribute("data-model") === "openai/gpt-5.4-fast")!.click());
    assert.deepEqual(readRecentModels(), ["openai/gpt-5.4-fast"]);
    await open();
    assert.equal(headings()[0], "Recent");
  });

  it("works with storage that refuses", async () => {
    Object.assign(globalThis, { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    rememberRecentModel("openai/gpt-5.4");
    assert.deepEqual(readRecentModels(), []);
    await mount(<Holder />);
    await open();
    assert.equal(options().length, 6);
  });
});

describe("search", () => {
  it("filters across groups on name, id and provider, ignoring case, spaces and punctuation, and counts", async () => {
    await mount(<Holder />);
    await open();
    await type("gpt5");
    assert.deepEqual(headings(), ["OpenAI"]);
    assert.deepEqual(names(), ["GPT-5.4", "GPT-5.4 Fast"]);
    assert.equal(menu()!.querySelector(".fy-mpick__count")!.textContent, "2 of 6");
    await type("ZEN");
    assert.deepEqual(names(), ["Fledge Alpha Free"], "the provider's name matches");
    await type("claude haiku");
    assert.deepEqual(names(), ["Claude Haiku 4.5"], "a space in the query is nothing");
    await type("mystery-co");
    assert.deepEqual(names(), ["Mystery"], "the id of a private provider");
  });

  it("sets the matched letters in bold", async () => {
    await mount(<Holder />);
    await open();
    await type("gpt5");
    assert.equal(options()[0]!.querySelector("b")?.textContent, "GPT-5");
    await type("zen");
    assert.equal(options()[0]!.querySelector("b"), null, "a match on the provider marks no letters of the name");
  });

  it("says No model matches, and keeps the query", async () => {
    await mount(<Holder />);
    await open();
    await type("zzzz");
    assert.equal(options().length, 0);
    assert.equal(menu()!.querySelector(".fy-mpick__empty")?.textContent, "No model matches");
    assert.equal(search().value, "zzzz");
    assert.equal(menu()!.querySelector(".fy-mpick__count")!.textContent, "0 of 6");
  });

  it("lands on the first match, and Enter picks it", async () => {
    await mount(<Holder />);
    await open();
    await type("fast");
    await typeKey("Enter");
    assert.equal(menu(), null);
    assert.match(chip().textContent ?? "", /GPT-5\.4 Fast/);
  });

  it("clears on the first Escape and closes on the second", async () => {
    await mount(<Holder />);
    await open();
    await type("gpt");
    const escape = () => { const event = new dom.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string }; event.key = "Escape"; menu()!.dispatchEvent(event); };
    await act(async () => escape());
    assert.ok(menu(), "the first Escape clears the search");
    assert.equal(search().value, "");
    assert.equal(options().length, 6);
    await act(async () => escape());
    assert.equal(menu(), null);
  });

  it("the data helpers agree", () => {
    assert.equal(squash("GPT-5.4 Fast"), "gpt54fast");
    assert.deepEqual(matchSpan("GPT-5.4", "gpt5"), [0, 5]);
    assert.equal(matchSpan("GPT-5.4", "zzz"), null);
    assert.equal(matchSpan("GPT-5.4", " "), null);
    const groups = modelGroups(state(), MODELS, false, false);
    assert.equal(filterGroups(groups, "").length, 4);
    assert.equal(modelMatches(groups[0]!.models[0]!, "OpenAI", "openai"), true);
    assert.equal(modelMatches(groups[0]!.models[0]!, "OpenAI", "anthropic"), false);
  });
});

describe("a model that cannot be used", () => {
  const tools = { needsTools: true };

  it("is struck, cannot be picked and is skipped by the arrow keys; its reason is on its card, first", async () => {
    await mount(<Holder start="anthropic/claude-sonnet" chip={tools} />);
    await open();
    const haiku = options().find((option) => option.getAttribute("data-model") === "anthropic/claude-haiku")!;
    assert.ok(haiku.className.includes("fy-mpick__row--off"));
    assert.equal(haiku.getAttribute("aria-disabled"), "true");
    assert.doesNotMatch(haiku.textContent ?? "", /cannot use tools/, "the reason is no longer printed in the row");
    await act(async () => haiku.click());
    assert.ok(menu(), "pressing it picks nothing");
    // From Claude Sonnet 5.5 the next usable row is Fledge, not the struck Haiku between them.
    await typeKey("ArrowDown");
    assert.equal(document.getElementById(search().getAttribute("aria-activedescendant")!)?.getAttribute("data-model"), "opencode/fledge");
    // The pointer may still rest on it: its card says why.
    await hover(haiku);
    await pause(350);
    assert.equal(card()?.querySelector(".fy-mchip__why")?.textContent, "Cannot use tools");
    assert.equal(card()?.firstElementChild, card()?.querySelector(".fy-mchip__why"), "the reason is the card's first line");
    assert.equal(card()?.querySelector(".fy-mchip__card-name")?.textContent, "Claude Haiku 4.5");
    assert.deepEqual([...card()!.querySelectorAll(".fy-mchip__card-row b")].map((label) => label.textContent), ["Provider", "Inputs", "Context", "Tools"]);
  });

  it("lists every model and picks none while the catalogue is not one the harness has confirmed", async () => {
    await mount(<Holder chip={{ state: state({ harnessModelStatus: { status: "error", reason: "Discovery failed." } }) }} />);
    await open();
    assert.equal(options().filter((option) => option.getAttribute("aria-disabled") === "true").length, 6);
    assert.equal(menu()!.querySelector(".fy-mpick__row--off"), null, "nothing is struck: nothing is known against them");
    assert.equal(chip().disabled, false, "the chip stays open to use, so a saved choice can be let go of");
  });
});

describe("the card", () => {
  it("shows only the rows the harness stated, after a pause for the pointer and at once for the keyboard", async () => {
    await mount(<Holder />);
    await open();
    assert.equal(card(), null, "none until something is under the pointer");
    const first = options().find((option) => option.getAttribute("data-model") === "openai/gpt-5.4")!;
    await hover(first);
    assert.equal(card(), null, "not yet: the pointer is passing");
    await pause(350);
    assert.ok(card());
    assert.deepEqual([...card()!.querySelectorAll(".fy-mchip__card-row")].map((row) => [row.querySelector("b")!.textContent, row.querySelector("span")!.textContent]), [
      ["Provider", "OpenAI"], ["Inputs", "Text, image"], ["Reasoning", "Allows reasoning"], ["Context", "400,000 tokens"], ["Tools", "Yes"],
      ["Price", "$1.25 in · $10 out per M"],
    ]);
    assert.equal(card()!.querySelector(".fy-mchip__card-ref")?.textContent, "openai/gpt-5.4");
    await typeKey("ArrowDown");
    assert.equal(card()?.querySelector(".fy-mchip__card-name")?.textContent, "GPT-5.4 Fast", "the keyboard needs no pause");
    assert.deepEqual([...card()!.querySelectorAll(".fy-mchip__card-row b")].map((label) => label.textContent), ["Provider"], "a row with nothing known is left out");
  });

  it("is 270 wide on the side with room: left of a list at the window's right edge, else right", async () => {
    await mount(<Holder />);
    await open();
    await hover(options()[0]!);
    await pause(350);
    assert.equal(card()!.getAttribute("data-side"), "left");
    assert.equal(card()!.style.left, `${918 - 12 - 270}px`);
    await act(async () => document.querySelector<HTMLElement>(".fy-mchip__menu")!.dispatchEvent(new dom.Event("mouseleave") as unknown as Event));
    popover = { top: 150, bottom: 710, left: 60, width: 430, height: 560 };
    await act(async () => window.dispatchEvent(new dom.Event("resize") as unknown as Event));
    await hover(options()[1]!);
    await pause(350);
    assert.equal(card()!.getAttribute("data-side"), "right");
    assert.equal(card()!.style.left, `${60 + 430 + 12}px`);
  });

  it("prices a free model as Free and writes a price as stated", () => {
    assert.equal(modelCard({ model: MODELS[4]!, ref: "opencode/fledge", label: "Fledge", locked: false }, "OpenCode Zen").rows.at(-1)!.value, "Free");
    assert.equal(formatDollars(10), "$10");
    assert.equal(formatDollars(1.25), "$1.25");
    assert.equal(formatDollars(0.3), "$0.30");
    assert.equal(formatDollars(0.075), "$0.075");
  });
});

describe("the effort", () => {
  it("is a second chip, only for a model that declares variants, named in plain words", async () => {
    await mount(<Holder />);
    assert.equal(chips().length, 2);
    assert.equal(chips()[1]!.textContent, "Medium", "the harness's default, in plain words");
    await act(async () => chips()[1]!.click());
    const effort = document.querySelector<HTMLElement>(".fy-mchip__menu--effort")!;
    assert.equal(effort.querySelector(".fy-mpick__grp")!.textContent, "Effort");
    assert.deepEqual([...effort.querySelectorAll("button")].map((button) => button.textContent), ["Low", "Medium", "High", "Highest"]);
    assert.equal(effort.querySelector("button[aria-checked=true]")!.textContent, "Medium");
    await act(async () => [...effort.querySelectorAll("button")].find((button) => button.textContent === "Highest")!.click());
    assert.equal(document.querySelector(".fy-mchip__menu--effort"), null);
    assert.equal(chips()[1]!.textContent, "Highest");
  });

  it("is absent for a model without variants, and where the host cannot keep an effort", async () => {
    await mount(<Holder start="anthropic/claude-sonnet" />);
    assert.equal(chips().length, 1);
    await act(async () => root!.unmount());
    root = undefined;
    container.remove();
    await mount(<Holder chip={{ onVariant: undefined }} />);
    assert.equal(chips().length, 1, "founding chat and setup have nowhere to keep an effort");
  });

  it("says Effort while the harness states no default and nothing is chosen", async () => {
    const bare = MODELS.map((model) => model.id === "gpt-5.4" ? { ...model, variants: { names: ["low", "high"] } } : model);
    await mount(<Holder chip={{ state: state({ harnessModels: bare }) }} />);
    assert.equal(chips()[1]!.textContent, "Effort");
  });

  it("names a variant Arke has no word for as it comes, title-cased", async () => {
    const odd = MODELS.map((model) => model.id === "gpt-5.4" ? { ...model, variants: { names: ["low", "deep-think"] } } : model);
    await mount(<Holder chip={{ state: state({ harnessModels: odd }), variant: "deep-think" }} />);
    assert.equal(chips()[1]!.textContent, "Deep Think");
  });
});

describe("the chip", () => {
  it("is disabled, its tip Checking models, while the catalogue loads", async () => {
    await mount(<Holder chip={{ state: state({ harnessModelStatus: { status: "loading" } }) }} />);
    assert.equal(chip().disabled, true);
    assert.equal(chip().getAttribute("title"), "Checking models");
    await act(async () => root!.unmount());
    container.remove();
    await mount(<Holder chip={{ state: state({ health: { ...FIXTURE_STATE.app.health, harness: { status: "starting" } } }) }} />);
    assert.equal(chip().disabled, true, "and while the harness is starting");
  });

  it("carries the dot when the choice is this chat's own, before the mark", async () => {
    await mount(<Holder chip={{ set: true }} />);
    assert.ok(chip().className.includes("fy-mchip__btn--set"));
  });

  it("opens Settings at AI models from the foot", async () => {
    await mount(<Holder />);
    await open();
    const manage = [...menu()!.querySelectorAll<HTMLButtonElement>(".fy-mpick__foot button")].find((button) => /Manage models/.test(button.textContent ?? ""))!;
    await act(async () => manage.click());
    assert.equal(menu(), null);
    assert.equal(container.querySelector("output")!.textContent, "/settings/models");
  });

  it("keeps the foot's quiet presses where the host can use them", async () => {
    let remembered = 0;
    await mount(<Holder chip={{ onRemember: () => { remembered++; }, onClear: () => {} }} />);
    await open();
    assert.deepEqual([...menu()!.querySelectorAll(".fy-mpick__foot button")].map((button) => button.textContent), ["Manage models", "Every chat in this production", "Clear the production’s choice"]);
    await act(async () => [...menu()!.querySelectorAll<HTMLButtonElement>(".fy-mpick__foot button")][1]!.click());
    assert.equal(remembered, 1);
    assert.equal(menu(), null);
  });

  it("leaves the picker when Tab leaves the foot, so Tab lands after the chip", async () => {
    await mount(<Holder />);
    await open();
    const foot = [...menu()!.querySelectorAll<HTMLButtonElement>(".fy-mpick__foot button")];
    focusLog.push(foot.at(-1)!);
    const tab = new dom.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string; shiftKey: boolean };
    tab.key = "Tab";
    tab.shiftKey = false;
    await act(async () => void foot.at(-1)!.dispatchEvent(tab as unknown as Event));
    assert.equal(menu(), null);
    assert.equal(focusLog.at(-1), chip());
  });
});

describe("on a phone, the picker is a bottom sheet", () => {
  const sheet = () => document.querySelector<HTMLElement>(".fy-msheet");
  async function openSheet() {
    phone = true;
    await mount(<Holder />);
    await act(async () => chip().click());
    assert.ok(sheet(), "the sheet opened");
    return sheet()!;
  }

  it("opens as a sheet over a scrim, not a popover, with a grab, Model and the effort in its head", async () => {
    const element = await openSheet();
    assert.equal(document.querySelector(".fy-mchip__menu"), null, "no popover");
    assert.equal(element.parentElement, document.body);
    assert.ok(document.querySelector(".fy-msheet__scrim"));
    assert.ok(element.querySelector(".fy-mpick__grab"));
    assert.equal(element.querySelector(".fy-msheet__head span")!.textContent, "Model");
    assert.equal(element.querySelector(".fy-msheet__head .fy-mchip__btn--effort")!.textContent, "Medium");
    assert.equal(element.querySelector(".fy-mpick__count")!.textContent, "6");
    assert.deepEqual(headings(), ["OpenAI", "Anthropic", "OpenCode Zen", "mystery-co"].map((name) => name), "the same groups");
  });

  it("does not take focus for the search: the keyboard waits for a press", async () => {
    const element = await openSheet();
    assert.equal(focusLog.at(-1), element, "the sheet itself holds focus");
    assert.notEqual(focusLog.at(-1), element.querySelector("input"));
  });

  it("opens a row's facts in place from its info press, and does not pick", async () => {
    const element = await openSheet();
    const info = element.querySelector<HTMLButtonElement>('button[aria-label="Details for GPT-5.4"]');
    assert.ok(info, "a model with facts has the press");
    assert.equal(element.querySelector('button[aria-label="Details for GPT-5.4 Fast"]'), null, "a model with nothing known has none");
    assert.equal(element.querySelector(".fy-mpick__det"), null);
    await act(async () => info.click());
    assert.ok(sheet(), "pressing it picks nothing");
    assert.equal(info.getAttribute("aria-expanded"), "true");
    const rows = [...element.querySelectorAll(".fy-mpick__det .fy-mpick__det-row")].map((row) => [row.querySelector("b")!.textContent, row.querySelector("span")!.textContent]);
    assert.deepEqual(rows, [["Inputs", "Text, image"], ["Reasoning", "Allows reasoning"], ["Context", "400,000 tokens"], ["Price", "$1.25 in · $10 out per M"]], "the card, without the provider the group names and the tools");
    await act(async () => info.click());
    assert.equal(element.querySelector(".fy-mpick__det"), null, "pressing again closes it");
  });

  it("says a struck model's reason under its name, since there is no hover", async () => {
    phone = true;
    await mount(<Holder start="anthropic/claude-sonnet" chip={{ needsTools: true }} />);
    await act(async () => chip().click());
    const haiku = sheet()!.querySelector<HTMLElement>('[data-model="anthropic/claude-haiku"]')!;
    assert.equal(haiku.querySelector(".fy-mpick__reason")?.textContent, "cannot use tools");
    assert.ok(haiku.className.includes("fy-mpick__row--reason"));
    assert.equal(sheet()!.querySelector('button[aria-label="Details for Claude Haiku 4.5"]'), null);
    await act(async () => void haiku.dispatchEvent(new dom.Event("mousemove", { bubbles: true }) as unknown as Event));
    await pause(350);
    assert.equal(card(), null, "there is no hover card on a phone");
  });

  it("picking closes the sheet, as a press on the scrim and Escape do", async () => {
    await openSheet();
    await act(async () => options().find((option) => option.getAttribute("data-model") === "openai/gpt-5.4-fast")!.click());
    assert.equal(sheet(), null);
    assert.match(chip().textContent ?? "", /GPT-5\.4 Fast/);
    await act(async () => chip().click());
    assert.ok(sheet());
    await act(async () => void document.querySelector(".fy-msheet__scrim")!.dispatchEvent(new dom.Event("mousedown", { bubbles: true }) as unknown as Event));
    assert.equal(sheet(), null, "a press on the scrim");
    await act(async () => chip().click());
    const escape = new dom.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
    escape.key = "Escape";
    await act(async () => void sheet()!.dispatchEvent(escape as unknown as Event));
    assert.equal(sheet(), null, "Escape");
  });

  it("opens the effort menu over the sheet, and Escape closes that first", async () => {
    const element = await openSheet();
    const effort = element.querySelector<HTMLButtonElement>(".fy-msheet__head .fy-mchip__btn--effort")!;
    await act(async () => effort.click());
    const over = document.querySelector<HTMLElement>(".fy-mchip__menu--effort");
    assert.ok(over, "the effort menu is drawn over the sheet");
    assert.ok(sheet(), "the sheet stays");
    const escape = new dom.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
    escape.key = "Escape";
    await act(async () => void over.dispatchEvent(escape as unknown as Event));
    assert.equal(document.querySelector(".fy-mchip__menu--effort"), null);
    assert.ok(sheet(), "the sheet is still there after the menu goes");
    await act(async () => effort.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".fy-mchip__menu--effort button")].find((button) => button.textContent === "High")!.click());
    assert.equal(document.querySelector(".fy-mchip__menu--effort"), null);
    assert.equal(effort.textContent, "High", "chosen from the sheet's own chip");
  });

  it("keeps the same foot", async () => {
    const element = await openSheet();
    assert.deepEqual([...element.querySelectorAll(".fy-mpick__foot button")].map((button) => button.textContent), ["Manage models"]);
  });
});

describe("World Chat's named model", () => {
  it("stays a muted label with no mark, menu or effort, and its tip says where it is chosen", async () => {
    await mount(<Holder chip={{ readOnly: true }} />);
    const label = container.querySelector<HTMLElement>(".fy-mchip__btn--fixed")!;
    assert.ok(label);
    assert.equal(container.querySelector(".fy-mchip__btn--fixed .fy-mark"), null);
    assert.equal(container.querySelectorAll(".fy-mchip svg").length, 0, "no chevron");
    assert.equal(chips().length, 0, "nothing to press");
    assert.equal(document.querySelector(".fy-mchip__tip"), null);
    await act(async () => void label.dispatchEvent(new dom.Event("focusin", { bubbles: true }) as unknown as Event));
    assert.equal(document.querySelector(".fy-mchip__tip")?.textContent, "Chosen in Settings", "on focus");
    assert.equal(document.querySelector(".fy-mchip__tip")?.parentElement, document.body, "drawn on the body, out of the composer's clip");
    await act(async () => void label.dispatchEvent(new dom.Event("focusout", { bubbles: true }) as unknown as Event));
    assert.equal(document.querySelector(".fy-mchip__tip"), null);
  });
});
