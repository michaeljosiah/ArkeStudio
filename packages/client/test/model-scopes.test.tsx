import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { Capability, ClientState, ManifestModel } from "@arke-studio/contracts";
import { DispatchBar, useResolvedModel } from "../src/components/dispatch-bar.js";
import { ModelsCard, withModelChoice } from "../src/components/models-card.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Models for a world and for a production (design turn 153).
 *
 * Two scopes, one parent: world work reads the world's choice, production work the production's,
 * and each falls back to Settings — never to the other. A world's choice was for making the
 * world; a production that wants the same model says so on its own card.
 */

const SEEDANCE = FIXTURE_STATE.app.manifest!.models[0]!;
const KLING: ManifestModel = { ...SEEDANCE, id: "kling-3", displayName: "Kling 3.0" };
const VEO: ManifestModel = { ...SEEDANCE, id: "veo-3", displayName: "Veo 3" };

function stateWith(scopes: {
  world?: Partial<Record<Capability, string>>;
  production?: Partial<Record<Capability, string>>;
}): ClientState {
  const base = FIXTURE_STATE;
  return {
    ...base,
    app: { ...base.app, manifest: { ...base.app.manifest!, models: [SEEDANCE, KLING, VEO] } },
    world: {
      ...base.world!,
      meta: { ...base.world!.meta, ...(scopes.world ? { models: scopes.world } : {}) },
      productions: base.world!.productions.map((p) =>
        p.meta.id === "saltlight" && scopes.production ? { ...p, meta: { ...p.meta, models: scopes.production } } : p,
      ),
    },
  };
}

const worldPath = (state: ClientState) => `/w/${state.world!.meta.worldId}/art-direction`;
const productionPath = (state: ClientState) => `/w/${state.world!.meta.worldId}/p/saltlight/generate`;

function hostModel(state: ClientState, path: string): string | null {
  let seen: string | null = null;
  function Host() {
    seen = useResolvedModel(state, "video").model?.id ?? null;
    return null;
  }
  __setStateForTest(state);
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId/generate" element={<Host />} />
        <Route path="/w/:worldId/art-direction" element={<Host />} />
      </Routes>
    </MemoryRouter>,
  );
  return seen;
}

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

describe("two scopes, one parent", () => {
  it("gives world work the world's choice and production work the production's", () => {
    const state = stateWith({ world: { video: KLING.id }, production: { video: VEO.id } });
    assert.equal(hostModel(state, worldPath(state)), KLING.id);
    assert.equal(hostModel(state, productionPath(state)), VEO.id);
  });

  it("never lets a production inherit its world's choice — it falls back to Settings", () => {
    const state = stateWith({ world: { video: KLING.id } });
    assert.equal(hostModel(state, productionPath(state)), SEEDANCE.id);
  });

  it("names the world's choice as the world's in the bar, not the production's", () => {
    const state = stateWith({ world: { video: KLING.id } });
    __setStateForTest(state);
    const text = plain(
      renderToString(
        <MemoryRouter initialEntries={[worldPath(state)]}>
          <Routes>
            <Route
              path="/w/:worldId/art-direction"
              element={
                <DispatchBar
                  variant="full"
                  capability="video"
                  workflow="main-photo"
                  choice={{}}
                  onChoice={() => {}}
                  primaryLabel="Dispatch"
                  onPrimary={() => {}}
                  onCancel={() => {}}
                />
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    );
    assert.match(text, /Kling 3\.0/);
    assert.match(text, /THIS WORLD/);
    assert.doesNotMatch(text, /THIS PRODUCTION/);
  });
});

function card(state: ClientState, choices: Partial<Record<Capability, string>> | undefined): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter>
      <ModelsCard state={state} capabilities={["video"]} choices={choices} scopeWord="this world" onChange={() => {}} />
    </MemoryRouter>,
  );
}

describe("the Models card", () => {
  it("follows Settings until chosen, and says so", () => {
    const html = card(stateWith({}), undefined);
    const text = plain(html);
    assert.match(text, /Models/);
    assert.match(text, /\bdefault\b/);
    assert.doesNotMatch(text, /this world/);
    assert.doesNotMatch(html, /aria-label="Use the default"/, "nothing to reset when nothing was chosen");
    // The default is one option, first, named by its model — and not offered a second time.
    const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    assert.equal(options[0], "FAL · Seedance 2.0 · default");
    assert.equal(options.filter((o) => o?.includes("Seedance")).length, 1);
    assert.ok(html.includes('aria-label="AI models"'), "the way to the other models is on the card");
  });

  it("says whose choice an override is, and offers the way back", () => {
    const text = plain(card(stateWith({}), { video: KLING.id }));
    assert.match(text, /this world/);
    assert.match(card(stateWith({}), { video: KLING.id }), /aria-label="Use the default"/);
  });

  it("keeps an override that can no longer run, and says why, rather than showing the default", () => {
    const state = stateWith({});
    const off = { ...state, app: { ...state.app, models: { disabled: [KLING.id] } } };
    const html = card(off, { video: KLING.id });
    assert.match(plain(html), /turned off/);
    assert.match(html, /<option[^>]*value="kling-3"[^>]*>FAL · Kling 3\.0<\/option>/);
  });

  it("removes a capability on reset, and the map with its last entry", () => {
    assert.deepEqual(withModelChoice({ video: "a", image: "b" }, "video", null), { image: "b" });
    assert.equal(withModelChoice({ video: "a" }, "video", null), undefined);
    assert.deepEqual(withModelChoice(undefined, "image", "c"), { image: "c" });
  });
});
