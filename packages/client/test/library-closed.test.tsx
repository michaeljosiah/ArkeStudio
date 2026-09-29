import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { applyTimelineCommands, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The closed Library does no row work (issue 1157).
 *
 * Below the shell's breakpoint the Library is a drawer the CSS keeps off screen until it is
 * opened. The panel used to build, filter and render every row regardless, on every render of a
 * screen the transport re-renders four times a second. Closed now means the shell alone — the
 * element the toggle focuses into and controls — while the panel's own state survives, so
 * reopening finds the search and the filters as they were left. Above the breakpoint the column
 * is always shown and `open` is not consulted; crossing the breakpoint is itself a render.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
let viewportWidth = 800;
const mediaListeners = new Set<() => void>();
/** A stub that answers `max-width` queries from the viewport and can be told the window resized. */
Object.assign(dom.window, {
  matchMedia: (query: string) => ({
    get matches() {
      return viewportWidth <= Number.parseInt(query.match(/max-width:\s*(\d+)px/)?.[1] ?? "0", 10);
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

async function resizeTo(width: number): Promise<void> {
  viewportWidth = width;
  await act(async () => {
    for (const listener of mediaListeners) listener();
  });
}

interface Mounted {
  container: HTMLElement;
  root: Root;
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

/** Every row the fixture lists once its two shots are in the Library: the shots, one shot's spoken line, the bells. */
const ALL_ROWS = ["shot:sh_12", "shot:sh_13", "line:sh_12", "artifact:ar_01J8G0000000000000000000R1"];

/** The story's two shots on a saved timeline and in the Library: rows to draw, or not. */
function libraryState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seedStoryPictureTimeline(production), [
      { kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_12" }, { kind: "shot", shotId: "sh_13" }] },
    ]),
  };
  return state;
}

async function mount(state: ClientState): Promise<Mounted> {
  __setBridgeForTest(bridge([]));
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

async function close(screen: Mounted): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function panel(screen: Mounted): HTMLElement {
  const found = screen.container.querySelector<HTMLElement>("#cut-library");
  assert.ok(found, "the Library's shell is always in the document");
  return found;
}

function rows(screen: Mounted): string[] {
  return [...panel(screen).querySelectorAll<HTMLElement>("[data-library-item]")].map((row) => row.dataset["libraryItem"]!);
}

async function toggleLibrary(screen: Mounted): Promise<void> {
  const toggle = screen.container.querySelector<HTMLButtonElement>(".fy-editorpane-toggle--library");
  assert.ok(toggle);
  await act(async () => toggle.click());
}

/** Type into the controlled search the way `library.test.tsx` does: the setter, then React's own handler. */
async function search(screen: Mounted, value: string): Promise<void> {
  const input = panel(screen).querySelector<HTMLInputElement>("input[type='search']");
  assert.ok(input, "the search is drawn while the panel is open");
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = key === undefined ? undefined : (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void }>)[key];
    props?.onChange?.({ target: input, currentTarget: input });
  });
}

afterEach(() => {
  __setBridgeForTest(null);
  viewportWidth = 800;
  mediaListeners.clear();
  document.body.replaceChildren();
});

describe("the closed Library (issue 1157)", () => {
  it("draws the drawer's shell and none of its rows until it is opened", async () => {
    const screen = await mount(libraryState());
    try {
      const shell = panel(screen);
      assert.equal(shell.getAttribute("data-open"), "false");
      assert.equal(shell.getAttribute("aria-label"), "Library", "the shell keeps the name the toggle's aria-controls points at");
      assert.equal(shell.querySelector(".fy-artpanel__list"), null, "no list");
      assert.equal(shell.querySelector("input[type='search']"), null, "no controls");
      assert.deepEqual(rows(screen), []);

      await toggleLibrary(screen);
      assert.equal(panel(screen).getAttribute("data-open"), "true");
      assert.deepEqual(rows(screen), ALL_ROWS, "opening draws the rows");
    } finally {
      await close(screen);
    }
  });

  it("keeps what a person set across closing and reopening", async () => {
    const screen = await mount(libraryState());
    try {
      await toggleLibrary(screen);
      await search(screen, "lamps");
      assert.deepEqual(rows(screen), ["shot:sh_13"], "the search narrows the list");
      const unused = [...panel(screen).querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].find((button) => button.textContent === "Not in the cut");
      assert.ok(unused);
      await act(async () => unused.click());
      assert.deepEqual(rows(screen), [], "a placed shot is in the cut");

      const closeButton = panel(screen).querySelector<HTMLButtonElement>(".fy-artpanel__close");
      assert.ok(closeButton);
      await act(async () => closeButton.click());
      assert.equal(panel(screen).getAttribute("data-open"), "false");
      assert.equal(panel(screen).querySelector("input[type='search']"), null, "closed again: the shell alone");

      await toggleLibrary(screen);
      assert.equal(panel(screen).querySelector<HTMLInputElement>("input[type='search']")?.value, "lamps", "the search survived closing");
      const pressed = [...panel(screen).querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].find((button) => button.getAttribute("aria-pressed") === "true");
      assert.equal(pressed?.textContent, "Not in the cut", "and so did the filter");
      assert.deepEqual(rows(screen), []);
    } finally {
      await close(screen);
    }
  });

  it("is never closed above the breakpoint, and crossing the breakpoint is a render", async () => {
    viewportWidth = 1300;
    const screen = await mount(libraryState());
    try {
      assert.equal(panel(screen).getAttribute("data-open"), "false", "nothing opened it");
      assert.deepEqual(rows(screen), ALL_ROWS, "the column is always shown, so its rows are drawn");

      await resizeTo(800);
      assert.deepEqual(rows(screen), [], "narrowed into a drawer nobody opened, the rows go");

      await resizeTo(1300);
      assert.deepEqual(rows(screen), ALL_ROWS, "widened back into a column, they return without a click");
    } finally {
      await close(screen);
    }
  });
});
