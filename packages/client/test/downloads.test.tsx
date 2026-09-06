import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  comfyUiWeightsComponentId,
  type ClientMessage,
  type ClientState,
  type ManifestModel,
  type SetupComponent,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest, setupPause, setupResume } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Downloads (SPEC-033 §1.13), and the controls that stay on the row that started the work.
 *
 * **Downloads owns progress** (R-82). The capability row renders the same projection rather than
 * computing its own — two independently derived figures for one transfer is exactly the
 * duplication `statedElsewhere` existed to paper over, and R-6 removed the mechanism that used
 * to hide it, so nothing is left to resolve a disagreement.
 */

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

const MB = 1024 * 1024;

function component(patch: Partial<SetupComponent> & Pick<SetupComponent, "id">): SetupComponent {
  return {
    displayName: patch.id,
    purpose: "test",
    sizeMb: 100,
    installLocation: "C:\\ArkeStudio",
    state: "available",
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: null,
    pauseSupported: false,
    ...patch,
  };
}

const RUNTIME = component({
  id: "ollama-runtime",
  engine: "ollama",
  displayName: "Ollama",
  purpose: "Runs language models here",
  sizeMb: 750,
  installLocation: "C:\\Users\\Arke\\AppData\\Local\\Programs\\Ollama",
});

const MODEL = component({
  id: "ollama-gemma4-12b",
  engine: "ollama",
  displayName: "Gemma 4 · 12B",
  purpose: "Reads images and holds a 256K context",
  sizeMb: 7600,
  installLocation: "D:\\Ollama\\models",
  requires: ["ollama-runtime"],
  provides: [GEMMA.id],
  // Declared by the service for an optional component Arke can take back — an Ollama pull is
  // removed by asking Ollama, and the model is what the disk is actually spent on.
  removable: true,
});

function stateWith(components: SetupComponent[]): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [GEMMA] },
      runtime: {
        probes: { vramMb: 24 * 1024, memMb: 64 * 1024, diskFreeMb: 400 * 1024, accelerators: ["cuda"], platform: "win32" },
        detectedAt: "2026-08-27T12:00:00.000Z",
        models: [
          {
            modelId: GEMMA.id,
            provider: "ollama",
            displayName: GEMMA.displayName,
            capability: "llm",
            locality: "local",
            fit: "runs-well",
          },
        ],
        recommended: {},
      },
      setup: { running: components.some((c) => c.state === "downloading"), diskFreeMb: 400_000,
      diskCheckedAt: null, components },
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

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

/**
 * The Ollama pane holding the language models. Providers' rail draws one source at a time, so a
 * test about a model row has to name the row rather than land on whichever opens first.
 */
// The model's row is on AI models now, under the kind it makes (SPEC-042 R-12).
const LANGUAGE_ROW = "/settings/models?half=local&kind=llm";

describe("the row states the whole chain's size, and only the count of the rest (R-40, R-41)", () => {
  it("quotes the closure, not the model's own weights", () => {
    // 7.6 GB of model plus a 750 MB runtime is an 8.2 GB press. Quoting the model alone while
    // fetching an engine beside it is what makes honest arithmetic dishonest.
    const text = plain(render(LANGUAGE_ROW, stateWith([RUNTIME, MODEL])));
    assert.match(text, /Install · 8\.2 GB/);
    assert.match(text, /1 supporting component\b/);
    // Named nowhere on the line: `Install ComfyUI 0.3.48 and its nodes` is the machine's
    // sentence, not the product's.
    assert.doesNotMatch(text, /Install · 8\.2 GB[\s\S]{0,80}Ollama/);
  });

  it("drops the supporting count once the chain's other half is here", () => {
    const text = plain(render(LANGUAGE_ROW, stateWith([{ ...RUNTIME, state: "present" }, MODEL])));
    assert.match(text, /Install · 7\.4 GB/);
    assert.doesNotMatch(text, /supporting component/);
  });

  it("offers Remove wherever a size on disk is stated, and only where it can act (R-43)", () => {
    const text = plain(render(LANGUAGE_ROW, stateWith([RUNTIME, { ...MODEL, state: "ready" }])));
    assert.match(text, /Gemma 4 12B[\s\S]{0,200}Remove/);
    assert.doesNotMatch(text, /Install ·/);

    // A component Arke did not put there offers nothing: setup fetches a non-optional one again
    // on the next launch, and a weight file in a mapped folder may have been the user's first.
    const notOurs = plain(
      render(LANGUAGE_ROW, stateWith([RUNTIME, { ...MODEL, state: "ready", removable: undefined }])),
    );
    assert.doesNotMatch(notOurs, /Remove/);
  });
});

describe("Downloads shows everything in flight, whichever screen started it (R-81, R-84)", () => {
  const moving: SetupComponent[] = [
    { ...RUNTIME, state: "ready" },
    { ...MODEL, state: "downloading", bytesDone: 1900 * MB, bytesTotal: 7600 * MB, bytesPerSecond: 8 * MB },
    component({
      id: comfyUiWeightsComponentId("comfyui-draft-video"),
      engine: "comfyui",
      displayName: "Draft video · weights",
      sizeMb: 13_700,
      installLocation: "E:\\ComfyUI\\models",
      state: "queued",
    }),
  ];

  it("lists a transfer from every source at once", () => {
    const text = plain(render("/settings/downloads", stateWith(moving)));
    assert.match(text, /Gemma 4 · 12B/);
    assert.match(text, /Draft video · weights/);
    assert.match(text, /25% · 8 MB\/s/);
    assert.match(text, /D:\\Ollama\\models/);
    assert.match(text, /E:\\ComfyUI\\models/);
    assert.match(text, /C:\\Users\\Arke\\AppData\\Local\\Programs\\Ollama/);
  });

  it("states the same percentage the capability row does (R-82)", () => {
    // One projection, one owner. The row renders a bar from the same figures rather than a
    // second derivation that can drift from this one.
    const downloads = render("/settings/downloads", stateWith(moving));
    const local = render(LANGUAGE_ROW, stateWith(moving));
    assert.match(plain(downloads), /25%/);
    assert.match(local, /width:25%/);
  });

  it("offers Pause only when the active source supports it", () => {
    const supported = plain(
      render(
        "/settings/downloads",
        stateWith([{ ...MODEL, state: "downloading", pauseSupported: true }]),
      ),
    );
    assert.match(supported, /Pause/);
    assert.doesNotMatch(supported, /Cannot be paused/);

    const unsupported = plain(
      render(
        "/settings/downloads",
        stateWith([{ ...MODEL, state: "downloading", pauseSupported: false }]),
      ),
    );
    assert.match(unsupported, /Cannot be paused/);
    assert.doesNotMatch(unsupported, /\bPause\b/);
  });

  it("keeps a paused transfer, its progress, Resume and Stop all visible", () => {
    const paused = {
      ...MODEL,
      state: "paused" as const,
      bytesDone: 1900 * MB,
      bytesTotal: 7600 * MB,
      pauseSupported: true,
    };
    const html = render("/settings/downloads", stateWith([paused]));
    const text = plain(html);
    assert.match(text, /IN FLIGHT/);
    assert.match(text, /paused · 25%/);
    assert.match(text, /Resume/);
    assert.match(text, /Stop all/);
    assert.match(html, /width:25%/);
  });

  it("sends pause and resume for the component being controlled", () => {
    const sent: ClientMessage[] = [];
    const bridge: ArkeBridge = {
      appVersion: "test",
      platform: "test",
      connect: () => {},
      subscribe: () => {},
      send: (json) => sent.push(JSON.parse(json) as ClientMessage),
    };
    __setStateForTest(stateWith([]));
    __setBridgeForTest(bridge);
    try {
      setupPause(MODEL.id);
      setupResume(MODEL.id);
      assert.deepEqual(sent, [
        { kind: "setup-pause", componentId: MODEL.id },
        { kind: "setup-resume", componentId: MODEL.id },
      ]);
    } finally {
      __setBridgeForTest(null);
    }
  });

  it("names what an install left behind, with its path and its size (R-45)", () => {
    const held = [
      { ...RUNTIME, state: "ready" as const },
      {
        ...MODEL,
        state: "failed" as const,
        detail: "1 file could not be removed — reclaim from Downloads",
        leftovers: [{ path: "D:\\models\\gemma\\model.bin.partial", sizeMb: 4200 }],
      },
    ];
    const text = plain(render("/settings/downloads", stateWith(held)));
    assert.match(text, /D:\\models\\gemma\\model\.bin\.partial · 4\.1 GB/);
    // Reported, not claimed away: `nothing remains` is a promise no implementation can keep on
    // a platform where a scanner holds a file open, and every implementation would make it.
    assert.doesNotMatch(text, /nothing remains/i);
  });

  it("is reachable from both screens and owned by neither (R-84)", () => {
    const state = stateWith([RUNTIME, MODEL]);
    // Reached from Providers, and from every engine pane in it — unconditionally, because a
    // link that appears only mid-transfer is no route for the reader who came to reclaim what a
    // failed one left behind (SPEC-034 R-25).
    for (const engine of ["comfyui", "ollama", "voxa"]) {
      assert.match(plain(render(`/settings/providers?provider=${engine}`, state)), /Downloads/);
    }
    // One way back, because there is now one place to go: Providers absorbed both screens that
    // used to reach this one (SPEC-034 R-25).
    assert.match(plain(render("/settings/downloads", state)), /Providers/);
  });
});
