import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, Routing, Scene } from "@arke-studio/contracts";
import { BranchMapScreen } from "../src/screens/branch-map.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The branch map's client contract (epic #401 → issue #410, brief §3, design turn 84).
 *
 * IV-M1 pins the layout itself in contracts; these are the two the map owes the person at the
 * keyboard: it is one tab stop that the arrows walk in the order the picture is drawn, and the
 * three states a node can be in are said in words, never by colour or dimming alone (turn 53).
 */

const ROUTE = "/w/:worldId/p/:prodId/map";
const path = (prodId: string) => `/w/${FIXTURE_WORLD_ID}/p/${prodId}/map`;

function scene(id: string, title: string): Scene {
  return { id, number: 1, slug: id.replace(/^sc_/, ""), title, status: "draft", version: 1, shots: [] };
}

/**
 * A four-scene graph: start → (left | right) → join. Layered, that is three layers — so the
 * flat walk order is start, left, right, join, and a test can tell layout order apart from
 * both authored order and id order.
 */
const SCENES = [scene("sc_start", "The landing"), scene("sc_left", "The stair"), scene("sc_right", "The lift"), scene("sc_join", "The roof")];

const ROUTING: Routing = {
  version: 1,
  start: "sc_start",
  choices: [
    { id: "ch_stair", from: "sc_start", label: "Take the stair", to: "sc_left" },
    { id: "ch_lift", from: "sc_start", label: "Take the lift", to: "sc_right" },
    { id: "ch_up", from: "sc_left", label: "Keep climbing", to: "sc_join" },
    { id: "ch_ride", from: "sc_right", label: "Ride to the top", to: "sc_join" },
  ],
  endings: [{ sceneId: "sc_join", title: "The roof" }],
  excluded: [{ sceneId: "sc_right", reason: "the lift is out of order this season" }],
  groups: [],
};

function interactiveState(over: { routing?: Routing | null; scenes?: Scene[] } = {}): ClientState {
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
          meta: { ...salt.meta, id: "the-answer", title: "The Answer From Inside", medium: "video" as const, kind: "interactive" },
          scenes: over.scenes ?? SCENES,
          sceneFiles: Object.fromEntries((over.scenes ?? SCENES).map((s) => [s.id, s.id.replace(/^sc_/, "")])),
          routing: over.routing === undefined ? ROUTING : over.routing,
          takes: [],
          selections: {},
        },
      ],
    },
  };
}

function render(state: ClientState, prodId: string): string {
  __setStateForTest(state);
  try {
    return renderToString(
      <MemoryRouter initialEntries={[path(prodId)]}>
        <Routes>
          <Route path={ROUTE} element={<BranchMapScreen />} />
        </Routes>
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

/** Every option in the order the DOM holds them, with the attributes the keyboard depends on. */
function options(html: string): Array<{ scene: string; tabIndex: string; selected: string }> {
  return [...html.matchAll(/<div[^>]*role="option"[^>]*>/g)].map((m) => {
    const tag = m[0];
    const pick = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
    return { scene: pick("data-scene"), tabIndex: pick("tabindex"), selected: pick("aria-selected") };
  });
}

describe("the branch map at the keyboard (IV-M2)", () => {
  it("is one tab stop, and it is the first option in layout order", () => {
    // Every option carrying tabIndex=0 put a fifty-node graph fifty presses deep in the page's
    // tab order — which is the thing a listbox exists to avoid. One stop; the arrows do the rest.
    const html = render(interactiveState(), "the-answer");
    const opts = options(html);
    assert.equal(opts.length, 4, "one option per scene");
    const tabbable = opts.filter((o) => o.tabIndex === "0");
    assert.equal(tabbable.length, 1, `exactly one tab stop, got ${tabbable.length}`);
    assert.equal(tabbable[0]!.scene, "sc_start", "and it is the start scene, first in the walk");
    assert.deepEqual(
      opts.filter((o) => o.scene !== "sc_start").map((o) => o.tabIndex),
      ["-1", "-1", "-1"],
      "the rest are reachable by arrow, not by Tab",
    );
  });

  it("walks in layout order — layers left to right, each layer top to bottom", () => {
    // The order the arrows follow is the order the DOM holds, which is the order the layout
    // draws: start, then the two it opens, then the scene they both reach.
    const html = render(interactiveState(), "the-answer");
    assert.deepEqual(
      options(html).map((o) => o.scene),
      ["sc_start", "sc_left", "sc_right", "sc_join"],
      "not authored order, not id order — the picture's order",
    );
  });

  it("renders as a listbox, so the arrows mean what a screen reader says they mean", () => {
    const html = render(interactiveState(), "the-answer");
    assert.match(html, /role="listbox"/);
    assert.match(html, /aria-label="Branch map"/);
    for (const o of options(html)) assert.ok(o.selected === "true" || o.selected === "false", "each option states selection");
  });

  it("renders a 500-scene, 1,000-choice routing graph within the T-20 budget", () => {
    const sceneIds = Array.from({ length: 500 }, (_, index) => `sc_route-${String(index + 1).padStart(3, "0")}`);
    const scenes = sceneIds.map((id, index) => scene(id, `Route scene ${index + 1}`));
    const choices: Routing["choices"] = Array.from({ length: 1_000 }, (_, index) => {
      const fromIndex = index % (sceneIds.length - 1);
      const stride = index < sceneIds.length - 1 ? 1 : index < (sceneIds.length - 1) * 2 ? 2 : sceneIds.length;
      return {
        id: `ch_route-${String(index + 1).padStart(4, "0")}`,
        from: sceneIds[fromIndex]!,
        label: `Choice ${index + 1}`,
        to: sceneIds[Math.min(sceneIds.length - 1, fromIndex + stride)]!,
      };
    });
    const routing: Routing = {
      version: 1,
      start: sceneIds[0]!,
      choices,
      endings: [{ sceneId: sceneIds.at(-1)!, title: "Route ending" }],
      excluded: [],
      groups: [],
    };

    const started = Date.now();
    const html = render(interactiveState({ scenes, routing }), "the-answer");
    const elapsed = Date.now() - started;
    const opts = options(html);
    const expectedIds = new Set(sceneIds);
    assert.equal(opts.length, 500, "every scene remains an option");
    assert.ok(elapsed < 8_000, `branch map rendered 500 scenes and 1,000 choices in ${elapsed}ms`);
    assert.ok(opts.every((option) => expectedIds.has(option.scene)), "routing options use scene ids");
    assert.doesNotMatch(html, /sfn_/, "scene-flow node ids never leak into routing");
    assert.equal(opts.filter((option) => option.tabIndex === "0").length, 1, "the large map remains one roving tab stop");
  });
});

describe("what a node says about itself (IV-M3)", () => {
  it("start, ending and excluded are words on the card, not a colour", () => {
    // Turn 53's rule: a state a person must act on is said. The dimming and the ring are extra.
    const html = render(interactiveState(), "the-answer");
    assert.match(html, /start/, "the start scene says start");
    assert.match(html, /ending/, "the ending says ending");
    assert.match(html, /excluded/, "the excluded scene says excluded");
    assert.match(
      html,
      /the lift is out of order this season/,
      "and an exclusion carries its reason — a dimmed card with no reason is a puzzle",
    );
  });

  it("a graph with nothing marked says none of those words", () => {
    const plain: Routing = { ...ROUTING, endings: [], excluded: [] };
    const html = render(interactiveState({ routing: plain }), "the-answer");
    assert.doesNotMatch(html, /excluded/);
    assert.doesNotMatch(html, />ending</);
    assert.match(html, /start/, "the start is always somewhere");
  });

  it("a linear production answers with the rule instead of drawing a map (turn 78)", () => {
    const html = render(FIXTURE_STATE, "saltlight");
    assert.match(html, /This production is linear/);
    assert.doesNotMatch(html, /role="listbox"/, "no map for a season that has boards");
  });

  it("an interactive production with no routing yet offers the one thing to press", () => {
    const html = render(interactiveState({ routing: null }), "the-answer");
    assert.match(html, /Draw the first choice from the start scene/);
    assert.match(html, /Start at The landing/);
  });
});
