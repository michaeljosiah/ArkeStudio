import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PROVIDERS, type ClientState, type ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { resolveModel } from "../src/components/dispatch-bar.js";
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

const LOCAL_VIDEO: ManifestModel = {
  id: "comfyui-draft-video",
  provider: "comfyui",
  capability: "video",
  displayName: "Draft video",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 5 },
  pricing: { kind: "unmetered" },
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
  it("mounts under its own name", () => {
    const app = render("/settings/cloud-ai");
    assert.match(app, /data-screen="settings-cloud-ai"/);
    assert.match(plain(app), /Cloud AI/);
    assert.doesNotMatch(plain(app), /Who does what/);
  });

  it("sends each old address where its content went, rather than to a hole", async () => {
    // Asserted on the routes rather than on a render: `<Navigate>` needs a second pass and
    // `renderToString` makes one. `agents` named the per-agent overrides, and those are on
    // Harness now — sending it to Cloud AI would land it on the screen defined by not having them.
    const app = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf8");
    assert.match(app, /path="who-does-what" element=\{<Navigate to="\/settings\/cloud-ai" replace \/>\}/);
    assert.match(app, /path="agents" element=\{<Navigate to="\/settings\/harness" replace \/>\}/);
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

describe("a local default is carried, and said (R-66, R-80, D21, matrix rows 33, 36)", () => {
  const cleared = () =>
    stateWith({ routing: { defaults: {}, faults: [], clearedLocal: { llm: LOCAL_LLM.id } } });

  it("names the model and where the choice now lives, without calling it a fault", () => {
    // The worst of the three available outcomes — in force, invisible, unchangeable — is the one
    // that happens by default if nobody decides, so it is refused explicitly.
    const text = plain(render("/settings/cloud-ai", cleared()));
    assert.match(text, /Language runs on this machine/);
    assert.match(text, /Gemma 4 12B · chosen per production, at dispatch/);
    // Not "has nowhere to go": it has somewhere, and this says where.
    assert.doesNotMatch(text, /Language has nowhere to go/);
    // And it is not still offered in the list it was taken out of.
    assert.doesNotMatch(text, /Ollama · Gemma 4 12B/);
  });

  it("is what a production with no choice of its own still runs on (R-80)", () => {
    // R-80's first branch: the local-or-cloud choice exists, so the concrete model id is carried
    // rather than thrown away. Clearing it into nothing would move every production's video to a
    // paid model on the next dispatch, with nothing said at the place that spends — the dispatch
    // bar has no stored choice left to state.
    const state = stateWith({
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [CLOUD_VIDEO, LOCAL_VIDEO] },
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
            recipeId: LOCAL_VIDEO.id,
            recipeVersion: 1,
            displayName: LOCAL_VIDEO.displayName,
            capability: "video",
            state: "ready",
          },
        ],
        checkedAt: "2026-08-27T12:00:00.000Z",
      },
      routing: { defaults: {}, faults: [], clearedLocal: { video: LOCAL_VIDEO.id } },
    });
    __setStateForTest(state);
    assert.equal(resolveModel(state, "video").model?.id, LOCAL_VIDEO.id, "still where it was running");

    // And a production that has since chosen for itself outranks it.
    assert.equal(resolveModel(state, "video", undefined, CLOUD_VIDEO.id).model?.id, CLOUD_VIDEO.id);
  });
});
