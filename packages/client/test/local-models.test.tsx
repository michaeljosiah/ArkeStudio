import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  activationFor,
  ActivationStateSchema,
  EngineIdSchema,
  comfyUiWeightsComponentId,
  FitVerdictSchema,
  localModelRowState,
  PROVIDERS,
  type ActivationState,
  type ClientState,
  type EngineId,
  type RecipeReadiness,
  type FitVerdict,
  type LocalRuntimeStatus,
  type ManifestModel,
  type SetupComponent,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Local AI (SPEC-033 §1.9). The screen answers *what can I make on this machine*.
 *
 * Two of its rules are boundaries rather than preferences, and both are checkable by enumerating
 * what rendered: no cloud provider appears here at all, and every capability the local plane can
 * serve keeps a rail row whether or not anything is installed under it. The rest is the
 * projection in R-26, total over two closed vocabularies — so it is tested as a table rather than
 * case by case.
 *
 * The rail draws one source at a time, so an assertion about a model row has to ask for the pane
 * of the engine that hosts its provider. `renderEngine` is that ask, and it forms the query the
 * way the screen does.
 */

const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro 82M",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "unmetered" },
  requires: { memMb: 4000 },
};

const GEMMA: ManifestModel = {
  id: "gemma4-12b",
  provider: "ollama",
  capability: "llm",
  displayName: "Gemma 4 12B",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxContextTokens: 256000 },
  pricing: { kind: "unmetered" },
  requires: { vramMb: 9600 },
};

const DRAFT_VIDEO: ManifestModel = {
  id: "comfyui-draft-video",
  provider: "comfyui",
  capability: "video",
  displayName: "Draft video",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "unmetered" },
  requires: { vramMb: 16000 },
};

/**
 * One cloud row per non-local provider, on a capability Local AI actually draws.
 *
 * A single fal row would make R-2's enumeration pass for the other four providers whatever the
 * code did, because a provider with no model in the manifest cannot render whatever the filter
 * says. The loop is only a boundary check if every provider it names has something to render.
 */
const CLOUD: ManifestModel[] = (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>)
  .filter((id) => !PROVIDERS[id].local)
  .map((id, at) => ({
    id: `cloud-${id}`,
    provider: id,
    capability: PROVIDERS[id].capabilities.find((c) => c !== "voice-clone") ?? "image",
    displayName: `Cloud model ${at}`,
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {},
    pricing: { kind: "unmetered" },
  }));

function component(patch: Partial<SetupComponent> & Pick<SetupComponent, "id">): SetupComponent {
  return {
    displayName: patch.id,
    purpose: "test",
    sizeMb: 400,
    installLocation: "C:\\ArkeStudio\\models",
    state: "present",
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: null,
    ...patch,
  };
}

function runtime(over: Partial<LocalRuntimeStatus> = {}): LocalRuntimeStatus {
  return {
    probes: {
      vramMb: 12 * 1024,
      memMb: 32 * 1024,
      diskFreeMb: 480 * 1024,
      accelerators: ["cuda"],
      platform: "win32",
    },
    detectedAt: "2026-08-27T12:00:00.000Z",
    models: [
      { modelId: KOKORO.id, provider: "kokoro", displayName: KOKORO.displayName, capability: "voice-tts", locality: "local", fit: "runs-well", reason: "Needs 3.9 GB memory · this machine has 32 GB" },
      { modelId: GEMMA.id, provider: "ollama", displayName: GEMMA.displayName, capability: "llm", locality: "local", fit: "runs-well" },
      {
        modelId: DRAFT_VIDEO.id,
        provider: "comfyui",
        displayName: DRAFT_VIDEO.displayName,
        capability: "video",
        locality: "local",
        fit: "insufficient",
        reason: "Needs 15.6 GB VRAM · this machine has 12 GB",
        cloudAlternative: "Cloud video still works via FAL.",
      },
    ],
    recommended: { llm: GEMMA.id },
    ...over,
  };
}

function stateWith(over: Partial<ClientState["app"]> = {}): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: {
        manifestVersion: 17,
        generated: "2026-08-27",
        models: [...CLOUD, KOKORO, GEMMA, DRAFT_VIDEO],
      },
      runtime: runtime(),
      setup: {
        running: false,
        diskFreeMb: 480_000,
      diskCheckedAt: null,
        components: [
          component({ id: "tts-kokoro-82m", state: "ready", provides: [KOKORO.id] }),
          component({ id: "ollama-gemma4-12b", state: "available", sizeMb: 7600, provides: [GEMMA.id] }),
          component({ id: comfyUiWeightsComponentId(DRAFT_VIDEO.id), state: "available", sizeMb: 14000 }),
        ],
      },
      ...over,
    },
  };
}

function render(state: ClientState, path = "/settings/providers?provider=ollama"): string {
  __setStateForTest(state, { setupStatus: state.app.setup });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/**
 * One engine's pane. The rail draws one at a time, so a row assertion has to ask for the engine
 * that hosts the model's provider (SPEC-034 R-7) rather than for a capability.
 */
const renderEngine = (state: ClientState, engine: EngineId): string =>
  render(state, `/settings/providers?provider=${engine}`);

/** SSR splits a text node at every interpolation, so a rendered string is checked without them. */
const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

/**
 * One model's row, from the `fy-set__row` that opens it to the one that opens the next.
 *
 * Assertions about a row have to be scoped to it: the row's own class sits before its name, the
 * reason line beneath carries a dot of its own, and the pane's footer carries a Downloads link —
 * so a document-wide match is satisfied by three things that are not the row.
 */
function rowFor(html: string, name: string): string {
  const at = html.indexOf(`>${name}<`);
  const start = html.lastIndexOf('<div class="fy-set__row', at);
  const next = html.indexOf('<div class="fy-set__row', at);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("Providers: an engine's pane, and the models it hosts (SPEC-034 R-7, R-13)", () => {
  it("mounts on Providers and groups an engine's models under it", () => {
    const text = plain(renderEngine(stateWith(), "ollama"));
    assert.match(render(stateWith()), /data-screen="settings-providers"/);
    assert.match(text, /MODELS\s+0 OF 1 INSTALLED/);
    assert.match(text, /Gemma 4 12B/);
  });

  it("names both providers where one engine hosts two, and neither where it hosts one", () => {
    // Voxa is the case R-7 exists for. Kokoro's group is headed by capability and provider; a
    // single-provider engine takes the engine's own word, because the rail item has already
    // named the provider one line above.
    const voxa = plain(renderEngine(stateWith(), "voxa"));
    assert.match(voxa, /TEXT-TO-SPEECH · KOKORO/);
    assert.doesNotMatch(plain(renderEngine(stateWith(), "ollama")), /· OLLAMA/);
  });

  it("names no cloud provider in any engine pane, in any state (SPEC-033 R-2)", () => {
    // By construction rather than by a filter applied late: the rows come from ENGINE_PROVIDERS,
    // which claims only local providers and is tested doing so in the contracts suite.
    const cloud = (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).filter((id) => !PROVIDERS[id].local);
    for (const engine of EngineIdSchema.options) {
      const text = plain(renderEngine(stateWith(), engine));
      for (const id of cloud) {
        assert.doesNotMatch(text, new RegExp(`Cloud model|${PROVIDERS[id].displayName} model`), `${engine} names ${id}`);
      }
    }
  });

  it("states a model once, never as a component beside itself (SPEC-033 R-6)", () => {
    // A component that provides a model *is* that model. Listed in the COMPONENTS band as well,
    // one fetch carried two Downloads on one pane — which is what ComfyUI's pane dropped its own
    // band to avoid, and what the other two had not caught up with. The engine's own supporting
    // pieces, which provide no model, keep their band.
    const declared = stateWith({
      setup: {
        running: false,
        diskFreeMb: 480_000,
        diskCheckedAt: null,
        components: [
          component({ id: "ollama-runtime", engine: "ollama", displayName: "Ollama runtime", state: "ready" }),
          component({
            id: "ollama-gemma4-12b",
            engine: "ollama",
            displayName: "Gemma 4 12B",
            state: "available",
            sizeMb: 7600,
            provides: [GEMMA.id],
          }),
        ],
      },
    });
    const ollama = plain(renderEngine(declared, "ollama"));
    assert.equal(ollama.match(/Gemma 4 12B/g)?.length, 1, "the model is stated once");
    assert.match(ollama, /Ollama runtime/, "and the engine's own pieces keep their band");
  });

  it("states the machine in every figure a verdict turns on (R-53, SPEC-034 R-13)", () => {
    assert.match(plain(renderEngine(stateWith(), "ollama")), /cuda · 12 GB VRAM · 32 GB memory · 480 GB free/);
  });

  it("tells not yet measured from measured and failed (R-58, rows 23, 24)", () => {
    const never = plain(renderEngine(stateWith({ runtime: null }), "ollama"));
    assert.match(never, /not measured/);
    const failed = plain(
      renderEngine(
        stateWith({ runtime: runtime({ probes: { vramMb: null, memMb: 32 * 1024, diskFreeMb: 480 * 1024, accelerators: ["cuda"], platform: "win32" } }) }),
        "ollama",
      ),
    );
    assert.match(failed, /could not measure/);
  });
});

describe("what a model row states (R-51, R-52, R-27)", () => {
  it("carries the state and the size, and nothing that never varies (SPEC-034 R-19, R-20)", () => {
    // `runs well` is the verdict that changes no decision, and `not measured` is the machine row
    // said once per model rather than once. Neither prints; the state and the size do.
    assert.match(plain(renderEngine(stateWith(), "voxa")), /Kokoro 82M\s+installed · 400 MB/);
    assert.match(plain(renderEngine(stateWith(), "ollama")), /Gemma 4 12B\s+recommended\s+available · 7\.4 GB/);
    assert.doesNotMatch(plain(renderEngine(stateWith(), "voxa")), /runs well/);
  });

  it("states runs slowly, which is the exception (SPEC-034 R-20)", () => {
    const slow = stateWith({
      runtime: runtime({
        models: runtime().models.map((m) => (m.provider === "kokoro" ? { ...m, fit: "runs-slowly" as const } : m)),
      }),
    });
    assert.match(plain(renderEngine(slow, "voxa")), /Kokoro 82M\s+installed · runs slowly · 400 MB/);
  });

  it("draws a dot only for a refusal (SPEC-034 R-22)", () => {
    // Green stood for `installed` and the word beside it had already said so; grey stood for five
    // states and separated none of them. One dot on the list is one that can be found.
    const ollama = renderEngine(stateWith(), "ollama");
    const rows = ollama.slice(ollama.indexOf("MODELS"));
    assert.doesNotMatch(rows, /fy-set__dot/);
    // Asserted on the status span, not on the row: the reason line beneath carries a warn dot
    // of its own, so a document-wide match is satisfied whether or not the status has one.
    const refusing = renderEngine(stateWith(), "comfyui");
    const status = rowFor(refusing, "Draft video");
    assert.match(status.slice(0, status.indexOf("fy-set__why")), /fy-set__dot--warn/);
    // And an installed row has none — the case the rule is named for, where green said what the
    // word beside it had already said.
    const voxa = renderEngine(stateWith(), "voxa");
    assert.doesNotMatch(rowFor(voxa, "Kokoro 82M"), /fy-set__dot/);
    // And no reason line either: a passing verdict's reason is the floor it cleared, which is
    // the good news stated as a requirement (R-21).
    assert.doesNotMatch(plain(rowFor(voxa, "Kokoro 82M")), /Needs 3\.9 GB memory/);
  });

  it("never prints not measured on a row, only in the machine's own (SPEC-034 R-20)", () => {
    // Reachable with a runtime present: the gate answers `unknown` whenever a declared floor's
    // probe came back null, and printing it per model restores the repetition R-13's row removed.
    const unknown = stateWith({
      runtime: runtime({
        models: runtime().models.map((m) => (m.provider === "kokoro" ? { ...m, fit: "unknown" as const } : m)),
      }),
    });
    const text = plain(renderEngine(unknown, "voxa"));
    assert.match(text, /Kokoro 82M\s+installed · 400 MB/);
    assert.doesNotMatch(text, /not measured/);
  });

  it("states a transfer's progress beside its size, never instead of it (SPEC-034 R-19)", () => {
    // 62 percent of what. The bar beneath is a shape; the figure belongs on the line.
    const moving = stateWith({
      setup: {
        running: true,
        diskFreeMb: 480_000,
        diskCheckedAt: null,
        components: [
          component({
            id: "ollama-gemma4-12b",
            state: "downloading",
            sizeMb: 7600,
            bytesDone: 4_712_000_000,
            bytesTotal: 7_600_000_000,
            provides: [GEMMA.id],
          }),
        ],
      },
    });
    assert.match(plain(renderEngine(moving, "ollama")), /Gemma 4 12B[\s\S]{0,40}downloading · 62% · 7\.4 GB/);
  });

  it("dims a declared refusal and leaves a measured shortfall alone (SPEC-034 R-23)", () => {
    // SPEC-033 D8: a machine short of VRAM can be given more; one with no supported accelerator
    // cannot. The row state folds the two, so the dimming reads the verdict instead.
    assert.doesNotMatch(rowFor(renderEngine(stateWith(), "comfyui"), "Draft video"), /fy-set__row--off/);
    const declared = stateWith({
      runtime: runtime({
        models: runtime().models.map((m) => (m.provider === "comfyui" ? { ...m, fit: "unsupported" as const } : m)),
      }),
    });
    assert.match(rowFor(renderEngine(declared, "comfyui"), "Draft video"), /fy-set__row--off/);
  });

  it("keeps a refusal to one clause, carrying its figures and nothing else (R-88)", () => {
    const text = plain(renderEngine(stateWith(), "comfyui"));
    // The headline says it refuses and the line beneath says by how much. `not enough here`
    // between the two said the same thing a third time and vaguer (SPEC-034 R-21).
    assert.match(text, /unsupported · 13\.7 GB/);
    assert.doesNotMatch(text, /not enough here/);
    assert.match(text, /Needs 15\.6 GB VRAM · this machine has 12 GB/);
    // The gate carries a cloud alternative and this screen does not print it: R-2 keeps every
    // cloud provider off Local AI in any state, and the smaller models R-24 offers instead are
    // the other entries in the very same row.
    assert.doesNotMatch(text, /Cloud video still works/);
  });

  it("never names a model row by its engine (row 47, R-52)", () => {
    // Model ids carry their runtime, so a row that printed one would be listing engines whether
    // it meant to or not. The pane is headed by the engine — that is R-7's arrangement — but the
    // row between the group heading and the actions still says nothing about it.
    const text = plain(renderEngine(stateWith(), "ollama"));
    const row = text.slice(text.indexOf("MODELS"));
    assert.doesNotMatch(row, /Ollama/);
    assert.doesNotMatch(row, /gemma4-12b/);
  });

  it("states a model switched off in Providers as switched off, at any row state (R-32)", () => {
    // Being turned down is a decision; unsupported, unavailable and missing are conditions, and
    // letting the first read as one of the other three sends the reader to the wrong screen.
    const text = plain(renderEngine(stateWith({ models: { disabled: [GEMMA.id] } }), "ollama"));
    assert.match(text, /Gemma 4 12B[\s\S]{0,120}turned off in Providers/);
  });

  it("says the machine has not been measured once, in its own row (SPEC-034 R-13, R-20)", () => {
    // R-28 offers an unmeasured model rather than withholding it, and R-13's row is where the
    // machine says so. Repeating it per model was the same sentence once for every row.
    const unmeasured = plain(renderEngine(stateWith({ runtime: null }), "voxa"));
    assert.match(unmeasured, /THIS MACHINE\s+not measured/);
    assert.equal(unmeasured.match(/not measured/g)?.length, 1, "once, not once per model");
    assert.match(unmeasured, /Kokoro 82M\s+installed · 400 MB/);
  });

  it("names a remote engine twice, and never on the rows it serves (SPEC-034 R-9, R-11)", () => {
    // The gate marks the models remote and the engine reports a non-loopback URL — the same
    // resolved engine answering the same question, which is why the rail and the pane cannot
    // disagree about it.
    const remote = runtime({
      models: runtime().models.map((m) =>
        m.provider === "comfyui"
          ? { modelId: m.modelId, provider: m.provider, displayName: m.displayName, capability: m.capability, locality: "remote" as const }
          : m,
      ),
    });
    const state = stateWith({
      runtime: remote,
      comfyui: {
        engine: {
          source: "user-url",
          state: "ready",
          locality: "remote",
          location: "192.168.1.44:8188",
          version: null,
          detail: null,
          detected: [],
          instanceId: "remote-1",
        },
        recipes: [],
        checkedAt: "2026-08-27T12:00:00.000Z",
      },
    });
    const rail = plain(render(state, "/settings/providers"));
    assert.match(rail, /ComfyUI\s+elsewhere/);
    const text = plain(renderEngine(state, "comfyui"));
    assert.match(text, /another machine/);
    // No verdict about this machine, and no figures for one that has none to explain (R-13).
    assert.doesNotMatch(text, /runs well|runs slowly|not enough here|not measured/);
    assert.doesNotMatch(text, /GB VRAM/);
    // And nothing this machine could act on: what is installed where the work runs is that
    // engine's business. `Downloads` is deliberately not in the list — the pane's own footer
    // carries one, unconditionally (R-25), and a negative matching it would pass regardless.
    assert.doesNotMatch(text, /Install ·|Remove|Repair|Retry/);
  });

  it("keeps this machine's engine out of a remote row's refusal (SPEC-034 R-10)", () => {
    // The weights happen to be on this machine, so the row reaches `installed` — a state that
    // was unreachable for a remote model until R-10 stopped the projection short-circuiting on
    // locality. `strandReason` answers about *this* machine's engine, and only the guard keeps
    // `the local engine is not ready` off a row another machine serves.
    const remote = runtime({
      models: runtime().models.map((m) =>
        m.provider === "comfyui"
          ? { modelId: m.modelId, provider: m.provider, displayName: m.displayName, capability: m.capability, locality: "remote" as const }
          : m,
      ),
    });
    const held = stateWith({ runtime: remote });
    const text = plain(
      renderEngine(
        stateWith({
          runtime: remote,
          setup: {
            ...held.app.setup!,
            components: held.app.setup!.components.map((c) =>
              c.id === comfyUiWeightsComponentId(DRAFT_VIDEO.id)
                ? { ...c, state: "present" as const, removable: true }
                : c,
            ),
          },
        }),
        "comfyui",
      ),
    );
    assert.match(text, /Draft video/);
    assert.doesNotMatch(text, /local engine/i);
    assert.doesNotMatch(text, /Install ·|Remove|Repair|Retry/);
  });
});

describe("Voxa states three readable voice lines, once (R-48, rows 18, 19)", () => {
  const voxa = (kokoro: string, whisper: string) => ({
    source: "bundled" as const,
    configured: true,
    bundledAvailable: true,
    executableName: "voxa.exe",
    version: "1.0.0",
    protocolVersion: 1 as const,
    architecture: "x64" as const,
    expectedArchitecture: "x64" as const,
    processState: "healthy" as const,
    endpointCompatible: true,
    failureCategory: null,
    detail: "Ready",
    configurationWarning: null,
    engines: ["kokoro", "whisper"] as Array<"kokoro" | "whisper">,
    engineStatus: {
      kokoro: { state: kokoro as "ready", detail: "" },
      whisper: { state: whisper as "ready", detail: "" },
      phonemizer: { state: "ready" as const, detail: "" },
    },
  });

  it("kokoro unavailable with whisper ready still reads as dictation usable", () => {
    const half = stateWith({ voiceRuntime: voxa("failed", "ready") });
    const text = plain(renderEngine(half, "voxa"));
    assert.match(text, /Local voices\s+failed/);
    assert.match(text, /Dictation\s+ready/);
    // Neither capability collapses to one failed state, which is SPEC-028 R-2 preserved exactly.
    // Once, not once per half: the capability rail drew this line under both because each
    // half was a different screen, and one pane must not inherit the duplication.
    assert.equal(text.match(/Conversational voice/g)?.length, 1);
    assert.match(text, /Conversational voice\s+needs both/);
  });

  it("both halves ready reads as conversational voice ready", () => {
    const ready = stateWith({ voiceRuntime: voxa("ready", "ready") });
    assert.match(plain(renderEngine(ready, "voxa")), /Conversational voice\s+ready/);
    assert.match(plain(renderEngine(ready, "voxa")), /Conversational voice\s+ready/);
  });

});

describe("a recipe is ComfyUI's model, listed once (SPEC-034 R-7, SPEC-033 R-6)", () => {
  /** The engine has answered for Draft video, so the recipe list is where it belongs. */
  const answered = (over: Partial<RecipeReadiness> = {}): ClientState =>
    stateWith({
      comfyui: {
        engine: {
          source: "managed",
          state: "ready",
          locality: "local",
          location: "127.0.0.1:8188",
          version: "0.3.48",
          detail: null,
          detected: [],
          instanceId: "local-1",
        },
        recipes: [
          {
            recipeId: DRAFT_VIDEO.id,
            recipeVersion: 1,
            displayName: DRAFT_VIDEO.displayName,
            capability: "video",
            state: "ready",
            ...over,
          },
        ],
        checkedAt: "2026-08-27T12:00:00.000Z",
      },
    });

  it("draws it under RECIPES and not again under MODELS", () => {
    // The two lists partition rather than overlap. Drawn in both, one fetch would carry two
    // Downloads on one pane — the duplication `statedElsewhere` existed to hide.
    const text = plain(renderEngine(answered(), "comfyui"));
    assert.match(text, /RECIPES/);
    assert.equal(text.match(/Draft video/g)?.length, 1);
    assert.doesNotMatch(text.slice(text.indexOf("RECIPES")), /MODELS/);
  });

  it("draws it under MODELS while the engine has not answered for it", () => {
    // With no engine resolved the recipe list is empty, and dropping the manifest row with it
    // would withhold every model this machine could install — the opposite of R-28.
    const text = plain(renderEngine(stateWith(), "comfyui"));
    assert.match(text, /MODELS/);
    assert.match(text, /Draft video/);
  });

  it("carries the fit verdict the recipe list had no way to state (SPEC-034 R-6)", () => {
    // Local AI stated this before Providers absorbed it, and a verdict with no home is what R-6
    // forbids. `insufficient` is the fixture's own verdict for Draft video.
    const text = plain(renderEngine(answered(), "comfyui"));
    // The same words a model row uses, because a recipe is a ComfyUI model: the headline says it
    // refuses and the line beneath says by how much (SPEC-034 R-20, R-21).
    assert.match(text, /unsupported/);
    assert.doesNotMatch(text, /not enough here/);
    assert.match(text, /Needs 15\.6 GB VRAM · this machine has 12 GB/);
  });

  it("states runs slowly, and neither runs well nor not measured (SPEC-034 R-20)", () => {
    const slow = answered();
    const withFit = {
      ...slow,
      app: {
        ...slow.app,
        runtime: runtime({
          models: runtime().models.map((m) => (m.provider === "comfyui" ? { ...m, fit: "runs-slowly" as const } : m)),
        }),
      },
    };
    const text = plain(renderEngine(withFit, "comfyui"));
    assert.match(text, /runs slowly/);
    const well = {
      ...slow,
      app: {
        ...slow.app,
        runtime: runtime({
          models: runtime().models.map((m) => (m.provider === "comfyui" ? { ...m, fit: "runs-well" as const } : m)),
        }),
      },
    };
    assert.doesNotMatch(plain(renderEngine(well, "comfyui")), /runs well|not measured/);
  });

  it("marks the one recommendation, which for images and video is always a recipe", () => {
    // `localPreference` names recipes for both, so a recommendation filtered out of the model
    // group has nowhere else to appear (SPEC-033 §1.7).
    const state = answered();
    const recommended = {
      ...state,
      app: { ...state.app, runtime: runtime({ recommended: { video: DRAFT_VIDEO.id } }) },
    };
    assert.match(plain(renderEngine(recommended, "comfyui")), /recommended/);
  });

  it("dims a declared refusal and leaves a measured shortfall alone", () => {
    // SPEC-033 D8: a machine short of VRAM can be given more; one with no supported accelerator
    // cannot. Only the second recedes.
    const state = answered();
    const declared = {
      ...state,
      app: {
        ...state.app,
        runtime: runtime({
          models: runtime().models.map((m) => (m.provider === "comfyui" ? { ...m, fit: "unsupported" as const } : m)),
        }),
      },
    };
    assert.match(renderEngine(declared, "comfyui"), /fy-set__row--off/);
  });
});

describe("the row state is a projection, never a new vocabulary (R-26)", () => {
  const FITS: Array<FitVerdict | undefined> = [...FitVerdictSchema.options, undefined];
  const ACTIVATIONS: ActivationState[] = [...ActivationStateSchema.options];

  // The table transcribed from the specification, not from the implementation. Membership in
  // the return type is guaranteed by TypeScript and proves nothing; the mapping is the claim.
  const expected = (fit: FitVerdict | undefined, activation: ActivationState): string => {
    if (fit === "insufficient" || fit === "unsupported") return "unsupported";
    if (activation === "ready") return "installed";
    if (activation === "not-installed") return "available";
    return activation;
  };

  it("is R-26's table exactly, over every combination of the two vocabularies", () => {
    for (const fit of FITS) {
      for (const activation of ACTIVATIONS) {
        assert.equal(localModelRowState(fit, activation), expected(fit, activation), `${fit} × ${activation}`);
      }
    }
  });


  it("a refusing fit is Unsupported whatever the transfer is doing (row 14, row 16)", () => {
    // The case the old vocabulary could not form: downloading onto hardware that will not run it.
    for (const fit of ["insufficient", "unsupported"] as FitVerdict[]) {
      for (const activation of ACTIVATIONS) {
        assert.equal(localModelRowState(fit, activation), "unsupported");
      }
    }
  });

  it("an unmeasured machine is offered, never withheld (R-28)", () => {
    assert.equal(localModelRowState("unknown", "ready"), "installed");
    assert.equal(localModelRowState("unknown", "not-installed"), "available");
  });
});

describe("activation is read from the ledger, not inferred from an id (R-39)", () => {
  const ready = component({ id: "tts-kokoro-82m", state: "ready", provides: ["kokoro-82m"] });

  it("follows the component that declares it provides the model", () => {
    assert.equal(activationFor("kokoro", "kokoro-82m", { components: [ready] }), "ready");
    assert.equal(
      activationFor("kokoro", "kokoro-82m", { components: [{ ...ready, state: "downloading" }] }),
      "downloading",
    );
  });

  it("a model nothing provides is absent rather than claimed either way", () => {
    assert.equal(activationFor("ollama", "llama3.3-70b", { components: [ready] }), "not-installed");
  });

  it("does not read the optional managed-runtime component as the model's own state", () => {
    // Somebody running their own ComfyUI never installs `comfyui-runtime`, so it sits at
    // `available` forever. Folding it in printed `available` beside weights that were
    // downloaded, installed and dispatching — the one word this screen exists to state.
    const weights = component({ id: comfyUiWeightsComponentId("comfyui-draft-image"), state: "ready" });
    const runtime = component({ id: "comfyui-runtime", state: "available" });
    assert.equal(
      activationFor("comfyui", "comfyui-draft-image", {
        components: [weights, runtime],
        comfyUiEngineState: "ready",
      }),
      "ready",
    );
  });

  it("a model's own absence is final — a busy engine does not make it starting", () => {
    // Nothing is coming for a model whose weights were never fetched, whatever the engine is
    // doing, so the row reads Available rather than starting or needing attention.
    const absent = component({ id: comfyUiWeightsComponentId("comfyui-draft-video"), state: "available" });
    for (const engine of ["starting", "unreachable", "failed", "absent"] as const) {
      assert.equal(
        activationFor("comfyui", "comfyui-draft-video", { components: [absent], comfyUiEngineState: engine }),
        "not-installed",
        engine,
      );
    }
  });

  it("an absent engine leaves an installed model installed, for eligibility to refuse (R-31)", () => {
    const weights = component({ id: comfyUiWeightsComponentId("comfyui-draft-video"), state: "ready" });
    assert.equal(
      activationFor("comfyui", "comfyui-draft-video", { components: [weights], comfyUiEngineState: "absent" }),
      "ready",
    );
  });

  it("a ComfyUI recipe takes the worst of its engine and its derived weights component", () => {
    const weights = component({ id: comfyUiWeightsComponentId("comfyui-draft-video"), state: "ready" });
    assert.equal(activationFor("comfyui", "comfyui-draft-video", { components: [weights] }), "ready");
    assert.equal(
      activationFor("comfyui", "comfyui-draft-video", { components: [{ ...weights, state: "failed" }] }),
      "needs-attention",
    );
    // An engine that has not finished starting is a model that has not finished starting —
    // but only once the model's own files are here.
    assert.equal(
      activationFor("comfyui", "comfyui-draft-video", {
        components: [weights],
        comfyUiEngineState: "starting",
      }),
      "starting",
    );
    assert.equal(
      activationFor("comfyui", "comfyui-draft-video", {
        components: [weights],
        comfyUiEngineState: "unreachable",
      }),
      "needs-attention",
    );
  });
});
