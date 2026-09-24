import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ENGINE_LABEL, type ClientState, type SetupComponent } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __handleFrameForTest, __setStateForTest, __stateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Engines (SPEC-033 §1.11). The machinery, unabridged, for the sessions where that
 * is the question.
 *
 * The rule this screen exists to prove is a deletion: `statedElsewhere` suppressed a component
 * from one group because four other groups might already state it, conditionally, with a rule
 * per destination. R-6 requires it deleted rather than rewritten. What proves it here is the
 * rendered rail — every engine states its own components and nothing states another's — not a
 * grep of the source for the function's name. The old addresses (`local-runtime`, `local-ai`,
 * `engines`) are covered by retired-routes.test.tsx, which mounts them and reads where they land.
 */

function component(patch: Partial<SetupComponent> & Pick<SetupComponent, "id">): SetupComponent {
  return {
    displayName: patch.id,
    purpose: "test",
    sizeMb: 100,
    installLocation: "C:\\ArkeStudio",
    state: "present",
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: null,
    pauseSupported: false,
    ...patch,
  };
}

const COMPONENTS: SetupComponent[] = [
  component({ id: "comfyui-runtime", engine: "comfyui", displayName: "ComfyUI runtime", state: "available" }),
  component({ id: "ollama-runtime", engine: "ollama", displayName: "Ollama runtime" }),
  component({ id: "ollama-gemma4-12b", engine: "ollama", displayName: "Gemma 4 · 12B", state: "available" }),
  component({ id: "tts-kokoro-82m", engine: "voxa", displayName: "Kokoro 82M · voice" }),
  component({ id: "stt-whisper-base-en", engine: "voxa", displayName: "Whisper base.en · dictation" }),
  // Declared exactly as the catalogue declares it: Providers owns the credential the tool is
  // for, so Providers owns the tool, and Engines reads that rather than a list of what to hide.
  component({ id: "higgsfield-cli", provider: "higgsfield", displayName: "Higgsfield CLI", state: "available" }),
];

function stateWith(over: Partial<ClientState["app"]> = {}): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      setup: { running: false, diskFreeMb: 400_000,
      diskCheckedAt: null, components: COMPONENTS },
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
        recipes: [],
        checkedAt: "2026-08-27T12:00:00.000Z",
      },
      ...over,
    },
  };
}

function render(path: string, state: ClientState = stateWith()): string {
  __setStateForTest(state, { setupStatus: state.app.setup });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

describe("Engines: one row per engine, and the components under it (R-68, R-71)", () => {
  it("folds a ComfyUI status that arrives after the startup snapshot", () => {
    __setStateForTest(FIXTURE_STATE);
    const comfyui = stateWith().app.comfyui!;
    __handleFrameForTest({
      kind: "event",
      seq: 1,
      event: { at: "2026-08-27T12:00:00.000Z", type: "comfyui.status", comfyui },
    });
    assert.deepEqual(__stateForTest().state?.app.comfyui, comfyui);
  });

  it("makes no installation or recipe claims before the first ComfyUI status", () => {
    const html = plain(render("/settings/providers?provider=comfyui", stateWith({ comfyui: null })));
    assert.match(html, /ENGINE\s+Not yet known/);
    assert.match(html, /RECIPES\s+NOT YET KNOWN/);
    assert.doesNotMatch(html, /Not installed|NONE IN THIS BUILD/);
  });

  it("mounts at its own route and rails the three engines", () => {
    const html = render("/settings/providers");
    assert.match(html, /data-screen="settings-providers"/);
    const text = plain(html);
    for (const label of Object.values(ENGINE_LABEL)) assert.match(text, new RegExp(label), label);
  });

  it("a ?component= deep link opens the pane of the engine that owns it (SPEC-032 R-24)", () => {
    // A voice model's Retry must land on Voxa's pane, not the default ComfyUI one.
    const voxa = plain(render("/settings/providers?component=tts-kokoro-82m"));
    assert.match(voxa, /Kokoro 82M · voice/);
    assert.doesNotMatch(voxa, /RECIPES/);
    // Recipe weights carry no engine field; they resolve through their catalogue-derived id —
    // and a component that provides a model IS that model, whose controls are on AI models now
    // (SPEC-042 R-21). Providers forwards rather than opening a pane without the control. The
    // forward is a <Navigate>, which needs a second pass renderToString does not make, so what
    // this pass proves is that no provider pane was drawn in its place.
    const weights = render("/settings/providers?component=comfyui-weights-draft-video");
    assert.doesNotMatch(weights, /data-testid="provider-pane"/);
    // An explicit engine choice still outranks the component's owner.
    const explicit = plain(render("/settings/providers?provider=ollama&component=tts-kokoro-82m"));
    assert.match(explicit, /Gemma 4 · 12B/);
    // And a provider-owned component resolves to its provider, which is now a row in the same
    // rail rather than a screen away: Higgsfield's CLI is the credential's, not an engine's.
    const tool = plain(
      render(
        "/settings/providers?component=higgsfield-cli",
        stateWith({
          setup: {
            running: false,
            diskFreeMb: 0,
            diskCheckedAt: null,
            components: [component({ id: "higgsfield-cli", provider: "higgsfield", displayName: "Higgsfield CLI" })],
          },
        }),
      ),
    );
    assert.match(tool, /Higgsfield\s+SIGN-IN|Higgsfield[\s\S]{0,200}sign/i);
  });

  it("states each engine's components under that engine and nowhere else", () => {
    const ollama = plain(render("/settings/providers?provider=ollama"));
    assert.match(ollama, /Gemma 4 · 12B/);
    assert.doesNotMatch(ollama, /Kokoro 82M · voice/);

    const voxa = plain(render("/settings/providers?provider=voxa"));
    assert.match(voxa, /Kokoro 82M · voice/);
    assert.match(voxa, /Whisper base\.en · dictation/);
    assert.doesNotMatch(voxa, /Gemma 4 · 12B/);
  });

  it("does not restate a ComfyUI component the pane already acts on", () => {
    // The engine is in the ENGINE line with its own Download, and each recipe's weights are on
    // the recipe row where SPEC-028 T-25 put them. A COMPONENTS band beneath would put two
    // Downloads for one fetch on one screen — the duplication R-6 exists to end, rebuilt inside
    // the work that deletes it.
    const comfy = plain(render("/settings/providers?provider=comfyui"));
    assert.doesNotMatch(comfy, /COMPONENTS/);
    // Nor a recipe list at all: a recipe is ComfyUI's model, and AI models draws it under the
    // kind it makes (SPEC-042 R-3). The pane says how many, and where.
    assert.doesNotMatch(comfy, /Draft video/);
    assert.match(comfy, /RECIPES/);
  });

  it("controls the Arke-managed engine transfer from the engine row", () => {
    const renderManaged = (runtime: SetupComponent): string => {
      const base = stateWith();
      return render(
        "/settings/providers?provider=comfyui",
        stateWith({
          comfyui: {
            ...base.app.comfyui!,
            engine: { ...base.app.comfyui!.engine, source: "absent", state: "absent" },
          },
          setup: { running: runtime.state === "downloading", diskFreeMb: 400_000, diskCheckedAt: null, components: [runtime] },
        }),
      );
    };
    const active = component({
      id: "comfyui-runtime",
      engine: "comfyui",
      state: "downloading",
      pauseSupported: true,
    });
    assert.match(renderManaged(active), /data-testid="comfyui-managed-option"[\s\S]*>Pause<\/button>/);
    assert.match(renderManaged({ ...active, pauseSupported: false }), /Cannot be paused/);
    assert.match(
      renderManaged({ ...active, state: "paused", bytesDone: 50, bytesTotal: 100 }),
      /data-testid="comfyui-managed-option"[\s\S]*>Resume<\/button>/,
    );
  });

  it("keeps paused progress and Resume on ordinary engine component rows", () => {
    const paused = component({
      id: "ollama-runtime",
      engine: "ollama",
      displayName: "Ollama runtime",
      state: "paused",
      bytesDone: 25,
      bytesTotal: 100,
      pauseSupported: true,
    });
    const html = render(
      "/settings/providers?provider=ollama",
      stateWith({ setup: { running: false, diskFreeMb: 400_000, diskCheckedAt: null, components: [paused] } }),
    );
    assert.match(plain(html), /Ollama runtime[\s\S]*paused · 25%[\s\S]*Resume/);
    assert.match(html, /width:25%/);
  });

  it("offers a connection check, not a restart, for an external URL", () => {
    const comfyui = stateWith().app.comfyui!;
    const html = plain(
      render(
        "/settings/providers?provider=comfyui",
        stateWith({
          comfyui: {
            ...comfyui,
            engine: {
              ...comfyui.engine,
              source: "user-url",
              location: "http://127.0.0.1:8188",
            },
          },
        }),
      ),
    );
    assert.match(html, /Check now/);
    assert.doesNotMatch(html, /Restart/);
  });

  it("leaves a provider's tool to Providers, which owns the credential it is for (R-1)", () => {
    // Not a suppression list: the component names the provider that owns it, and Engines reads
    // that declaration the same way it reads `engine`.
    for (const engine of ["comfyui", "ollama", "voxa", "other"]) {
      assert.doesNotMatch(plain(render(`/settings/providers?provider=${engine}`)), /Higgsfield CLI/, engine);
    }
    assert.match(plain(render("/settings/providers")), /Higgsfield/);
  });

  it("keeps a place for a component nobody requires, and draws it only when one exists (R-71, SPEC-034 R-8)", () => {
    // Every entry in today's catalogue declares an engine or a provider, so the fixture has none
    // and the rail must not offer the row: an always-drawn `Other components` is a heading over
    // nothing, which is what SPEC-034 R-8 narrows R-71's *keeps a place* to.
    assert.doesNotMatch(plain(render("/settings/providers")), /Other components/);
    // Give it one and the place appears, after the engines rather than before them.
    const withOrphan = plain(
      render(
        "/settings/providers?provider=other",
        stateWith({
          setup: { running: false, diskFreeMb: 0, diskCheckedAt: null, components: [component({ id: "orphan" })] },
        }),
      ),
    );
    assert.match(withOrphan, /Other components/);
    assert.ok(withOrphan.indexOf("ComfyUI") < withOrphan.indexOf("Other components"));
  });

  it("names Voxa as an engine, in the words every surface shares (R-72, R-62)", () => {
    // It hosts Kokoro and whisper.cpp — one engine, two providers — and before this it was only
    // ever visible as the contents of a group called Voice. `VOICE` was that group's word and no
    // other screen's, so the head derives from the providers it hosts instead.
    assert.match(plain(render("/settings/providers?provider=voxa")), /Voxa\s+Speech-to-Text, Text-to-Speech/);
  });

  it("does not state the authoring harness (R-5, R-72, matrix row 46)", () => {
    // It was stated twice: a top-level tab and a group inside Local runtime. The group is what
    // goes; OpenCode governs agent execution, which is not generation infrastructure.
    for (const engine of ["comfyui", "ollama", "voxa", "other"]) {
      assert.doesNotMatch(plain(render(`/settings/providers?provider=${engine}`)), /OpenCode/i, engine);
    }
  });

  it("states a non-loopback engine as remote (R-69, SPEC-028 R-37)", () => {
    const remote = stateWith({
      comfyui: {
        engine: {
          source: "user-url",
          state: "ready",
          locality: "remote",
          location: "gpu-box.example:8188",
          version: "0.3.45",
          instanceId: "remote-1",
          detail: null,
          detected: [],
        },
        recipes: [],
        checkedAt: "2026-08-27T12:00:00.000Z",
      },
    });
    // Named in exactly two places and no more (SPEC-034 R-9): the rail says *that* it is,
    // in place of the count it has no answer for, and the pane says where.
    assert.match(plain(render("/settings/providers", remote)), /ComfyUI\s+elsewhere/);
    assert.match(plain(render("/settings/providers?provider=comfyui", remote)), /another machine/);
  });
});
