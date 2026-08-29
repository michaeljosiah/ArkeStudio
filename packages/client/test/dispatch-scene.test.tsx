import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Scene } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { dispatchPath } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Which scene the dispatch dialog is about (issue 634).
 *
 * It held an index seeded at 0 and nothing carried the referrer, so `Generate scene` on any
 * scene but the first opened a dialog priced for the first — and its priced button spent
 * there. The fixture ships one scene, which is exactly why the bug survived: with one scene
 * the wrong answer and the right one are the same string.
 */

const world = FIXTURE_STATE.world!;
const production = world.productions[0]!;
const first = production.scenes[0]! as Scene;

/** A second scene, so "the first one" and "the one that sent you" can disagree. */
const second: Scene = {
  ...first,
  id: "sc_09",
  number: 9,
  slug: "the-tide-turns",
  title: "The tide turns",
  shots: [{ ...first.shots[0]!, id: "sh_40", number: 1, title: "The water goes flat", durationSec: 5 }],
};

const TWO_SCENES = {
  ...FIXTURE_STATE,
  world: {
    ...world,
    productions: world.productions.map((p) =>
      p.meta.id === production.meta.id
        ? { ...p, scenes: [first, second], sceneFiles: { ...p.sceneFiles, sc_09: "09-the-tide-turns" } }
        : p,
    ),
  },
};

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

describe("the dispatch dialog's subject", () => {
  it("opens on the scene the address names, not the production's first", () => {
    __setStateForTest(TWO_SCENES);
    try {
      const base = `/w/${world.meta.worldId}/p/${production.meta.id}`;
      const asked = renderAt(`${base}/generate/dispatch?scene=${second.id}`);
      // The header states the subject, and it is the scene that sent you.
      assert.ok(
        asked.includes(`${second.title} · ${second.shots.length} shots`),
        "the dialog states the asked-for scene as its subject",
      );
      assert.ok(
        !asked.includes(`${first.title} · ${first.shots.length} shots`),
        "and never prices the first scene while claiming to be about another",
      );
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("falls back to the first scene when nothing was carried", () => {
    __setStateForTest(TWO_SCENES);
    try {
      const bare = renderAt(`/w/${world.meta.worldId}/p/${production.meta.id}/generate/dispatch`);
      assert.ok(
        bare.includes(`${first.title} · ${first.shots.length} shots`),
        "a bare address still opens somewhere sensible",
      );
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("ignores a scene id that names nothing in this production", () => {
    __setStateForTest(TWO_SCENES);
    try {
      const base = `/w/${world.meta.worldId}/p/${production.meta.id}`;
      // A stale link, or a scene deleted since — it falls back rather than rendering empty.
      const stray = renderAt(`${base}/generate/dispatch?scene=sc_does-not-exist`);
      assert.ok(stray.includes(`${first.title} · ${first.shots.length} shots`));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});

describe("the address every door builds", () => {
  it("carries the scene, and omits it when there is none to carry", () => {
    assert.equal(
      dispatchPath("w1", "p1", "sc_04"),
      "/w/w1/p/p1/generate/dispatch?scene=sc_04",
      "the scene rides in the address",
    );
    assert.equal(dispatchPath("w1", "p1", null), "/w/w1/p/p1/generate/dispatch");
    assert.equal(dispatchPath("w1", "p1", undefined), "/w/w1/p/p1/generate/dispatch");
  });
});
