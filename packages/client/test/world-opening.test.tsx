import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, DomainEvent } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __setStateForTest, __stateForTest, type WorldOpenProgress } from "../src/lib/store.js";
import { worldOpeningLabel } from "../src/components/world-opening.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A large world opened behind one unchanging "opening the world" for up to two minutes, which
 * looked exactly like a hang (issue 1844). The coordinator now says which part of the open it is
 * in, and the loader says it too.
 */

const OTHER_WORLD = "01M0F0DPTXSFXA50JQTM391BXX";
const AT = "2026-10-19T12:00:00.000Z";
const opening: ClientState = { ...FIXTURE_STATE, world: null };

function render(progress: WorldOpenProgress | null, path = `/w/${FIXTURE_WORLD_ID}`): string {
  __setStateForTest(opening, { worldOpenProgress: progress });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => __setStateForTest(FIXTURE_STATE));

describe("what a world's open says while it runs (issue 1844)", () => {
  it("names each phase, with the count while it reads", () => {
    const at = (progress: Omit<WorldOpenProgress, "worldId">) => worldOpeningLabel({ worldId: FIXTURE_WORLD_ID, ...progress });
    assert.equal(at({ phase: "reading", done: 1200, total: 3898 }), "reading the world · 1,200 of 3,898");
    assert.equal(at({ phase: "reading", done: 1200 }), "reading the world · 1,200 files", "a first open has no total to give");
    assert.equal(at({ phase: "reading", done: 4000, total: 3898 }), "reading the world · 4,000 files", "a count past its total is not shown against it");
    assert.equal(at({ phase: "reading" }), "reading the world");
    assert.equal(at({ phase: "checking" }), "checking the world");
    assert.equal(at({ phase: "conversations" }), "checking conversations");
    assert.equal(at({ phase: "finishing" }), "finishing");
    assert.equal(worldOpeningLabel(null), "opening the world", "nothing said yet is the plain line it always was");
  });

  it("shows it in place of the loader line, on the world and on a production", () => {
    const progress: WorldOpenProgress = { worldId: FIXTURE_WORLD_ID, phase: "reading", done: 1200, total: 3898 };
    assert.ok(render(progress).includes("reading the world · 1,200 of 3,898"));
    assert.ok(render(progress, `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes`).includes("reading the world · 1,200 of 3,898"));
    assert.ok(render({ worldId: FIXTURE_WORLD_ID, phase: "conversations" }, `/w/${FIXTURE_WORLD_ID}/cast`).includes("checking conversations"));
  });

  it("keeps another world's open off this world's loader", () => {
    const html = render({ worldId: OTHER_WORLD, phase: "conversations" });
    assert.ok(html.includes("opening the world"));
    assert.equal(html.includes("checking conversations"), false);
  });

  it("follows the open's events, and ends with it", () => {
    __setStateForTest(opening);
    const progress = (done: number): DomainEvent => ({ at: AT, type: "world.open-progress", worldId: FIXTURE_WORLD_ID, phase: "reading", done, total: 3898 });
    __applyEventForTest(progress(16));
    __applyEventForTest(progress(1200));
    assert.deepEqual(__stateForTest().worldOpenProgress, { worldId: FIXTURE_WORLD_ID, phase: "reading", done: 1200, total: 3898 });
    __applyEventForTest({ at: AT, type: "world.open-progress", worldId: FIXTURE_WORLD_ID, phase: "conversations" });
    assert.deepEqual(__stateForTest().worldOpenProgress, { worldId: FIXTURE_WORLD_ID, phase: "conversations" }, "a phase without a count carries none over");
    __applyEventForTest({ at: AT, type: "world.opened", worldId: OTHER_WORLD });
    assert.equal(__stateForTest().worldOpenProgress?.phase, "conversations", "another world's open ends nothing here");
    __applyEventForTest({ at: AT, type: "world.opened", worldId: FIXTURE_WORLD_ID });
    assert.equal(__stateForTest().worldOpenProgress, null);
    __applyEventForTest(progress(16));
    __applyEventForTest({ at: AT, type: "world.open-failed", worldId: FIXTURE_WORLD_ID, reason: "refused" });
    assert.equal(__stateForTest().worldOpenProgress, null, "a refused open ends it as well");
  });
});
