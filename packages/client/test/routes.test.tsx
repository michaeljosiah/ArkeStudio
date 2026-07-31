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
  it("covers the full §2.9 inventory (41 screens)", () => {
    assert.equal(SCREENS.length, 41);
    assert.equal(new Set(SCREENS.map((s) => s.id)).size, 41, "screen ids are unique");
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
    assert.ok(html.includes("Arke Studio"));
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
});
