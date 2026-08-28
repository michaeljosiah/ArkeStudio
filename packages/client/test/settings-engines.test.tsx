import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ENGINE_LABEL, type ClientState, type SetupComponent } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Engines (SPEC-033 §1.11). The machinery, unabridged, for the sessions where that
 * is the question.
 *
 * The rule this screen exists to prove is a deletion: `statedElsewhere` suppressed a component
 * from one group because four other groups might already state it, conditionally, with a rule
 * per destination. R-6 requires it deleted rather than rewritten, and makes its survival a
 * finding about the split rather than a piece of tidying — so the first case here is that the
 * function is gone from the source, not merely unused.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function component(patch: Partial<SetupComponent> & Pick<SetupComponent, "id">): SetupComponent {
  return {
    displayName: patch.id,
    purpose: "test",
    sizeMb: 100,
    state: "present",
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: null,
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

describe("the suppression is deleted, not relocated (R-6, D22, matrix row 39)", () => {
  it("no source file declares statedElsewhere or its table", async () => {
    // Rewriting it to suit the new rail would preserve the fault in a new shape. Deleting it is
    // what makes the split testable — and this is that test.
    for (const file of ["screens/shell.tsx", "screens/settings-engines.tsx", "screens/settings-local-ai.tsx"]) {
      const source = await readFile(join(HERE, "..", "src", file), "utf8");
      // The declarations, not the word: this file's own prose says why it went, and a comment
      // recording a deletion is the opposite of the thing being asserted against.
      assert.doesNotMatch(source, /function statedElsewhere/, file);
      assert.doesNotMatch(source, /const STATED_ELSEWHERE/, file);
    }
  });
});

describe("Engines: one row per engine, and the components under it (R-68, R-71)", () => {
  it("mounts at its own route and rails the three engines", () => {
    const html = render("/settings/engines");
    assert.match(html, /data-screen="settings-engines"/);
    const text = plain(html);
    for (const label of Object.values(ENGINE_LABEL)) assert.match(text, new RegExp(label), label);
  });

  it("states each engine's components under that engine and nowhere else", () => {
    const ollama = plain(render("/settings/engines?engine=ollama"));
    assert.match(ollama, /Gemma 4 · 12B/);
    assert.doesNotMatch(ollama, /Kokoro 82M · voice/);

    const voxa = plain(render("/settings/engines?engine=voxa"));
    assert.match(voxa, /Kokoro 82M · voice/);
    assert.match(voxa, /Whisper base\.en · dictation/);
    assert.doesNotMatch(voxa, /Gemma 4 · 12B/);
  });

  it("does not restate a ComfyUI component the pane already acts on", () => {
    // The engine is in the ENGINE line with its own Download, and each recipe's weights are on
    // the recipe row where SPEC-028 T-25 put them. A COMPONENTS band beneath would put two
    // Downloads for one fetch on one screen — the duplication R-6 exists to end, rebuilt inside
    // the work that deletes it.
    const comfy = plain(render("/settings/engines?engine=comfyui"));
    assert.doesNotMatch(comfy, /COMPONENTS/);
  });

  it("leaves a provider's tool to Providers, which owns the credential it is for (R-1)", () => {
    // Not a suppression list: the component names the provider that owns it, and Engines reads
    // that declaration the same way it reads `engine`.
    for (const engine of ["comfyui", "ollama", "voxa", "other"]) {
      assert.doesNotMatch(plain(render(`/settings/engines?engine=${engine}`)), /Higgsfield CLI/, engine);
    }
    assert.match(plain(render("/settings/providers")), /Higgsfield/);
  });

  it("keeps a place for a component nobody requires, without organising by it (R-71)", () => {
    const other = plain(render("/settings/engines?engine=other"));
    assert.match(other, /Other components\s+NO ENGINE\s+none/, "the place exists even when empty");
    // And it is not the first thing the rail offers — the engines are.
    const rail = plain(render("/settings/engines"));
    assert.ok(rail.indexOf("ComfyUI") < rail.indexOf("Other components"));
  });

  it("names Voxa as an engine (R-72, decision 8)", () => {
    // It hosts Kokoro and whisper.cpp — one engine, two providers — and before this it was only
    // ever visible as the contents of a group called Voice.
    assert.match(plain(render("/settings/engines?engine=voxa")), /Voxa\s+VOICE/);
  });

  it("does not state the authoring harness (R-5, R-72, matrix row 46)", () => {
    // It was stated twice: a top-level tab and a group inside Local runtime. The group is what
    // goes; OpenCode governs agent execution, which is not generation infrastructure.
    for (const engine of ["comfyui", "ollama", "voxa", "other"]) {
      assert.doesNotMatch(plain(render(`/settings/engines?engine=${engine}`)), /OpenCode/i, engine);
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
    assert.match(plain(render("/settings/engines", remote)), /ComfyUI\s+remote/);
  });
});

describe("Local runtime is gone, and its address is not (R-73)", () => {
  it("no screen renders the old id, anywhere in the client", async () => {
    for (const file of ["App.tsx", "screens/shell.tsx", "screens/settings-engines.tsx", "screens/settings-local-ai.tsx"]) {
      const source = await readFile(join(HERE, "..", "src", file), "utf8");
      assert.doesNotMatch(source, /settings-local-runtime/, file);
    }
  });

  it("keeps the old route mounted as a redirect rather than a hole", async () => {
    // A link, a bookmark or a remedy written against the old address lands on the half that
    // answers the same question — which is the dangling remedy SPEC-032 §2.4 exists to prevent.
    // Asserted on the route rather than the render: `<Navigate>` needs a second pass, and
    // `renderToString` only makes one.
    const app = await readFile(join(HERE, "..", "src", "App.tsx"), "utf8");
    assert.match(app, /path="local-runtime" element=\{<Navigate to="\/settings\/local-ai" replace \/>\}/);
  });
});
