import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { applyTimelineCommands, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The legacy addresses land in the editor (SPEC-039 R-1, T-5, A-1): Audio opens `/cut` on the
 * Library's audio filter, Exports opens `/cut` with the export sheet up, and a `/cut` deep link
 * still opens the editor. Mounted through the real App so the redirect is the one that ships.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
  // sonner's Toaster reads the document direction on render once a window exists.
  getComputedStyle: () => ({ direction: "ltr", getPropertyValue: () => "" }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.window.KeyboardEvent ?? dom.Event,
  getComputedStyle: () => ({ direction: "ltr", getPropertyValue: () => "" }),
  IS_REACT_ACT_ENVIRONMENT: true,
});

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

function bridge(sent: ClientMessage[]) {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>;
}

/** A saved timeline with the bells in the Library, so the audio filter has a row to show. */
function readyState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seedStoryPictureTimeline(production), [
      { kind: "add-to-library", items: [{ kind: "artifact", artifactId: "ar_01J8G0000000000000000000R1" }] },
    ]),
  };
  return state;
}

async function mount(path: string): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(readyState());
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
  return { container, root, sent };
}

async function close(screen: Mounted): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

const state = FIXTURE_STATE as ClientState;
const base = `/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}`;

describe("the editor's addresses (SPEC-039 A-1)", () => {
  it("a /cut deep link opens the editor", async () => {
    const screen = await mount(`${base}/cut`);
    try {
      assert.ok(screen.container.querySelector("#cut-library"), "the Library is on screen");
      assert.ok(screen.container.querySelector(".fy-timeline__toolbar"), "the timeline is on screen");
    } finally {
      await close(screen);
    }
  });

  it("Audio lands in the editor on the audio filter, without looping", async () => {
    const screen = await mount(`${base}/audio`);
    try {
      const audio = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].find((button) => button.textContent === "Audio");
      assert.ok(audio, "the Library is on screen with its filters");
      assert.equal(audio.getAttribute("aria-pressed"), "true");
      assert.ok(screen.container.querySelector('[data-library-item="artifact:ar_01J8G0000000000000000000R1"]'), "the audio row is listed");
    } finally {
      await close(screen);
    }
  });

  it("Exports lands in the editor with the export sheet up", async () => {
    const screen = await mount(`${base}/exports`);
    try {
      assert.ok(screen.container.querySelector('[data-testid="export-sheet"]'), "the sheet is open");
      assert.ok(screen.container.querySelector(".fy-timeline__toolbar"), "the editor is behind it");
    } finally {
      await close(screen);
    }
  });
});
