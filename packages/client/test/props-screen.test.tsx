import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientMessage, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Props screen's creation box (design turn 105f; issue 1116): one mention cites one thing,
 * so a name whose slug another prop or a sheet holds is named as taken beside the box and never
 * sent — the coordinator refuses the same collision, silently.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

interface Mounted { container: HTMLElement; root: Root }
const open: Mounted[] = [];

async function mountState(state: ClientState): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/props`]}><App /></MemoryRouter>);
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

const capture = (sent: ClientMessage[]): ArkeBridge =>
  ({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) }) as unknown as ArkeBridge;
const reactProps = <T,>(element: Element): T => {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
};
const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    input.value = value;
    reactProps<{ onChange: (event: { target: HTMLInputElement }) => void }>(input).onChange({ target: input });
  });
};

describe("the Props screen keeps one mention to one thing (issue 1116)", () => {
  it("names what holds the word and sends nothing, then creates once the slug is free", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.props = [{ id: "prop_01J8P0000000000000000000P1", name: "Tea cup", states: [] }];
    const mounted = await mountState(state);
    const input = mounted.container.querySelector('input[aria-label="Prop name"]') as HTMLInputElement;
    const create = [...mounted.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create prop") as HTMLButtonElement;
    const note = () => mounted.container.querySelector('[data-testid="prop-name-check"]')?.textContent ?? null;

    assert.equal(create.disabled, true, "nothing typed yet");
    assert.equal(note(), null);
    await type(input, "Tea-cup");
    assert.equal(note(), "@tea-cup is Tea cup", "another prop already answers to the slug");
    assert.equal(create.disabled, true);
    await type(input, "maren kest");
    assert.equal(note(), "@maren-kest is Maren Kest", "a sheet's id is not a prop's to take");
    assert.equal(create.disabled, true);
    await type(input, "?!");
    assert.equal(note(), "Needs a letter or number");
    assert.equal(create.disabled, true);
    await type(input, "Ledger");
    assert.equal(note(), null);
    assert.equal(create.disabled, false);
    await act(async () => create.click());
    assert.deepEqual(sent, [{ kind: "create-prop", worldId: FIXTURE_WORLD_ID, name: "Ledger" }]);
    assert.equal(input.value, "Ledger", "the box keeps the name until the prop arrives — the coordinator's refusal is silent");
    // Another window took the word first: the refreshed snapshot holds a sheet, no prop arrives,
    // the name stays and the line says why.
    const taken = structuredClone(state) as ClientState;
    taken.world!.sheets = [...taken.world!.sheets, { ...taken.world!.sheets[0]!, id: "ledger", name: "Ledger" }];
    await act(async () => { __setStateForTest(taken); });
    assert.equal(input.value, "Ledger");
    assert.equal(note(), "@ledger is Ledger");
    assert.equal(create.disabled, true);
    // The prop arrives: the box clears for the next name.
    const arrived = structuredClone(state) as ClientState;
    arrived.world!.props = [...arrived.world!.props, { id: "prop_01J8P0000000000000000000P2", name: "Ledger", states: [] }];
    await act(async () => { __setStateForTest(arrived); });
    assert.equal(input.value, "");
    assert.equal(note(), null);
  });

  it("a record in conflict is loaded, and said so — not filed with the files that could not be read", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.problems = [
      { path: "canon/broken.md", message: "front matter: unexpected token" },
      { kind: "conflict", path: "references/prop_x/prop.json", message: 'prop "Tea-cup" answers to @tea-cup, as does "Tea cup" (references/prop_y/prop.json) — rename one; a mention cites one thing' },
    ];
    const mounted = await mountState(state);
    const callouts = [...mounted.container.querySelectorAll(".fy-worldconditions > *")].map((el) => el.textContent ?? "");
    const text = callouts.join("\n");
    assert.match(text, /1 file\(s\) could not be read/);
    assert.match(text, /1 record\(s\) say the same word/);
    const unreadable = callouts.find((entry) => entry.includes("could not be read"))!;
    assert.ok(unreadable.includes("canon/broken.md") && !unreadable.includes("prop.json"), "the conflict is not among the skipped files");
    const conflict = callouts.find((entry) => entry.includes("say the same word"))!;
    assert.ok(conflict.includes("references/prop_x/prop.json") && conflict.includes("Loaded, and in use until renamed"));
  });
});
