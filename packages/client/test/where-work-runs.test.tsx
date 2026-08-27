import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { Capability, ClientState, ManifestModel } from "@arke-studio/contracts";
import { DispatchBar, productionModel, resolveModel } from "../src/components/dispatch-bar.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Where a production's work runs, at dispatch (SPEC-033 §1.12).
 *
 * The choice seeds the picker and does not lock it (R-77), and one that cannot be honoured is
 * stated rather than silently swapped (R-78) — falling back quietly is how somebody discovers
 * they spent money three weeks later.
 */

const LOCAL: ManifestModel = {
  id: "comfyui-draft-video",
  provider: "comfyui",
  capability: "video",
  displayName: "Draft video",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 5 },
  pricing: { kind: "unmetered" },
};

const CLOUD = FIXTURE_STATE.app.manifest!.models[0]!;

function stateWith(models: Partial<Record<Capability, string>> | undefined, opts: { recipeReady?: boolean } = {}): ClientState {
  const base = FIXTURE_STATE;
  return {
    ...base,
    app: {
      ...base.app,
      manifest: { ...base.app.manifest!, models: [CLOUD, LOCAL] },
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
            recipeId: LOCAL.id,
            recipeVersion: 1,
            displayName: LOCAL.displayName,
            capability: "video",
            state: opts.recipeReady === false ? "disabled" : "ready",
            ...(opts.recipeReady === false ? { reason: "the engine did not answer" } : {}),
          },
        ],
        checkedAt: "2026-08-27T12:00:00.000Z",
      },
    },
    world: {
      ...base.world!,
      productions: base.world!.productions.map((p) =>
        p.meta.id === "saltlight"
          ? { ...p, meta: { ...p.meta, ...(models === undefined ? {} : { models }) } }
          : p,
      ),
    },
  };
}

/** The bar reads the production from the address, so the test has to give it one. */
function renderBar(state: ClientState, path = `/w/${state.world!.meta.worldId}/p/saltlight/generate`): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/w/:worldId/p/:prodId/generate"
          element={<DispatchBar variant="controls" capability="video" workflow="main-photo" choice={{}} onChoice={() => {}} />}
        />
        <Route
          path="/w/:worldId/art-direction"
          element={<DispatchBar variant="controls" capability="video" workflow="main-photo" choice={{}} onChoice={() => {}} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

describe("the production's choice seeds the picker (R-77, row 32)", () => {
  it("opens on the model the production named, over the installation's default", () => {
    // The fixture routes video to the cloud model; this production says otherwise, and the
    // stored value is a concrete reference so it says *which* model rather than `local`.
    const text = plain(renderBar(stateWith({ video: LOCAL.id })));
    assert.match(text, /Draft video/);
    assert.match(text, /THIS PRODUCTION/);
    assert.doesNotMatch(text, /Seedance/);
  });

  it("does not lock it — an explicit per-dispatch choice still wins (R-77)", () => {
    const state = stateWith({ video: LOCAL.id });
    __setStateForTest(state);
    assert.equal(resolveModel(state, "video", CLOUD.id, LOCAL.id).model?.id, CLOUD.id);
  });

  it("leaves a production with no choice on whatever the picker would have opened on", () => {
    const text = plain(renderBar(stateWith(undefined)));
    assert.match(text, /Seedance/);
    assert.doesNotMatch(text, /THIS PRODUCTION/);
  });

  it("is absent outside a production, because it is not an installation setting", () => {
    const state = stateWith({ video: LOCAL.id });
    __setStateForTest(state);
    assert.equal(productionModel(state, undefined, "video"), undefined);
    const text = plain(renderBar(state, `/w/${state.world!.meta.worldId}/art-direction`));
    assert.doesNotMatch(text, /THIS PRODUCTION/);
  });
});

describe("a choice that cannot be honoured is stated, never swapped (R-78, row 35)", () => {
  it("shows the named model, says it is unavailable, and blocks rather than spending", () => {
    const state = stateWith({ video: LOCAL.id }, { recipeReady: false });
    const text = plain(renderBar(state));
    assert.match(text, /Draft video/, "the model the production named, not a substitute");
    assert.match(text, /UNAVAILABLE/);
    assert.match(text, /unavailable, the engine did not answer/);
    // And it is the reason the readiness answer gives — the same one enqueue admission enforces,
    // never a second one composed here.
    assert.doesNotMatch(text, /Seedance/, "nothing was quietly swapped in");
  });
});
