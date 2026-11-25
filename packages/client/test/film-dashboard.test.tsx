import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { orderedShots, type ClientState } from "@arke-studio/contracts";
import { shotLabel, shotNumberOf } from "../src/lib/selectors.js";
import { __setStateForTest } from "../src/lib/store.js";
import { ProductionDashboardScreen } from "../src/screens/production-dashboard.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A film's first step (issue 3218): one adapted from a 29-scene book, with no shots written yet,
 * opened on Make the first clip. Its lead card now points at Develop, where the shots are written.
 */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1024, innerHeight: 768, matchMedia: (media: string) => ({ matches: false, media }) });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

/** The fixture film with its scene kept and every shot and take taken away. */
function unwrittenFilm(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.scenes = production.scenes.map((scene) => ({ ...scene, shots: [] }));
  production.takes = [];
  production.reviews = [];
  production.selections = {};
  return state;
}

function render(state: ClientState): string {
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}`]}>
      <Routes><Route path="/w/:worldId/p/:prodId" element={<ProductionDashboardScreen />} /></Routes>
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

describe("a film's dashboard leads with what exists (issue 3218)", () => {
  it("asks for the shots, not a clip, while the scenes have none", () => {
    try {
      const page = render(unwrittenFilm());
      assert.match(page, /NO SHOTS YET.*Write the shots.*Open Develop/);
      assert.doesNotMatch(page, /NOTHING MADE YET|Make the first clip|Make clips/);
    } finally { __setStateForTest(FIXTURE_STATE); }
  });

  it("says beats for a visual novel", () => {
    const state = unwrittenFilm();
    state.world!.productions[0]!.meta.kind = "visual-novel";
    try {
      const page = render(state);
      assert.match(page, /NO BEATS YET.*Write the beats.*Open Develop/);
      assert.doesNotMatch(page, /Make the first picture|Make pictures/);
    } finally { __setStateForTest(FIXTURE_STATE); }
  });

  it("numbers a shot by its place in its scene, never by its id (0.5.141)", () => {
    // Gold on Gold's fifteenth shot is sh_499, and three screens called it "Shot 499".
    const production = structuredClone(FIXTURE_STATE).world!.productions[0]!;
    const ids = production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id));
    assert.ok(ids.length >= 2 && ids[0] !== "sh_1", "the fixture's ids are not its numbers");
    assert.equal(shotNumberOf(production, ids[0]!), 1);
    assert.equal(shotNumberOf(production, ids[1]!), 2);
    assert.equal(shotLabel(production, ids[1]!, "Shot"), "Shot 2");
    assert.equal(shotLabel(production, "sh_999"), "shot 999", "a shot no scene holds keeps its id's digits");
    assert.equal(shotNumberOf(null, ids[0]!), null);
  });

  it("keeps the next shot's card once shots are written", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.takes = [];
    production.reviews = [];
    production.selections = {};
    try {
      const page = render(state);
      assert.doesNotMatch(page, /NO SHOTS YET|Open Develop/);
      // sh_12 is scene 4's first shot: named by its place in the scene, not its id (0.5.141).
      assert.match(page, /Shot 1 has no clip yet.*Scene 4 · Maren at the rail, listening.*Make the clip/);
    } finally { __setStateForTest(FIXTURE_STATE); }
  });

  it("opens Develop", async () => {
    const state = unwrittenFilm();
    __setStateForTest(state);
    const production = state.world!.productions[0]!;
    const Landed = () => { const location = useLocation(); return <p>{`landed ${location.pathname}`}</p>; };
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId" element={<ProductionDashboardScreen />} />
          <Route path="/w/:worldId/p/:prodId/story" element={<Landed />} />
        </Routes>
      </MemoryRouter>));
      const open = [...container.querySelectorAll<HTMLButtonElement>("[data-testid='no-shots-card'] button")].find((b) => b.textContent === "Open Develop")!;
      await act(async () => open.click());
      assert.match(container.textContent ?? "", new RegExp(`landed /w/${state.world!.meta.worldId}/p/${production.meta.id}/story$`));
    } finally {
      await act(async () => root.unmount()); container.remove(); __setStateForTest(FIXTURE_STATE);
    }
  });
});
