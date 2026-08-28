import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PROVIDERS, type ClientState, type ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { CAPABILITY_ROWS } from "../src/screens/settings-parts.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · General (SPEC-034 §1.6). Which model runs each capability by default.
 *
 * It was Cloud AI, and its defining rule was that no local model appeared here in any state.
 * That rule is what changes: SPEC-034 R-15 lists both halves, because the defect R-61 answered
 * was never *a local model appeared* — it was *a model that could not run was selectable*, and
 * eligibility refuses that directly, in the picker and again in the write.
 *
 * The rows are still a subset of the shared capability table: `voice-stt` and `voice-clone` have
 * no routing default, and `llm` left with R-17 because it wrote a setting nothing read. What
 * every surface shares is the vocabulary, not the row list.
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

/**
 * A local video recipe the engine has answered for, so `modelEligible` admits it. Without a
 * ready recipe a ComfyUI model is refused, which is R-15a working rather than R-15 failing.
 */
function localVideoReady(
  defaults: Record<string, string> = {},
  locality: "local" | "remote" = "local",
): ClientState {
  return stateWith({
    manifest: { ...FIXTURE_STATE.app.manifest!, models: [CLOUD_VIDEO, LOCAL_VIDEO] },
    comfyui: {
      engine: {
        source: "managed",
        state: "ready",
        locality,
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
    routing: { defaults: defaults as ClientState["app"]["routing"]["defaults"], faults: [] },
  });
}

describe("General: both halves in one list (SPEC-034 R-14, R-15, R-16a)", () => {
  it("mounts under its own name", () => {
    const app = render("/settings/general");
    assert.match(app, /data-screen="settings-general"/);
    assert.match(plain(app), /General/);
    assert.doesNotMatch(plain(app), /Who does what|Cloud AI/);
  });

  it("sends each old address where its content went, rather than to a hole", async () => {
    // Asserted on the routes rather than on a render: `<Navigate>` needs a second pass and
    // `renderToString` makes one. `agents` named the per-agent overrides, and those are on
    // Harness now — sending it to Cloud AI would land it on the screen defined by not having them.
    const app = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf8");
    assert.match(app, /path="who-does-what" element=\{<Navigate to="\/settings\/general" replace \/>\}/);
    assert.match(app, /path="agents" element=\{<Navigate to="\/settings\/harness" replace \/>\}/);
  });

  it("lists a local model beside a cloud one, which R-61 forbade", () => {
    // The filter went because the defect was never *a local model appeared* — it was *a model
    // that could not run was selectable*, and eligibility refuses that directly now (R-15a).
    const text = plain(render("/settings/general", localVideoReady()));
    assert.match(text, /ComfyUI · Draft video/);
    assert.match(text, new RegExp(`· ${CLOUD_VIDEO.displayName}`));
  });

  it("offers an ineligible model, unselectable, rather than hiding it (R-15a)", () => {
    // SPEC-033 R-64's shape for a cloud model with no key, applied to both halves: an option
    // nobody can choose is still an option somebody should know exists.
    // The recipe list is empty, so the engine has not answered for Draft video and eligibility
    // refuses it — which is R-15a working rather than R-15 failing.
    const html = render(
      "/settings/general",
      stateWith({ manifest: { ...FIXTURE_STATE.app.manifest!, models: [CLOUD_VIDEO, LOCAL_VIDEO] } }),
    );
    assert.match(html, /Draft video/);
    const option = html.slice(html.indexOf('value="comfyui-draft-video"'));
    assert.match(option.slice(0, 200), /disabled/);
  });

  it("says where a default actually runs, from the resolved engine (R-16a)", () => {
    const here = plain(render("/settings/general", localVideoReady({ video: LOCAL_VIDEO.id })));
    assert.match(here, /ComfyUI · this machine/);
    // `PROVIDERS.comfyui.local` is `true` either way, so a clause reading the provider flag would
    // tell someone their video drafts here while it renders on a box down the hall.
    const elsewhere = plain(render("/settings/general", localVideoReady({ video: LOCAL_VIDEO.id }, "remote")));
    assert.match(elsewhere, /ComfyUI · another machine/);
    assert.doesNotMatch(elsewhere, /ComfyUI · this machine/);
  });

  it("draws no Language picker, only the route to the harness that writes (R-17)", () => {
    const text = plain(render("/settings/general"));
    assert.match(text, /Language\s+on Harness/);
    assert.doesNotMatch(text, /Anthropic · |OpenAI · /);
  });

  it("speaks Local AI's words for the capabilities it routes, in the same order (R-62, R-89, row 43)", () => {
    const text = plain(render("/settings/general"));
    // Neither screen's rows are the other's. `voice-stt` and `voice-clone` have no cloud routing
    // default and are not drawn here; `music` has no local engine and is not drawn there. What
    // both read off the one table is the *words* (R-89), in the table's order — so a rename
    // cannot move only one of them.
    const routed = CAPABILITY_ROWS.filter((row) =>
      row.capabilities.some((c) => c === "image" || c === "video" || c === "voice-tts" || c === "music" || c === "llm"),
    );
    assert.deepEqual(
      routed.map((row) => row.label),
      ["Images", "Video", "Text-to-Speech", "Music", "Language"],
    );
    let at = 0;
    for (const row of routed) {
      const found = text.indexOf(row.label, at);
      assert.notEqual(found, -1, `${row.label} is missing from General`);
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
        "/settings/general",
        stateWith({
          routing: { defaults: { video: CLOUD_VIDEO.id }, faults: [] },
          providers: [
            {
              id: "fal",
              configured: true,
              validation: "valid",
              probes: [{ capability: "video" as const, available: true }],
              fault: null,
            },
            { id: "openai", configured: true, validation: "valid", probes: [], fault: null },
          ],
        }),
      ),
    );
    assert.match(text, new RegExp(`${PROVIDERS[CLOUD_VIDEO.provider].displayName} · connected`));
    // The remedy is Providers, and it is reached from the rail rather than from a button at the
    // foot: SPEC-034 R-4 removes that button because there is no longer anywhere else to route
    // to, and frame 112d draws none.
    assert.doesNotMatch(text, /Open Providers/);
    assert.doesNotMatch(text, /sk-/);
  });

  it("does not carry the per-agent overrides; Harness does (R-65, matrix row 46)", () => {
    assert.doesNotMatch(plain(render("/settings/general")), /which model runs each writing agent/);
    assert.match(plain(render("/settings/harness")), /which model runs each writing agent/);
  });
});


