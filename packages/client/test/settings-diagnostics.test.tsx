import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  deriveDiagnostics,
  diagnosticsSources,
  type ClientState,
  type DiagnosticsSnapshot,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { controlHref } from "../src/screens/settings-diagnostics.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Diagnostics (SPEC-032 §1.10, design turn 111). The screen renders the contract's
 * snapshot and computes nothing of its own — so the fixtures here are real derivations, never
 * hand-built findings a rule could not produce.
 */

const NOW = "2026-08-28T12:00:00.000Z";

/** Hardware measured and sound, so a fixture can be quiet: the app fixture's runtime is null,
 * which is truthfully a finding (`unmeasured`), not an empty bill of health. */
const SOUND_RUNTIME = {
  probes: { vramMb: 12288, memMb: 32768, diskFreeMb: 100_000 },
  detectedAt: "2026-08-28T11:55:00.000Z",
  models: [],
  recommended: {},
};

function derived(over: Partial<ClientState["app"]> = {}): DiagnosticsSnapshot {
  return deriveDiagnostics({
    sources: diagnosticsSources({ ...FIXTURE_STATE.app, ...over }),
    tails: { appLog: [] },
    previous: null,
    now: NOW,
  });
}

function render(snapshot: DiagnosticsSnapshot | null): string {
  __setStateForTest(FIXTURE_STATE, { diagnostics: snapshot });
  return renderToString(
    <MemoryRouter initialEntries={["/settings/diagnostics"]}>
      <App />
    </MemoryRouter>,
  );
}

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

/** A day with a dead engine: held work, a credential pause, two disabled recipes, no hardware. */
function badDay(): DiagnosticsSnapshot {
  return derived({
    runtime: null,
    comfyui: {
      engine: {
        source: "managed",
        state: "failed",
        locality: "local",
        location: null,
        version: null,
        instanceId: "dead-engine-01",
        detail: "the child exited with code 1",
        detected: [],
      },
      recipes: [
        {
          recipeId: "draft-image",
          recipeVersion: 1,
          displayName: "Local · Draft Image",
          capability: "image",
          state: "disabled",
          reason: "the engine did not start",
          reasonKind: "engine",
        },
        {
          recipeId: "draft-video",
          recipeVersion: 1,
          displayName: "Local · Draft Video",
          capability: "video",
          state: "disabled",
          reason: "the engine did not start",
          reasonKind: "engine",
        },
      ],
      checkedAt: "2026-08-28T11:55:00.000Z",
    },
    jobs: FIXTURE_STATE.app.jobs.map((job) => ({
      ...job,
      status: "queued" as const,
      engine: { source: "managed" as const, instanceId: "dead-engine-01" },
    })),
    queues: [
      { provider: "fal", paused: true, pauseKind: "credential" as const, reason: "no credential stored", held: 4 },
    ],
  });
}

describe("Settings · Diagnostics (R-36, R-37, turn 111)", () => {
  it("mounts at its own route with the rail entry, and states the check count and instant", () => {
    const html = render(derived({ runtime: SOUND_RUNTIME }));
    assert.match(html, /data-screen="settings-diagnostics"/);
    const text = plain(html);
    assert.match(text, /Diagnostics/);
    // The empty state's header carries only the instant (turn 111b); the count sits in the body.
    assert.match(text, /as of /);
    assert.match(text, /\d+ checks/);
    // A populated snapshot carries both in the header.
    assert.match(plain(render(badDay())), /\d+ checks · as of /);
  });

  it("severity bands render in the fixed order, only where occupied", () => {
    const text = plain(render(badDay()));
    const blocking = text.indexOf("BLOCKING");
    const degraded = text.indexOf("DEGRADED");
    const unmeasured = text.indexOf("NOT MEASURED");
    assert.ok(blocking >= 0 && degraded > blocking && unmeasured > degraded, `${blocking} ${degraded} ${unmeasured}`);
    assert.equal(text.includes("ADVISORY"), false, "an empty band is not drawn");
  });

  it("a suppressed consequence renders under its cause, never as a peer row (R-36)", () => {
    const html = render(badDay());
    const text = plain(html);
    // The cause and the count.
    assert.match(text, /ComfyUI engine · failed/);
    assert.match(text, /EXPLAINS 2/);
    assert.match(text, /Local · Draft Image · disabled/);
    // Not a peer: consequence rows carry their own testid, and none renders as a finding row.
    const peers = html.match(/data-testid="diag-finding" data-kind="comfyui-recipe-disabled"/g) ?? [];
    assert.equal(peers.length, 0);
    const nested = html.match(/data-testid="diag-consequence"/g) ?? [];
    assert.equal(nested.length, 2);
  });

  it("a remedy renders as the registry control's label with its place (R-24)", () => {
    const text = plain(render(badDay()));
    assert.match(text, /Settings · Engines · ComfyUI/);
    assert.match(text, /Restart/);
    assert.match(text, /Settings · Providers/);
    assert.match(text, /Key/);
    // The unmeasured finding names the measuring control.
    assert.match(text, /Settings · Local AI/);
    assert.match(text, /Measure/);
  });

  it("the carried cause is the subsystem's own clause, and the notes ride as clauses", () => {
    const text = plain(render(badDay()));
    assert.match(text, /the child exited with code 1/);
    assert.match(text, /no credential stored/);
    assert.match(text, /dispatch remains permitted/i);
  });

  it("nothing to report is a stated result naming what was checked (R-10)", () => {
    const html = render(derived({ runtime: SOUND_RUNTIME }));
    assert.match(html, /data-testid="diag-empty"/);
    const text = plain(html);
    assert.match(text, /Nothing to report/);
    assert.match(text, /engine/);
    assert.match(text, /spend/);
    assert.match(text, /provider faults/);
  });

  it("a primary finding with no control states R-25's sentence; a suppressed consequence states nothing", () => {
    // An unreadable log makes the fault correlation unknown with no remedy — the reachable
    // primary null-remedy case.
    const snapshot = deriveDiagnostics({
      sources: diagnosticsSources({ ...FIXTURE_STATE.app, runtime: SOUND_RUNTIME }),
      tails: { appLog: "unavailable" },
      previous: null,
      now: NOW,
    });
    const text = plain(render(snapshot));
    assert.match(text, /No control resolves this\./);
    const nested = render(badDay()).match(/data-testid="diag-consequence"/g) ?? [];
    assert.ok(nested.length > 0);
    // The consequence sub-rows never carry the absence sentence — one occurrence at most, and
    // it belongs to the unknown finding, not to them.
    assert.equal((plain(render(badDay())).match(/No control resolves this\./g) ?? []).length, 0);
  });

  it("a stale fact renders as an age with the re-measure control — never a list of fact ids (R-16, turn 69)", () => {
    const snapshot = derived({
      runtime: SOUND_RUNTIME,
      comfyui: {
        engine: {
          source: "managed",
          state: "failed",
          locality: "local",
          location: null,
          version: null,
          instanceId: "stale-engine-01",
          detail: "the child exited with code 1",
          detected: [],
        },
        recipes: [],
        // Forty minutes before NOW: past the fifteen-minute bound.
        checkedAt: "2026-08-28T11:20:00.000Z",
      },
    });
    const text = plain(render(snapshot));
    assert.match(text, /measured \d+ (min|h) ago/);
    assert.match(text, /Refresh/);
    assert.doesNotMatch(text, /engine-state/, "internal fact ids stay off the screen");
  });

  it("a remedy's href carries its target under the registry's query key — stale re-measures included", () => {
    assert.equal(
      controlHref({ control: "component-retry", target: "tts-kokoro-82m" }),
      "/settings/engines?component=tts-kokoro-82m",
    );
    assert.equal(
      controlHref({ control: "provider-key", target: "fal" }),
      "/settings/providers?provider=fal",
    );
    assert.equal(controlHref({ control: "comfyui-restart" }), "/settings/engines?engine=comfyui");
  });

  it("every checked rule kind has a product word — a new rule must name itself here too (R-10)", () => {
    const CHECKED = derived({ runtime: SOUND_RUNTIME }).checked;
    const html = render(derived({ runtime: SOUND_RUNTIME }));
    const text = plain(html);
    for (const kind of CHECKED) {
      assert.doesNotMatch(text, new RegExp(kind), `raw kind id ${kind} leaked to the screen`);
    }
  });

  it("the provider-key deep link opens the named provider's pane (R-24's targetParam promise)", () => {
    __setStateForTest(FIXTURE_STATE, { diagnostics: null });
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings/providers?provider=elevenlabs"]}>
        <App />
      </MemoryRouter>,
    );
    const selected = /aria-selected="true"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "";
    assert.match(selected, /ElevenLabs/);
  });

  it("before the first snapshot arrives, the pane states that rather than claiming a result", () => {
    const text = plain(render(null));
    assert.match(text, /not derived yet/);
    assert.equal(text.includes("Nothing to report"), false);
  });
});
