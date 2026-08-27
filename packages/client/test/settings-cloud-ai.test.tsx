import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PROVIDERS, type ClientState, type ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { LOCAL_AI_ROWS } from "../src/screens/settings-local-ai.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Cloud AI (SPEC-033 §1.10). Which remote model runs each capability.
 *
 * Two boundaries are load-bearing and both are checkable by enumerating what rendered: no local
 * model appears here in any state, and the five capability words are the five words Local AI
 * uses. The second is what makes the split read as two halves of one question rather than as an
 * arbitrary line — which is why the duplication across the two screens is deliberate.
 */

const LOCAL_LLM: ManifestModel = {
  id: "gemma4-12b",
  provider: "ollama",
  capability: "llm",
  displayName: "Gemma 4 12B",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxContextTokens: 256000 },
  pricing: { kind: "unmetered" },
};

const CLOUD_LLM: ManifestModel = {
  id: "gpt-5",
  provider: "openai",
  capability: "llm",
  displayName: "GPT-5",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perToken", microUsdPerMillionInput: 1, microUsdPerMillionOutput: 1 },
};

const CLOUD_VIDEO = FIXTURE_STATE.app.manifest!.models[0]!;

function stateWith(over: Partial<ClientState["app"]> = {}): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [CLOUD_VIDEO, CLOUD_LLM, LOCAL_LLM] },
      ...over,
    },
  };
}

function render(path: string, state: ClientState = stateWith()): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

describe("Cloud AI: cloud-only, absolutely (R-3, R-61, matrix row 38)", () => {
  it("mounts under its own name, and the old addresses still answer", () => {
    assert.match(render("/settings/cloud-ai"), /data-screen="settings-cloud-ai"/);
    // Two addresses that no longer name a screen; neither may become a hole.
    const app = render("/settings/cloud-ai");
    assert.match(app, /Cloud AI/);
    assert.doesNotMatch(plain(app), /Who does what/);
  });

  it("lists no local model, in any state, including disabled", () => {
    const text = plain(render("/settings/cloud-ai", stateWith({ models: { disabled: [LOCAL_LLM.id] } })));
    assert.match(text, /GPT-5/, "the cloud model for the same capability is there");
    assert.doesNotMatch(text, /Gemma 4 12B/);
    assert.doesNotMatch(text, /Ollama/);
    for (const [id, info] of Object.entries(PROVIDERS)) {
      if (!info.local) continue;
      assert.doesNotMatch(text, new RegExp(info.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), id);
    }
  });

  it("speaks the five words Local AI speaks, in the same order (R-62, R-89, row 43)", () => {
    const text = plain(render("/settings/cloud-ai"));
    let at = 0;
    for (const row of LOCAL_AI_ROWS) {
      const found = text.indexOf(row.label, at);
      assert.notEqual(found, -1, `${row.label} is missing from Cloud AI`);
      at = found;
    }
    // The retired vocabulary: ours rather than a creator's.
    for (const gone of ["Clips", "Frames & stills", "Score & songs", "Direct LLM work"]) {
      assert.doesNotMatch(text, new RegExp(gone.replace(/&/g, "&amp;")), gone);
    }
  });

  it("names a model's provider and that provider's connection state (R-63)", () => {
    const text = plain(
      render(
        "/settings/cloud-ai",
        stateWith({
          routing: { defaults: { llm: CLOUD_LLM.id }, faults: [] },
          providers: [
            { id: "fal", configured: true, validation: "valid", probes: [], fault: null },
            { id: "openai", configured: true, validation: "valid", probes: [], fault: null },
          ],
        }),
      ),
    );
    assert.match(text, /OpenAI · connected/);
    // The remedy is a route to Providers, never a key field on this screen.
    assert.match(text, /Open Providers/);
    assert.doesNotMatch(text, /sk-/);
  });

  it("does not carry the per-agent overrides; Harness does (R-65, matrix row 46)", () => {
    assert.doesNotMatch(plain(render("/settings/cloud-ai")), /which model runs each writing agent/);
    assert.match(plain(render("/settings/harness")), /which model runs each writing agent/);
  });
});

describe("a local default is cleared, and said (R-66, D21, matrix row 36)", () => {
  it("names what was taken away and where the choice now lives", () => {
    // The worst of the three available outcomes — in force, invisible, unchangeable — is the one
    // that happens by default if nobody decides, so it is refused explicitly.
    const text = plain(
      render(
        "/settings/cloud-ai",
        stateWith({
          routing: {
            defaults: {},
            faults: [
              {
                capability: "llm",
                modelId: LOCAL_LLM.id,
                reason:
                  "Gemma 4 12B ran on this machine and was cleared here — local models are now chosen per production, at dispatch",
              },
            ],
          },
        }),
      ),
    );
    assert.match(text, /Gemma 4 12B ran on this machine and was cleared here/);
    assert.match(text, /chosen per production, at dispatch/);
    // And it is not still offered in the list it was cleared from.
    assert.doesNotMatch(text, /Ollama · Gemma 4 12B/);
  });
});
