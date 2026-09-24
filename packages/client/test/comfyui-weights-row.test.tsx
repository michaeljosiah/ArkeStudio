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
 *
 * The row is a tile on AI models since SPEC-042 (R-13): same facts, same controls, drawn from
 * the same `recipeFacts`, under the kind the recipe makes rather than under its engine.
 */

/** SSR splits a text node at every interpolation, so the size never abuts its label. */
const DOWNLOAD_AT_SIZE = /Download · (?:<!-- -->)?6\.5 GB/;

const RECIPE_ID = "comfyui-draft-image";
const WEIGHTS_ID = comfyUiWeightsComponentId(RECIPE_ID);

function weights(patch: Partial<SetupComponent>): SetupComponent {
  return {
    id: WEIGHTS_ID,
    // Declared, exactly as the desktop host declares it when it derives these entries from the
    // recipe catalogue — Engines groups by the owner a component names, never by its id prefix.
    engine: "comfyui",
    displayName: "Local · Draft Image · weights",
    purpose: "Model files for Local · Draft Image",
    sizeMb: 6617,
    installLocation: "D:\\ComfyUI\\models",
    state: "available",
    bytesDone: 0,
    bytesTotal: 6617 * 1024 * 1024,
    bytesPerSecond: null,
    pauseSupported: false,
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
      setup: { running: false, diskFreeMb: 100_000,
      diskCheckedAt: null, components: [component] },
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

function qwenState(source: "user-url" | "managed" | "user-path", reason?: string, downloadState: SetupComponent["state"] = "available"): ClientState {
  const state = stateWith(weights({ id: comfyUiWeightsComponentId("comfyui-qwen21-image"), sizeMb: 17284, state: downloadState }), reason);
  const comfyui = state.app.comfyui!;
  return { ...state, app: { ...state.app, comfyui: { ...comfyui,
    engine: { ...comfyui.engine, source, state: reason === "the engine did not answer" ? "unreachable" : "ready" },
    recipes: [{ ...comfyui.recipes[0]!, recipeId: "comfyui-qwen21-image", displayName: "Qwen Image 2.1 · Research", state: reason ? "disabled" : "ready" }],
  } } };
}

describe("Qwen's terms and external setup are visible before download (#1226)", () => {
  it("places the noncommercial label and official licence beside the download controls", () => {
    const html = render("/settings/models?half=local&kind=image", qwenState("managed"));
    assert.match(html, /Noncommercial research/);
    assert.match(html, /href="https:\/\/huggingface.co\/Qwen\/Qwen-Image-2.1\/blob\/main\/LICENSE"[^>]*>Licence<\/a>/);
    assert.ok(html.indexOf("Noncommercial research") < html.indexOf("Download ·"));
    assert.doesNotMatch(html, /Dedicated engine profile required/);
  });

  it("keeps external setup next to the action through offline, missing-guard and ready states", () => {
    for (const reason of ["the engine did not answer", "custom node ArkeQwen21Runtime is missing from the engine", undefined]) {
      const html = render("/settings/models?half=local&kind=image", qwenState("user-url", reason));
      assert.match(html, /Dedicated engine profile required/);
      assert.match(html, /href="https:\/\/github.com\/michaeljosiah\/ArkeStudio\/blob\/main\/docs\/development\/qwen21.md#externally-managed-url-engines"[^>]*>Setup<\/a>/);
      assert.ok(html.indexOf("Dedicated engine profile required") < html.indexOf("Download ·"));
      if (reason) assert.ok(html.includes(reason), "the measured readiness reason remains available");
    }
  });

  it("retains the licence after download without asking supervised engines for manual setup", () => {
    for (const source of ["managed", "user-path"] as const) {
      const html = render("/settings/models?half=local&kind=image", qwenState(source, undefined, "ready"));
      assert.match(html, /Noncommercial research/);
      assert.doesNotMatch(html, /Dedicated engine profile required/);
    }
  });

  it("does not attach Qwen's terms or setup to another recipe", () => {
    const state = stateWith(weights({}));
    state.app.comfyui!.engine.source = "user-url";
    const html = render("/settings/models?half=local&kind=image", state);
    assert.doesNotMatch(html, /Noncommercial research|Dedicated engine profile required|Qwen-Image-2.1\/blob/);
  });
});

describe("a recipe's weights hang off the recipe", () => {
  it("offers the download, at its size, on the row that says the files are missing", () => {
    const html = render(
      "/settings/models?half=local&kind=image",
      stateWith(weights({}), "1 of 1 model files missing from the models folder"),
    );
    assert.match(html, /data-testid="comfyui-recipe"/);
    assert.match(html, DOWNLOAD_AT_SIZE);
    // The measured refusal stays: the size says what it costs, the reason says why it is off.
    assert.match(html, /1 of 1 model files missing/);
  });

  it("reports the fetch as the recipe's own state while it runs", () => {
    const html = render(
      "/settings/models?half=local&kind=image",
      stateWith(weights({ state: "downloading", bytesDone: Math.round(6617 * 1024 * 1024 * 0.42) })),
    );
    assert.match(html, /42%/);
    assert.match(html, /fy-mtile__bar/);
    // The dot used to have to agree with the word beside it — a download in progress is not a
    // fault, even though the recipe it belongs to is still disabled underneath. Under SPEC-034
    // R-22 there is no dot to disagree: one is drawn only where something warns.
    assert.match(html, /<span class="fy-set__status"><span class="fy-set__state">42%/);
    // Nothing to press while it is already moving.
    assert.doesNotMatch(html, DOWNLOAD_AT_SIZE);
  });

  it("offers Pause only after the weights source advertises range support", () => {
    const supported = render(
      "/settings/models?half=local&kind=image",
      stateWith(weights({ state: "downloading", pauseSupported: true })),
    );
    assert.match(supported, />Pause<\/button>/);
    assert.doesNotMatch(supported, /Cannot be paused/);

    const unsupported = render(
      "/settings/models?half=local&kind=image",
      stateWith(weights({ state: "downloading", pauseSupported: false })),
    );
    assert.match(unsupported, /Cannot be paused/);
    assert.doesNotMatch(unsupported, />Pause<\/button>/);
  });

  it("keeps paused weights and their retained progress on the recipe row", () => {
    const html = render(
      "/settings/models?half=local&kind=image",
      stateWith(weights({
        state: "paused",
        bytesDone: Math.round(6617 * 1024 * 1024 * 0.42),
        pauseSupported: true,
      })),
    );
    assert.match(html, /paused · (?:<!-- -->)?42%/);
    assert.match(html, />Resume<\/button>/);
    assert.match(html, /width:42%/);
  });

  it("states the fetch's own cause rather than the recipe's, and offers a way on", () => {
    // "1 of 1 model files missing" is true and useless here: it says nothing about the disk
    // that refused the download, which is the only thing the person can act on.
    const html = render(
      "/settings/models?half=local&kind=image",
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
    const missing = render("/settings/models?half=local&kind=image", stateWith(weights({})));
    assert.doesNotMatch(missing, />Repair<\/button>/, "nothing on disk to replace yet");

    const here = render("/settings/models?half=local&kind=image", stateWith(weights({ state: "ready" })));
    assert.match(here, />Repair<\/button>/);
  });

  it("keeps a failed deletion actionable as Repair rather than an ineffective Retry", () => {
    const html = render(
      "/settings/models?half=local&kind=image",
      stateWith(weights({
        state: "failed",
        detail: "checkpoints/sd_xl_base_1.0.safetensors could not be removed — close the engine and try Repair again (EBUSY)",
        repairRequired: true,
      })),
    );
    assert.match(html, /close the engine and try Repair again/);
    assert.match(html, />Repair<\/button>/);
    assert.doesNotMatch(html, />Retry<\/button>/);

  });

  it("is stated once, on the row that acts on it, in every state", () => {
    // It used to be listed twice — on the recipe row and again under a flat Components group —
    // and `statedElsewhere` suppressed the second copy conditionally, with a rule per
    // destination. The recipe row owns it now, so there is nothing to suppress and no second
    // Download beside the first: counted, not merely looked for.
    for (const state of ["available", "downloading", "ready", "failed"] as const) {
      const html = render("/settings/models?half=local&kind=image", stateWith(weights({ state })));
      const recipes = html.match(/data-testid="comfyui-recipe"/g) ?? [];
      assert.equal(recipes.length, 1, state);
      assert.equal((html.match(/Download · (?:<!-- -->)?6\.5 GB/g) ?? []).length, state === "available" ? 1 : 0, state);
    }
    // And nowhere else: under its own kind only, never under another (SPEC-042 R-12). The
    // fixture's one other kind is the cloud video row, which is the kind to ask.
    const elsewhere = render("/settings/models?half=cloud&kind=video", stateWith(weights({})));
    assert.doesNotMatch(elsewhere, /Local · Draft Image/);
  });
});
