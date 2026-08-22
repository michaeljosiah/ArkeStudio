import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { SceneDetailScreen } from "../src/screens/production.js";
import { cardState, nextShotId, ShotSheetScreen } from "../src/screens/storyboard.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The storyboard (turn 97, 14c) and the full shot behind the card (14d): the card is the
 * editor, everything it states is derived, and the sheet holds what the card does not show.
 */

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

describe("the storyboard is the editor (turn 97, 14c)", () => {
  it("the scene page renders a card per shot, the synopsis line, and Add shot", () => {
    const html = render(FIXTURE_STATE, SCENE_PATH, <SceneDetailScreen />, "/w/:worldId/p/:prodId/scenes/:sceneId");
    assert.ok(html.includes('data-testid="storyboard-strip"'), "the strip replaces 14a's read-only cards");
    for (const id of ["sh_12", "sh_13"]) {
      assert.ok(html.includes(`data-testid="shot-card-${id}"`), `a card for ${id}`);
    }
    assert.ok(html.includes("Add shot"), "manual authoring is a first-class path");
    assert.ok(html.includes("Insert a shot"), "insert-between affordances");
    assert.ok(html.includes("What happens, in a line or two."), "the synopsis edits in place");
    assert.ok(html.includes("Drag to reorder"));
    assert.ok(/prompt · (auto|edited by you)/.test(html), "the prompt names its author");
    assert.ok(html.includes("version history"), "the way back is on the page");
    assert.ok(html.includes("from the production"), "aspect is a fact here, not a control");
  });

  it("an empty scene offers both doors — and nothing here needs the assistant", () => {
    const html = render(
      withScene(() => ({ shots: [] })),
      SCENE_PATH,
      <SceneDetailScreen />,
      "/w/:worldId/p/:prodId/scenes/:sceneId",
    );
    assert.ok(html.includes('data-testid="storyboard-empty"'));
    assert.ok(html.includes("Build this scene"));
    assert.ok(html.includes("Talk to Arke"));
    assert.ok(html.includes("Add first shot"));
    assert.ok(!html.includes('data-testid="storyboard-strip"'));
  });

  it("a blank shot reads needs attention and offers the placeholder, not silence", () => {
    const html = render(
      withScene((s) => ({
        shots: (s as { shots: Array<{ id: string }> }).shots.map((sh) =>
          sh.id === "sh_12" ? { ...sh, description: "" } : sh,
        ),
      })),
      SCENE_PATH,
      <SceneDetailScreen />,
      "/w/:worldId/p/:prodId/scenes/:sceneId",
    );
    assert.ok(html.includes("needs attention"));
    assert.ok(html.includes("Write what happens, or ask Arke."));
  });

  it("the maturity ladder derives from what exists — never a stored status", () => {
    const shot = { description: "" };
    assert.equal(cardState(shot as never, 0, false), "blank");
    assert.equal(cardState({ description: "She waits." } as never, 0, false), "story");
    assert.equal(cardState({ description: "She waits." } as never, 2, false), "board");
    assert.equal(cardState({ description: "She waits." } as never, 2, true), "ready");
  });

  it("new shot ids continue from the highest, by id or number, never reusing one", () => {
    const scene = {
      shots: [
        { id: "sh_12", number: 12 },
        { id: "sh_15", number: 15 },
      ],
    };
    assert.deepEqual(nextShotId(scene as never, scene.shots as never), { id: "sh_16", number: 16 });
  });

  it("mints an id past every scene in the production, not just this one (review 2026-08-22)", () => {
    // Takes and selections key by bare shot id with no scene, so an id reused across scenes
    // makes one scene's takes render on the other's card and one accept mark both.
    const scene = { shots: [{ id: "sh_04", number: 4 }] };
    const all = [
      { id: "sh_04", number: 4 },
      { id: "sh_12", number: 12 },
    ];
    const minted = nextShotId(scene as never, all as never);
    assert.equal(minted.id, "sh_13", "the id clears the other scene's shots");
    assert.equal(minted.number, 5, "the number stays scene-local — it is the card's label");
  });

  it("the foot counts what the review counts (review 2026-08-22): an override is something to generate from", () => {
    // The foot used its own rule — empty description or stale — so a shot whose whole prompt
    // was hand-written read "1 to review" under a review strip saying nothing to flag.
    const html = render(
      withScene((s) => ({
        shots: (s as { shots: Array<{ id: string }> }).shots.map((sh) =>
          sh.id === "sh_12"
            ? { ...sh, description: "", promptOverride: { text: "hand-tuned wording", sheetVersions: {} } }
            : sh,
        ),
      })),
      SCENE_PATH,
      <SceneDetailScreen />,
      "/w/:worldId/p/:prodId/scenes/:sceneId",
    );
    assert.ok(html.includes("Ready to generate"), "an override counts as written");
    assert.ok(!html.includes("1 to review"), "the foot and the review agree");
  });

  it("and a genuinely empty shot still counts", () => {
    const html = render(
      withScene((s) => ({
        shots: (s as { shots: Array<{ id: string }> }).shots.map((sh) => ({ ...sh, description: "" })),
      })),
      SCENE_PATH,
      <SceneDetailScreen />,
      "/w/:worldId/p/:prodId/scenes/:sceneId",
    );
    assert.ok(html.includes("2 to review"), "one finding per empty shot");
  });
});

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
});
