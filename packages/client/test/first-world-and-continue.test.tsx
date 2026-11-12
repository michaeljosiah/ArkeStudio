import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ArkeBridge } from "../src/arke-bridge.js";
import type { ClientMessage, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The paths people take when they start or come back (issue 2777): Continue opened the first
 * production by name rather than the one worked on last, a refused first world said nothing in
 * Form mode, and a first character typed without the separator was dropped.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(dom.HTMLElement.prototype, { scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const WORLD = FIXTURE_STATE.world!;
const SALTLIGHT = WORLD.productions[0]!;

describe("Continue on the world overview", () => {
  const continueTitle = (amberlineUpdated: string): string | undefined => {
    // The list arrives in name order, so the older one sorting first is the case that went wrong.
    const amberline = { ...SALTLIGHT, meta: { ...SALTLIGHT.meta, id: "amberline", title: "Amberline", updated: amberlineUpdated } };
    __setStateForTest({ ...FIXTURE_STATE, world: { ...WORLD, productions: [amberline, SALTLIGHT] } });
    try {
      const html = renderToString(<MemoryRouter initialEntries={[`/w/${WORLD.meta.worldId}`]}><App /></MemoryRouter>);
      return /fy-cta__title">Continue (?:<!-- -->)?([^<]+)</.exec(html)?.[1];
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  };

  it("names the production changed most recently, not the first by name", () => {
    assert.equal(continueTitle("2026-01-01T00:00:00Z"), "Saltlight");
    assert.equal(continueTitle("2026-08-01T00:00:00Z"), "Amberline");
  });
});

describe("the first-world form", () => {
  const GENESIS = "gen-first-world-2777";
  // With no harness the form is the front door; the conversation replaces it otherwise.
  const formState: ClientState = {
    ...FIXTURE_STATE,
    world: null,
    app: { ...FIXTURE_STATE.app, health: { ...FIXTURE_STATE.app.health, harness: { status: "unavailable", reason: "not configured" } } },
  };

  async function mount() {
    __setStateForTest(formState, { connection: "open" });
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={[`/worlds/new?draft=${GENESIS}`]}><App /></MemoryRouter>));
    const press = async (label: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
      assert.ok(button, `${label} is on screen`);
      await act(async () => button.click());
    };
    const type = async (label: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
        const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"))!;
        (input as unknown as Record<string, { onChange: (event: { target: unknown; currentTarget: unknown }) => void }>)[key]!.onChange({ target: input, currentTarget: input });
      });
    };
    const unmount = async () => {
      await act(async () => root.unmount());
      container.remove();
      __setBridgeForTest(null);
      __setStateForTest(FIXTURE_STATE);
    };
    return { container, sent, press, type, unmount };
  }

  it("shows a refused creation where it was pressed: on the look screen and in the form", async () => {
    const m = await mount();
    try {
      await m.type("What this world is called", "Saltmarsh");
      await m.press("Begin in this world");
      await m.press("Decide later");
      assert.ok(m.sent.some((message) => message.kind === "create-world"), "the form asked for the world");
      await act(async () => __applyEventForTest({ type: "genesis.status", at: "2026-11-08T10:00:00.000Z", genesisId: GENESIS, status: "failed", detail: "A world named Saltmarsh already exists." }));
      assert.match(m.container.textContent ?? "", /The conversation needs attention/, "the look screen says it was refused");
      assert.match(m.container.textContent ?? "", /A world named Saltmarsh already exists\./);
      await m.press("Back to form");
      assert.ok(m.container.querySelector('input[aria-label="What this world is called"]'), "back on the form");
      assert.match(m.container.textContent ?? "", /A world named Saltmarsh already exists\./, "and the form says so too");
    } finally {
      await m.unmount();
    }
  });

  it("keeps a first character typed without the separator", async () => {
    const m = await mount();
    try {
      await m.type("What this world is called", "Saltmarsh");
      await m.type("Their name · one line about them", "Maren Kest");
      await m.press("Begin in this world");
      await m.press("Decide later");
      // The world opens under the name it was asked for, and the form seeds its first sheets.
      await act(async () => __setStateForTest({ ...formState, world: { ...WORLD, meta: { ...WORLD.meta, name: "Saltmarsh" } } }));
      const seeded = m.sent.filter((message): message is Extract<ClientMessage, { kind: "create-sheet-from-sentence" }> => message.kind === "create-sheet-from-sentence");
      assert.deepEqual(seeded.map((message) => [message.sheetType, message.name, message.sentence]), [["character", "Maren Kest", "Maren Kest"]]);
    } finally {
      await m.unmount();
    }
  });
});
