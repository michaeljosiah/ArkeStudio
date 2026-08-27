import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { comfyUiWeightsComponentId, type ClientState, type SetupComponent } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A recipe's weights, on the recipe's own row (SPEC-028 T-25, R-3).
 *
 * The download always worked; it was two panes away from the row that said what was missing.
 * The recipe read "1 of 1 model files missing from the models folder" and offered Re-verify,
 * while the Download for those exact files sat under Components — so these check that the
 * action, the size, the progress and the refusal now reach the row that states the lack.
 */

/** SSR splits a text node at every interpolation, so the size never abuts its label. */
const DOWNLOAD_AT_SIZE = /Download · (?:<!-- -->)?6\.5 GB/;

const RECIPE_ID = "comfyui-draft-image";
const WEIGHTS_ID = comfyUiWeightsComponentId(RECIPE_ID);

function weights(patch: Partial<SetupComponent>): SetupComponent {
  return {
    id: WEIGHTS_ID,
    displayName: "Local · Draft Image · weights",
    purpose: "Model files for Local · Draft Image",
    sizeMb: 6617,
    state: "available",
    bytesDone: 0,
    bytesTotal: 6617 * 1024 * 1024,
    bytesPerSecond: null,
    ...patch,
  };
}

function stateWith(component: SetupComponent, recipeReason?: string): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      comfyui: {
        engine: {
          source: "managed",
          state: "ready",
          locality: "local",
          location: "127.0.0.1:8188",
          version: "0.3.45",
          instanceId: "managed-1",
          detail: null,
          detected: [],
        },
        recipes: [
          {
            recipeId: RECIPE_ID,
            recipeVersion: 1,
            displayName: "Local · Draft Image",
            capability: "image",
            state: "disabled",
            ...(recipeReason !== undefined ? { reason: recipeReason } : {}),
          },
        ],
        checkedAt: "2026-08-26T12:00:00.000Z",
      },
      setup: { running: false, diskFreeMb: 100_000, components: [component] },
    },
  };
}

function render(path: string, state: ClientState): string {
  __setStateForTest(state, { setupStatus: state.app.setup });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("a recipe's weights hang off the recipe", () => {
  it("offers the download, at its size, on the row that says the files are missing", () => {
    const html = render(
      "/settings/local-runtime?group=comfyui",
      stateWith(weights({}), "1 of 1 model files missing from the models folder"),
    );
    assert.match(html, /data-testid="comfyui-recipe"/);
    assert.match(html, DOWNLOAD_AT_SIZE);
    // The measured refusal stays: the size says what it costs, the reason says why it is off.
    assert.match(html, /1 of 1 model files missing/);
  });

  it("reports the fetch as the recipe's own state while it runs", () => {
    const html = render(
      "/settings/local-runtime?group=comfyui",
      stateWith(weights({ state: "downloading", bytesDone: Math.round(6617 * 1024 * 1024 * 0.42) })),
    );
    assert.match(html, /42%/);
    assert.match(html, /fy-set__barfill/);
    // The dot has to agree with the word beside it: a download in progress is not a fault,
    // even though the recipe it belongs to is still disabled underneath.
    assert.match(html, /<span class="fy-set__dot"><\/span><span class="fy-set__state">42%/);
    // Nothing to press while it is already moving.
    assert.doesNotMatch(html, DOWNLOAD_AT_SIZE);
  });

  it("states the fetch's own cause rather than the recipe's, and offers a way on", () => {
    // "1 of 1 model files missing" is true and useless here: it says nothing about the disk
    // that refused the download, which is the only thing the person can act on.
    const html = render(
      "/settings/local-runtime?group=comfyui",
      stateWith(
        weights({ state: "blocked", detail: "needs 6.5 GB plus room to work; D:\\ has 3.9 GB free" }),
        "1 of 1 model files missing from the models folder",
      ),
    );
    assert.match(html, /D:\\ has 3\.9 GB free/);
    assert.doesNotMatch(html, /1 of 1 model files missing/);
    assert.match(html, />Retry<\/button>/);
  });

  it("offers Repair once the files are on disk, and only then", () => {
    // The case Retry cannot answer: presence IS completion to it, so a checkpoint that arrived
    // whole and hashes to the wrong thing would be re-verified forever and never replaced.
    const missing = render("/settings/local-runtime?group=comfyui", stateWith(weights({})));
    assert.doesNotMatch(missing, />Repair<\/button>/, "nothing on disk to replace yet");

    const here = render("/settings/local-runtime?group=comfyui", stateWith(weights({ state: "ready" })));
    assert.match(here, />Repair<\/button>/);
  });

  it("is restated under Components until it arrives, and not after", () => {
    const outstanding = render("/settings/local-runtime?group=components", stateWith(weights({})));
    assert.match(outstanding, /Local · Draft Image · weights/, "reachable while it has not settled");

    const arrived = render("/settings/local-runtime?group=components", stateWith(weights({ state: "ready" })));
    assert.doesNotMatch(arrived, /Local · Draft Image · weights/, "the recipe's own row speaks for it now");
  });
});
