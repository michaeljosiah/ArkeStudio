import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { ShotSheetScreen } from "../src/screens/storyboard.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** The full shot sheet behind the scene workspace row (turn 97, 14d). */

const SCENE_PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;

function render(state: ClientState, path: string, element: React.ReactElement, routePath: string): string {
  __setStateForTest(state);
  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

function withScene(mutate: (scene: NonNullable<ClientState["world"]>["productions"][number]["scenes"][number]) => object): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: world.productions.map((p) =>
        p.meta.id === "saltlight"
          ? { ...salt, scenes: salt.scenes.map((s) => (s.id === "sc_04" ? { ...s, ...mutate(s) } : s)) }
          : p,
      ),
    },
  };
}

describe("the full shot behind the card (turn 97, 14d)", () => {
  const SHOT_PATH = `${SCENE_PATH}/shots/sh_12`;
  const ROUTE = "/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId";

  it("the sheet holds script, prompt, intent, timing, references and the accordion", () => {
    const html = render(FIXTURE_STATE, SHOT_PATH, <ShotSheetScreen />, ROUTE);
    assert.ok(html.includes("shot 12 of scene 4"));
    assert.ok(html.includes("Shot script"));
    assert.ok(html.includes("Image prompt"));
    assert.ok(html.includes("Cinematic intent"));
    assert.ok(html.includes("Guides the camera · hand settings win."));
    assert.ok(html.includes("Timing"), "the plainest true word (turn 101)");
    assert.ok(html.includes("+ Add beat"));
    assert.ok(html.includes("References"));
    assert.ok(html.includes("+ Add a reference"));
    for (const section of ["Creative", "Camera", "Sound", "Continuity"]) {
      assert.ok(html.includes(section), `${section} section`);
    }
    assert.ok(html.includes("start from a recipe"));
    assert.ok(html.includes("Establishing"), "recipes are one-press coverage grammar");
    assert.ok(html.includes("from the production"), "aspect is display-only (turn 97's amendment)");
    assert.ok(html.includes("Duplicate") && html.includes("Delete"));
  });

  it("assembles the editable prompt for the production's actual medium", () => {
    const withTiming = withScene((s) => ({
      shots: (s as { shots: Array<{ id: string }> }).shots.map((shot) =>
        shot.id === "sh_12"
          ? {
              ...shot,
              intent: "A held breath",
              beats: [{ span: "0–4s", text: "She crosses the room" }],
            }
          : shot,
      ),
    }));
    const world = withTiming.world!;
    const video = render(withTiming, SHOT_PATH, <ShotSheetScreen />, ROUTE);
    assert.ok(video.includes("infer unset camera choices from this"));
    assert.ok(video.includes("Shot timing 0–4s"), "video preview includes its authored timing");
    assert.ok(video.includes("SPATIAL LAYOUT"), "the video seed includes the room the author is editing");
    assert.ok(video.includes("CAMERA ANCHOR"), "the video seed includes its camera; saved overrides are not wrapped again");

    const stills: ClientState = {
      ...withTiming,
      world: {
        ...world,
        productions: world.productions.map((production) =>
          production.meta.id === "saltlight"
            ? { ...production, meta: { ...production.meta, format: "stills" } }
            : production,
        ),
      },
    };
    const image = render(stills, SHOT_PATH, <ShotSheetScreen />, ROUTE);
    assert.ok(image.includes("infer unset camera choices from this"), "cinematic intent still guides one frame");
    assert.ok(!image.includes("Shot timing 0–4s"), "a still preview cannot save temporal rows into an override");

    const productionLook = "Bleached documentary realism with hard noon shadows";
    const overridden: ClientState = {
      ...withTiming,
      world: {
        ...world,
        productions: world.productions.map((production) =>
          production.meta.id === "saltlight"
            ? { ...production, meta: { ...production.meta, styleOverride: productionLook } }
            : production,
        ),
      },
    };
    const productionPreview = render(overridden, SHOT_PATH, <ShotSheetScreen />, ROUTE);
    assert.ok(!productionPreview.includes(productionLook), "the look informs the writer, not the editable prompt seed");
    assert.ok(!productionPreview.includes(world.artDirection.description), "the editor shows the nearest look");
  });

  it("camera fields say where their value comes from: a scene default reads as from scene", () => {
    const html = render(
      withScene(() => ({ defaults: { size: "Medium" } })),
      SHOT_PATH,
      <ShotSheetScreen />,
      ROUTE,
    );
    assert.ok(html.includes("Medium · from scene"), "inheritance is named, not implied");
  });

  it("a framing field present on the shot is the override, marked by the dot", () => {
    const html = render(
      withScene((s) => ({
        shots: (s as { shots: Array<{ id: string }> }).shots.map((sh) =>
          sh.id === "sh_12" ? { ...sh, framing: { size: "Close-up" } } : sh,
        ),
      })),
      SHOT_PATH,
      <ShotSheetScreen />,
      ROUTE,
    );
    assert.ok(html.includes("fy-sheetcam__dot"), "the override dot renders");
    assert.ok(html.includes("overrides the scene"));
  });

  it("the first shot cannot open on a previous frame, and says why", () => {
    const html = render(FIXTURE_STATE, SHOT_PATH, <ShotSheetScreen />, ROUTE);
    assert.ok(html.includes("First shot — nothing before it"));
    const later = render(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_13`, <ShotSheetScreen />, ROUTE);
    assert.ok(later.includes("Open on the last frame of shot 12"));
  });

  it("offers the stronger form beside it, and refuses it on the first shot too (SPEC-019 R-50)", () => {
    // Continuation extends the footage where a boundary frame only reproduces its last picture.
    // Both are authored intents on the same record, so both are offered in the same place — and
    // the first shot has nothing before it either way.
    const first = render(FIXTURE_STATE, SHOT_PATH, <ShotSheetScreen />, ROUTE);
    assert.ok(first.includes("First shot — nothing to continue"));
    const later = render(FIXTURE_STATE, `${SCENE_PATH}/shots/sh_13`, <ShotSheetScreen />, ROUTE);
    assert.ok(later.includes("Continue the footage of shot 12"));
  });
});

describe("the shot's prop state control (design turn 105; issue 537)", () => {
  it("shows a cited prop unresolved and offers its states for this shot only, never behind a toggle", () => {
    const polaroid = {
      id: "prop_01J8F0000000000000000000P1",
      name: "Polaroid",
      states: [
        { id: "pst_01J8F0000000000000000000S1", name: "on-fridge", reference: { id: "psr-1", file: "takes/tk_x/a.png", acceptedAt: "2026-09-05T00:00:00.000Z" } },
        { id: "pst_01J8F0000000000000000000S2", name: "in-hand" },
      ],
    };
    const cited = withScene((s) => ({
      shots: (s as { shots: Array<{ id: string; description: string }> }).shots.map((shot) =>
        shot.id === "sh_12" ? { ...shot, description: `${shot.description} The @polaroid is on the fridge.` } : shot,
      ),
    }));
    const state = { ...cited, world: { ...cited.world!, props: [polaroid] } };
    const html = render(state, `${SCENE_PATH}/shots/sh_12`, <ShotSheetScreen />, "/w/:worldId/p/:prodId/scenes/:sceneId/shots/:shotId");
    assert.match(html, /this shot only/);
    assert.match(html, /<option value="" selected="">unresolved<\/option>/);
    assert.match(html, /on-fridge · has a reference/);
    assert.match(html, /in-hand · no ref yet/);
    assert.doesNotMatch(html, /Override/);
  });
});
