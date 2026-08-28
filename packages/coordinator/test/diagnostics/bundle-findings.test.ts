import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveDiagnostics,
  type ClientState,
  type DiagnosticsSources,
} from "@arke-studio/contracts";
import { IDLE_UPDATE_STATE } from "@arke-studio/contracts";
import { buildDiagnosticsBundle } from "../../src/diagnostics.js";
import { SecretRegistry, diagnosticsBoundary } from "../../src/redact.js";

/**
 * SPEC-032 R-38, R-39 (#558): the findings ride the existing SPEC-008 R-6 bundle — one export,
 * extended, never a second one beside it — and stay readable without the application: a remedy
 * carries where its control lives in words, resolved at export time through the same registry
 * the view reads. Matrix rows 43, 52.
 */

const NOW = "2026-08-28T12:00:00.000Z";

function sources(over: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return {
    version: "0.4.1",
    health: {
      coordinator: { status: "healthy" },
      harness: { status: "healthy" },
      voice: { status: "healthy" },
    },
    env: null,
    runtime: null,
    harness: null,
    harnessInfo: null,
    setup: null,
    comfyui: null,
    voiceRuntime: null,
    queues: [],
    jobs: [],
    providers: [],
    providerTools: [],
    manifest: null,
    routing: { defaults: {}, faults: [] },
    models: { disabled: [] },
    spend: null,
    ledger: [],
    drift: [],
    builds: [],
    update: IDLE_UPDATE_STATE,
    ...over,
  };
}

/** An engine down with a disabled recipe and a paused lane: causes, a consequence, remedies. */
function derivedSnapshot() {
  return deriveDiagnostics({
    sources: sources({
      comfyui: {
        engine: {
          source: "managed",
          state: "failed",
          locality: "local",
          location: null,
          version: null,
          instanceId: "bundle-engine-01",
          detail: "the child exited with code 1",
          detected: [],
        },
        recipes: [
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
      ledger: [
        // A previous period and a sharp rise: the advisory with no control (R-25 in the export).
        {
          ts: "2026-08-18T12:00:00.000Z",
          worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
          jobId: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC",
          provider: "fal",
          model: "veo-3",
          outcome: "succeeded",
          estimatedMicroUsd: 500_000,
          actualMicroUsd: 500_000,
        },
        {
          ts: "2026-08-27T12:00:00.000Z",
          worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
          jobId: "jb_01J8F3K2QW9VZX4N7M0RTYB6HD",
          provider: "fal",
          model: "veo-3",
          outcome: "succeeded",
          estimatedMicroUsd: 2_500_000,
          actualMicroUsd: 2_500_000,
        },
      ],
    }),
    tails: { appLog: [] },
    previous: null,
    now: NOW,
    boundary: diagnosticsBoundary(new SecretRegistry()),
  });
}

function stateFor(bundleSources: DiagnosticsSources): ClientState {
  return {
    app: { ...bundleSources, jobs: [], ledger: [] },
    worlds: [],
    world: null,
  } as unknown as ClientState;
}

describe("the findings ride the one bundle (R-38, row 52)", () => {
  it("one bundle carries the findings beside the SPEC-008 fields; no second artifact exists", async () => {
    const snapshot = derivedSnapshot();
    const bundle = await buildDiagnosticsBundle(stateFor(sources()), null, new SecretRegistry(), snapshot);
    // The R-6 fields are untouched.
    const app = bundle["app"] as Record<string, unknown>;
    assert.equal(app["version"], "0.4.1");
    assert.ok("providers" in app && "routing" in app && "spend" in app);
    assert.ok("recentLog" in bundle);
    // And the findings sit beside them, whole.
    const findings = bundle["findings"] as { findings: Array<Record<string, unknown>>; checked: string[] };
    assert.ok(findings);
    assert.equal(findings.findings.length, snapshot.findings.length);
    assert.ok(findings.checked.length >= 10);
  });

  it("a build with no derivation exports findings: null, never a fabricated empty result", async () => {
    const bundle = await buildDiagnosticsBundle(stateFor(sources()), null, new SecretRegistry(), null);
    assert.equal(bundle["findings"], null);
  });
});

describe("readable without the application (R-39, row 43)", () => {
  it("a remedy carries its control's label and place in words, beside the identifier", async () => {
    const bundle = await buildDiagnosticsBundle(stateFor(sources()), null, new SecretRegistry(), derivedSnapshot());
    const { findings } = bundle["findings"] as { findings: Array<Record<string, unknown>> };
    const engine = findings.find((f) => f["kind"] === "comfyui-engine-unavailable")!;
    assert.deepEqual(engine["remedy"], {
      control: "comfyui-restart",
      label: "Restart",
      place: "Settings · Engines · ComfyUI",
    });
  });

  it("a primary finding with no control states the absence; a suppressed consequence states nothing (R-25)", async () => {
    const bundle = await buildDiagnosticsBundle(stateFor(sources()), null, new SecretRegistry(), derivedSnapshot());
    const { findings } = bundle["findings"] as { findings: Array<Record<string, unknown>> };
    const spend = findings.find((f) => f["kind"] === "spend-above-previous")!;
    assert.deepEqual(spend["remedy"], { absent: "No control resolves this." });
    const consequence = findings.find((f) => f["kind"] === "comfyui-recipe-disabled")!;
    assert.equal(consequence["remedy"], null);
    // The edge that explains it is in the export, so a reader can follow cause to consequence.
    const engine = findings.find((f) => f["kind"] === "comfyui-engine-unavailable")!;
    assert.deepEqual(engine["consequences"], ["comfyui-recipe-disabled:draft-video"]);
  });

  it("row 23 in the export: the ledger's world identifier does not ride the spend finding into the bundle", async () => {
    const bundle = await buildDiagnosticsBundle(stateFor(sources()), null, new SecretRegistry(), derivedSnapshot());
    const text = JSON.stringify(bundle["findings"]);
    assert.ok(!text.includes("01J8F3K2QW9VZX4N7M0RTYB6HC"));
    assert.ok(text.includes("veo-3"), "the model is the finding's business");
  });
});
