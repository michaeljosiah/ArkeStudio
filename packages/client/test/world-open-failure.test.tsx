import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { RouteErrorBoundary } from "../src/components/route-error-boundary.js";
import { LocationDetailScreen } from "../src/screens/world.js";
import { ReplaceMainPhotoScreen } from "../src/screens/character-reference.js";

/**
 * A world that would not open used to look exactly like one still opening (issue 571): the
 * request is fire-and-forget, so with no world in the snapshot every screen under `/w/:worldId`
 * rendered its loader and nothing ever ended it. The refusal is what ends it.
 */

const OTHER_WORLD = "01M0F0DPTXSFXA50JQTM391BXX";
const REASON = ".history/characters/bray-half-hitch/v6.md: history snapshot conflicts with the committed version";

function render(state: ClientState, path = `/w/${FIXTURE_WORLD_ID}`): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const refused: ClientState = {
  ...FIXTURE_STATE,
  world: null,
  worldOpenFailure: { worldId: FIXTURE_WORLD_ID, reason: REASON },
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(dom.HTMLElement.prototype, {
  scrollIntoView() {}, showModal() {}, close() {},
});
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});
let root: Root | undefined;
let navigate: NavigateFunction;
let caught: unknown[];
function Navigation() { navigate = useNavigate(); return null; }
function BrokenScreen(): never { throw new Error("test render failure"); }
function DraftScreen() {
  const [draft, setDraft] = useState("Empty");
  return <button onClick={() => setDraft("Unsaved draft")}>{draft}</button>;
}
async function mount(path: string, children: ReactNode = <App />) {
  const container = document.createElement("div");
  caught = [];
  root = createRoot(container, { onCaughtError: (error) => { caught.push(error); } });
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}><Navigation />{children}</MemoryRouter>));
  return container;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  __setStateForTest(FIXTURE_STATE);
});

describe("a refused world open, on screen (issue 571)", () => {
  it("says so, and says why, instead of the loader", () => {
    const html = render(refused);
    assert.ok(html.includes("This world did not open"), "the state is named");
    assert.ok(html.includes("history snapshot conflicts"), "with the reason it was refused");
    assert.ok(html.includes("Try again"), "and a way to ask again");
    assert.equal(html.includes("opening the world"), false, "the loader is done");
  });

  it("still loads when there is no refusal — an absent world is not a refused one", () => {
    const html = render({ ...FIXTURE_STATE, world: null });
    assert.ok(html.includes("opening the world"), "a world on its way still says so");
    assert.equal(html.includes("This world did not open"), false);
  });

  it("states it on a production route too, which is a sibling tree and not a child", () => {
    // `/w/:worldId/p/:prodId` renders under ProductionLayout, not WorldLayout. A refusal surfaced
    // only in the world tree leaves every production screen on its loader — and productions are
    // where the world in the report kept its work.
    const html = render(refused, `/w/${FIXTURE_WORLD_ID}/p/the-drowning-season`);
    assert.ok(html.includes("This world did not open"));
    assert.ok(html.includes("history snapshot conflicts"));
  });

  it("offers a way out where the layout draws no chrome", () => {
    // The fixed workspaces render no AppChrome — their child supplies the breadcrumb — so a
    // refusal in that slot with only Try again strands anybody who reloaded at such a URL.
    const html = render(refused, `/w/${FIXTURE_WORLD_ID}/art-direction/propose`);
    assert.ok(html.includes("This world did not open"));
    assert.ok(html.includes("Worlds"), "and a route back that is not a retry");
  });

  it("keeps another world's refusal off this world's screen", () => {
    // The failure sits in the snapshot until some world opens, so a person who gives up on one
    // world and opens another must not be met by the first one's refusal.
    const html = render({
      ...FIXTURE_STATE,
      worldOpenFailure: { worldId: OTHER_WORLD, reason: REASON },
    });
    assert.equal(html.includes("This world did not open"), false);
  });
});

describe("navigation survives a failed world (issue 981)", () => {
  for (const [path, screen] of [["locations/the-vigil", "location-detail"], ["cast/maren-kest/main-photo", "replace-main-photo"],
    ["p/saltlight/scenes", "scenes"]]) {
    it(`loads ${path} after a refusal and returns to Worlds`, async () => {
      __setStateForTest({ ...refused, worldOpenFailure: { worldId: OTHER_WORLD, reason: REASON } });
      const container = await mount(`/w/${OTHER_WORLD}`);
      assert.ok(container.textContent?.includes("This world did not open"));
      await act(async () => { await navigate(`/w/${FIXTURE_WORLD_ID}/${path}`); });
      assert.ok(container.textContent?.includes("opening the world"));
      assert.ok(container.querySelector(".fy-titlebar"), "chrome remains available while loading");
      await act(async () => __setStateForTest(FIXTURE_STATE));
      assert.ok(container.querySelector(`[data-screen="${screen}"]`));
      await act(async () => { await navigate("/worlds"); });
      assert.ok(container.querySelector('[data-screen="world-picker"]'));
      assert.deepEqual(caught, [], "the boundary must not hide a loading regression");
    });
  }

  it("keeps detail and main-photo hook order stable when their world arrives or disappears", async () => {
    __setStateForTest({ ...FIXTURE_STATE, world: null });
    const container = await mount(`/w/${FIXTURE_WORLD_ID}/locations/the-vigil`, <Routes>
      <Route path="/w/:worldId/locations/:sheetId" element={<LocationDetailScreen />} />
      <Route path="/w/:worldId/cast/:sheetId/main-photo" element={<ReplaceMainPhotoScreen />} />
    </Routes>);
    await act(async () => __setStateForTest(FIXTURE_STATE));
    assert.ok(container.querySelector('[data-screen="location-detail"]'));
    await act(async () => __setStateForTest({ ...FIXTURE_STATE, world: null }));
    await act(async () => { await navigate(`/w/${FIXTURE_WORLD_ID}/cast/maren-kest/main-photo`); });
    await act(async () => __setStateForTest(FIXTURE_STATE));
    assert.ok(container.querySelector('[data-screen="replace-main-photo"]'));
  });

  it("contains render errors, recovers on navigation and preserves healthy screen state on query changes", async () => {
    const container = await mount("/editor", <RouteErrorBoundary><Routes>
      <Route path="/editor" element={<DraftScreen />} />
      <Route path="/broken" element={<BrokenScreen />} />
      <Route path="/worlds" element={<p>World picker recovered</p>} />
    </Routes></RouteErrorBoundary>);
    await act(async () => container.querySelector("button")!.click());
    await act(async () => { await navigate("/editor?panel=details"); });
    assert.equal(container.textContent, "Unsaved draft");
    await act(async () => { await navigate("/broken"); });
    assert.ok(container.textContent?.includes("This screen could not be shown"));
    assert.ok(container.querySelector(".fy-titlebar"));
    assert.equal(caught.length, 1);
    await act(async () => container.querySelector<HTMLElement>('[role="alert"] button')!.click());
    assert.equal(container.textContent, "World picker recovered");
    await act(async () => { await navigate("/broken"); });
    await act(async () => { await navigate("/editor"); });
    assert.equal(container.textContent, "Empty", "ordinary navigation also recovers");
  });
});
