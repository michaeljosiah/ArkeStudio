import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ArkeBridge } from "../src/arke-bridge.js";
import type { ClientMessage, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A character's short name is edited on the sheet with its name (design turn 194, rule 12b): a
 * field with the default as its placeholder, written through the rename, and only for a character.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const WORLD_ID = FIXTURE_STATE.world!.meta.worldId;

async function mount(path: string, state: ClientState) {
  __setStateForTest(state, { connection: "open" });
  const messages: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => messages.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return { container, root, messages };
}
async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
  __setBridgeForTest(null);
}
const labelled = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"));
    (input as unknown as Record<string, { onChange?: (event: { target: unknown; currentTarget: unknown }) => void }>)[key!]?.onChange?.({ target: input, currentTarget: input });
  });
}

describe("a character's short name on the sheet", () => {
  it("is a field beside the name, the default its placeholder, written through the rename and left alone when untouched", async () => {
    const { container, root, messages } = await mount(`/w/${WORLD_ID}/cast/maren-kest`, FIXTURE_STATE);
    assert.ok(container.querySelector('[data-testid="sheet-short-name"]') === null, "closed until Rename is pressed");
    await act(async () => labelled(container, "Rename")!.click());
    const field = container.querySelector<HTMLInputElement>('[data-testid="sheet-short-name"]');
    assert.ok(field !== null, "a character's rename form holds it");
    assert.equal(field.getAttribute("placeholder"), "Maren", "the default is the first word of the name");
    const save = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Rename")!;
    assert.ok(save().disabled, "nothing changed, nothing to save");
    await typeInto(field, "  Mare ");
    assert.ok(!save().disabled);
    await act(async () => save().click());
    const sent = messages.findLast((message) => message.kind === "rename-sheet") as Extract<ClientMessage, { kind: "rename-sheet" }>;
    assert.deepEqual({ name: sent.name, shortName: sent.shortName }, { name: "Maren Kest", shortName: "Mare" });
    await unmount(root, container);
  });

  it("is not offered on a place", async () => {
    const { container, root } = await mount(`/w/${WORLD_ID}/locations/the-vigil`, FIXTURE_STATE);
    await act(async () => labelled(container, "Rename")!.click());
    assert.ok(container.querySelector('[data-testid="sheet-short-name"]') === null);
    await unmount(root, container);
  });
});
