import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { SCREENS } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The navigation test (SPEC-001 R-7): every §2.9 screen mounts at its route, rendering the
 * fixture state, and the inventory itself is complete.
 */

__setStateForTest(FIXTURE_STATE);

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("screen inventory", () => {
  it("covers the full screen inventory (43 screens)", () => {
    assert.equal(SCREENS.length, 43);
    assert.equal(new Set(SCREENS.map((s) => s.id)).size, 43, "screen ids are unique");
  });

  for (const screen of SCREENS) {
    it(`reaches ${screen.id} at ${screen.samplePath}`, () => {
      const html = renderAt(screen.samplePath);
      assert.ok(
        html.includes(`data-screen="${screen.id}"`),
        `expected ${screen.samplePath} to mount data-screen="${screen.id}"`,
      );
    });
  }

  it("smoke-renders the root router", () => {
    const html = renderAt("/");
    // The launch screen, by what it is rather than by a wordmark: the reel, and — with nothing
    // left to fetch — a door and a version number. The progress line, the byte counts and the
    // note about where worlds live all answered "what is it doing", which nobody is asking
    // once it is done.
    assert.ok(html.includes('data-screen="launch"'), "the root route mounts the launch screen");
    assert.ok(html.includes("setup-reel.mp4"), "the reel plays while the runtimes come down");
    assert.ok(html.includes("Continue"), "and when it is ready, the way in");
    assert.ok(html.includes("fy-launch__version"), "with the version under it");
    for (const chatter of ["Setting up your studio.", "One-time setup", "everything ready"]) {
      assert.ok(!html.includes(chatter), `"${chatter}" is not shown once there is nothing to wait for`);
    }
  });

  it("renders the degraded reasons when children are unavailable (R-6)", () => {
    const html = renderAt(SCREENS.find((s) => s.id === "character-edit")!.samplePath);
    assert.ok(html.includes("OpenCode is not configured"), "harness reason is stated, not silent");
    const voiceHtml = renderAt(SCREENS.find((s) => s.id === "voice-picker")!.samplePath);
    assert.ok(voiceHtml.includes("Voxa is not configured"));
  });

  it("renders fixture content, not lorem ipsum", () => {
    const cast = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast`);
    assert.ok(cast.includes("Maren Kest"));
    const canon = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/canon`);
    assert.ok(canon.includes("Tide-calling"));
  });

  it("renders the complete art-direction surface from its resolved record", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/art-direction`);
    for (const copy of [
      "WORLD ART DIRECTION",
      "WHAT FOLLOWS THIS LOOK",
      "NOT FOLLOWING IT",
      "HISTORY",
      "24 visual assets",
      "The Chorister",
      "Cold-water realism",
    ]) {
      assert.ok(html.includes(copy), `art direction names ${copy}`);
    }
  });
});
