import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  activationFor,
  ActivationStateSchema,
  CLONED_VOICE_MODEL,
  comfyUiWeightsComponentId,
  FitVerdictSchema,
  localModelRowState,
  PROVIDERS,
  type ActivationState,
  type ClientState,
  type FitVerdict,
  type LocalRuntimeStatus,
  type ManifestModel,
  type SetupComponent,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { LOCAL_AI_ROWS } from "../src/screens/settings-local-ai.js";
import { CAPABILITY_LABEL, CAPABILITY_ROWS } from "../src/screens/settings-parts.js";
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
 * The rail draws one capability at a time, so an assertion about a model row has to ask for that
 * row's pane. `renderRow` is that ask, and it forms the query the way the screen does.
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

function render(state: ClientState, path = "/settings/local-ai"): string {
  __setStateForTest(state, { setupStatus: state.app.setup });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/** The rail's own slug, the way the screen forms it — the query the URL carries per row. */
const slug = (label: string): string => label.toLowerCase().replace(/[^a-z]+/g, "-");

/** One capability's pane. The rail draws one at a time, so a row assertion has to ask for it. */
const renderRow = (state: ClientState, label: string): string =>
  render(state, `/settings/local-ai?capability=${slug(label)}`);

/** SSR splits a text node at every interpolation, so a rendered string is checked without them. */
const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

describe("Local AI: every capability the local plane serves, and no cloud provider (SPEC-033 R-2, R-47, R-50)", () => {
  it("mounts at its own route and states the capabilities in order", () => {
    const text = plain(render(stateWith()));
    assert.match(render(stateWith()), /data-screen="settings-local-ai"/);
    const order = ["Images", "Video", "Speech-to-Text", "Text-to-Speech", "Voice clone", "Language"];
    assert.deepEqual(
      LOCAL_AI_ROWS.map((row) => row.label),
      order,
      "the rail's order is the specification's",
    );
    let at = 0;
    for (const row of order) {
      const found = text.indexOf(row, at);
      assert.notEqual(found, -1, `${row} is missing from the Local AI rail`);
      at = found;
    }
  });

  it("opens on the first row, and follows the one the URL names", () => {
    assert.match(plain(render(stateWith())), /IMAGES\s+NO LOCAL MODELS/);
    assert.match(plain(renderRow(stateWith(), "Language")), /LANGUAGE\s+0 OF 1 INSTALLED/);
  });

  it("does not draw Music, which nothing local serves (R-50)", () => {
    // A row for a capability no local engine has is an offer this machine cannot honour. The word
    // survives in the shared table for Cloud AI, which routes music and has to name it — so the
    // two lists differ by exactly that row, and the vocabulary R-89 shares is unbroken.
    assert.doesNotMatch(plain(render(stateWith())), /Music/);
    // A query naming a row this screen does not draw falls back to the first, rather than to a
    // pane with a heading and nothing under it.
    assert.doesNotMatch(plain(renderRow(stateWith(), "Music")), /MUSIC/);
    assert.equal(CAPABILITY_LABEL.music, "Music");
    assert.deepEqual(
      CAPABILITY_ROWS.filter((row) => !LOCAL_AI_ROWS.includes(row)).map((row) => row.label),
      ["Music"],
    );
  });

  it("keeps drawing a row whose models are all uninstalled (R-50)", () => {
    // The absence R-50 protects is *nothing installed yet*, which is a state somebody can change.
    // It is not the same as a capability with no local engine behind it at all.
    assert.match(plain(render(stateWith())), /Language\s+0\/1/);
  });

  it("names no cloud provider, in any state, under any row (row 37, R-2)", () => {
    assert.ok(CLOUD.length >= 4, "the manifest under test must carry a row for each of them");
    for (const row of LOCAL_AI_ROWS) {
      const text = plain(renderRow(stateWith(), row.label));
      for (const [id, info] of Object.entries(PROVIDERS)) {
        if (info.local) continue;
        assert.doesNotMatch(
          text,
          new RegExp(info.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          `${id} under ${row.label}`,
        );
      }
      // And not one of their models, in any state.
      for (const model of CLOUD) {
        assert.doesNotMatch(text, new RegExp(model.displayName), `${model.id} under ${row.label}`);
        assert.doesNotMatch(text, new RegExp(model.id), `${model.id} under ${row.label}`);
      }
    }
  });

  it("gives every capability a local provider declares exactly one row (R-47)", () => {
    // `voice-clone` is the hole this closes: nothing local declares it today, so a local model
    // that did would render in no row at all and no other assertion would notice.
    const local = new Set(
      (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>)
        .filter((id) => PROVIDERS[id].local)
        .flatMap((id) => PROVIDERS[id].capabilities),
    );
    const drawn = LOCAL_AI_ROWS.flatMap((row) => row.capabilities);
    for (const capability of local) {
      assert.equal(
        drawn.filter((c) => c === capability).length,
        1,
        `${capability} is declared by a local provider and drawn in ${drawn.filter((c) => c === capability).length} rows`,
      );
    }
  });

  it("states the machine in every figure a verdict turns on (R-53)", () => {
    const text = plain(render(stateWith()));
    assert.match(text, /cuda · 12 GB VRAM · 32 GB memory · 480 GB free/);
  });

  it("tells not yet measured from measured and failed (R-58, rows 23, 24)", () => {
    const never = plain(render(stateWith({ runtime: null })));
    assert.match(never, /not measured · not measured VRAM/);
    assert.doesNotMatch(never, /0 GB/);

    const failed = plain(
      render(
        stateWith({
          runtime: runtime({
            probes: { vramMb: null, memMb: 32 * 1024, diskFreeMb: 480 * 1024, accelerators: [], platform: "win32" },
          }),
        }),
      ),
    );
    assert.match(failed, /none · could not measure VRAM/);
  });
});

describe("Local AI: what a model row states (R-51, R-52, R-27)", () => {
  it("carries the state, the verdict and the size, and marks the one recommendation", () => {
    assert.match(plain(renderRow(stateWith(), "Text-to-Speech")), /Kokoro 82M\s+installed · runs well · 400 MB/);
    assert.match(
      plain(renderRow(stateWith(), "Language")),
      /Gemma 4 12B\s+recommended\s+available · runs well · 7\.4 GB/,
    );
  });

  it("keeps a refusal to one clause, carrying its figures and nothing else (R-88)", () => {
    const text = plain(renderRow(stateWith(), "Video"));
    assert.match(text, /unsupported · not enough here · 13\.7 GB/);
    assert.match(text, /Needs 15\.6 GB VRAM · this machine has 12 GB/);
    // The gate carries a cloud alternative and this screen does not print it: R-2 keeps every
    // cloud provider off Local AI in any state, and the smaller models R-24 offers instead are
    // the other entries in the very same row.
    assert.doesNotMatch(text, /Cloud video still works/);
  });

  it("never heads or names a row by its engine (row 47, R-52)", () => {
    // Model ids carry their runtime, so a row that printed one would be listing engines whether
    // it meant to or not. The engine is a fact of the Engines screen, available in the detail.
    const text = plain(renderRow(stateWith(), "Language"));
    assert.doesNotMatch(text, /Ollama/);
    assert.doesNotMatch(text, /gemma4-12b/);
  });

  it("states a model switched off in Providers as switched off, at any row state (R-32)", () => {
    // Being turned down is a decision; unsupported, unavailable and missing are conditions, and
    // letting the first read as one of the other three sends the reader to the wrong screen.
    const text = plain(renderRow(stateWith({ models: { disabled: [GEMMA.id] } }), "Language"));
    assert.match(text, /Gemma 4 12B[\s\S]{0,120}turned off in Providers/);
  });

  it("says the machine has not been measured on the row, not only in the header (R-28)", () => {
    const unmeasured = stateWith({ runtime: null });
    assert.match(plain(renderRow(unmeasured, "Text-to-Speech")), /Kokoro 82M\s+installed · not measured · 400 MB/);
    assert.match(plain(renderRow(unmeasured, "Language")), /Gemma 4 12B\s+available · not measured · 7\.4 GB/);
  });

  it("routes a remote engine's models out rather than judging them here (row 10, R-11)", () => {
    const remote = runtime({
      models: runtime().models.map((m) =>
        m.provider === "comfyui"
          ? { modelId: m.modelId, provider: m.provider, displayName: m.displayName, capability: m.capability, locality: "remote" as const }
          : m,
      ),
    });
    const text = plain(renderRow(stateWith({ runtime: remote }), "Video"));
    assert.match(text, /Draft video\s+served elsewhere/);
    // No verdict about this machine, and nothing that says the work happens on it.
    assert.doesNotMatch(text, /Draft video\s+served elsewhere\s+Engines\s+Needs/);
    assert.doesNotMatch(text, /on this machine/i);
  });
});

describe("Local AI: the cloned voice is drawn under Voice clone (R-47)", () => {
  // Its capability is `voice-tts` on purpose (SPEC-022) so that no capability probe implies an
  // engine can perform a clone. That is a dispatch fact; under which heading a person looks for
  // it is not, and a Voice clone row with the one cloned-voice model missing from it is the
  // grouping §2.11 rejected — a true statement about our engines, a confusing one about voices.
  const cloned: ManifestModel = {
    id: CLONED_VOICE_MODEL,
    provider: "comfyui",
    capability: "voice-tts",
    displayName: "Local · Cloned Voice",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {},
    pricing: { kind: "unmetered" },
  };
  const withCloned = (): ClientState => {
    const base = stateWith();
    return {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, cloned] } },
    };
  };

  it("puts it under Voice clone and not under Text-to-Speech", () => {
    assert.match(plain(renderRow(withCloned(), "Voice clone")), /Local · Cloned Voice/);
    assert.doesNotMatch(plain(renderRow(withCloned(), "Text-to-Speech")), /Local · Cloned Voice/);
  });

  it("leaves Kokoro where it was", () => {
    assert.match(plain(renderRow(withCloned(), "Text-to-Speech")), /Kokoro 82M/);
    assert.doesNotMatch(plain(renderRow(withCloned(), "Voice clone")), /Kokoro 82M/);
  });
});

describe("Local AI: voice stays three readable lines (R-48, rows 18, 19)", () => {
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
    assert.match(plain(renderRow(half, "Text-to-Speech")), /Local voices\s+failed/);
    assert.match(plain(renderRow(half, "Speech-to-Text")), /Dictation\s+ready/);
    // Neither capability collapses to one failed state, which is SPEC-028 R-2 preserved exactly.
    assert.match(plain(renderRow(half, "Text-to-Speech")), /Conversational voice\s+needs both/);
    assert.match(plain(renderRow(half, "Speech-to-Text")), /Conversational voice\s+needs both/);
  });

  it("both halves ready reads as conversational voice ready", () => {
    const ready = stateWith({ voiceRuntime: voxa("ready", "ready") });
    assert.match(plain(renderRow(ready, "Text-to-Speech")), /Conversational voice\s+ready/);
    assert.match(plain(renderRow(ready, "Speech-to-Text")), /Conversational voice\s+ready/);
  });

  it("states each half only where it runs, never both under one heading", () => {
    // The split is the point: `Voice` used to answer what reads aloud and what transcribes under
    // one noun, which answered neither.
    const ready = stateWith({ voiceRuntime: voxa("ready", "ready") });
    assert.doesNotMatch(plain(renderRow(ready, "Text-to-Speech")), /Dictation/);
    assert.doesNotMatch(plain(renderRow(ready, "Speech-to-Text")), /Local voices/);
  });
});

describe("the row state is a projection, never a new vocabulary (R-26)", () => {
  const FITS: Array<FitVerdict | undefined> = [...FitVerdictSchema.options, undefined];
  const ACTIVATIONS: ActivationState[] = [...ActivationStateSchema.options];

  it("is R-26's table exactly, over every combination of the two vocabularies", () => {
    // The table transcribed from the specification, not from the implementation. Membership in
    // the return type is guaranteed by TypeScript and proves nothing; the mapping is the claim.
    const expected = (fit: FitVerdict | undefined, activation: ActivationState): string => {
      if (fit === "insufficient" || fit === "unsupported") return "unsupported";
      if (activation === "ready") return "installed";
      if (activation === "not-installed") return "available";
      return activation;
    };
    for (const fit of FITS) {
      for (const activation of ACTIVATIONS) {
        assert.equal(localModelRowState("local", fit, activation), expected(fit, activation), `${fit} × ${activation}`);
        // Remote wins over everything: a model served elsewhere has no verdict to show (R-15).
        assert.equal(localModelRowState("remote", fit, activation), "served-elsewhere");
      }
    }
  });

  it("a refusing fit is Unsupported whatever the transfer is doing (row 14, row 16)", () => {
    // The case the old vocabulary could not form: downloading onto hardware that will not run it.
    for (const fit of ["insufficient", "unsupported"] as FitVerdict[]) {
      for (const activation of ACTIVATIONS) {
        assert.equal(localModelRowState("local", fit, activation), "unsupported");
      }
    }
  });

  it("an unmeasured machine is offered, never withheld (R-28)", () => {
    assert.equal(localModelRowState("local", "unknown", "ready"), "installed");
    assert.equal(localModelRowState("local", "unknown", "not-installed"), "available");
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
