import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENGINE_PROVIDERS,
  EngineIdSchema,
  engineOfProvider,
  modelEligible,
  PROVIDERS,
  type EngineId,
  type ManifestModel,
  type ProviderId,
} from "../src/index.js";

/**
 * The engine/provider join (SPEC-034 R-7). One rail row per engine, its providers named as groups
 * inside — so the two lists have to agree about which is which, and nothing may fall between them.
 *
 * These are the assertions that turn a manifest change into a red test rather than a rail row
 * nobody drew. A new local provider with no engine renders nowhere; a provider claimed by two
 * engines renders twice.
 */
describe("which engine hosts which provider (SPEC-034 R-7)", () => {
  const engines = EngineIdSchema.options;
  const localProviders = (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => PROVIDERS[id].local);

  it("covers every local provider exactly once", () => {
    // The invariant the Providers rail depends on. A local provider hosted by no engine has no
    // pane to appear in; one hosted by two appears in both, and its models are stated twice.
    for (const provider of localProviders) {
      const hosts = engines.filter((engine) => ENGINE_PROVIDERS[engine].includes(provider));
      assert.deepEqual(hosts.length, 1, `${provider} is hosted by ${hosts.length} engines: ${hosts.join(", ")}`);
    }
  });

  it("claims no provider that is not local", () => {
    // A keyed service belongs in the other band. Claiming one here would put a key row inside an
    // engine pane, which is the conflation SPEC-033 R-72's second clause still forbids.
    for (const engine of engines) {
      for (const provider of ENGINE_PROVIDERS[engine]) {
        assert.equal(PROVIDERS[provider].local, true, `${engine} claims ${provider}, which is not local`);
      }
    }
  });

  it("gives every engine at least one provider", () => {
    // An engine hosting nothing has an empty pane and no models to group. If one ever legitimately
    // has none, this test is the place to say so out loud.
    for (const engine of engines) {
      assert.ok(ENGINE_PROVIDERS[engine].length > 0, `${engine} hosts no providers`);
    }
  });

  it("Voxa is the case the rule exists for — one engine, two providers", () => {
    // One process, one executable, one port, one restart. R-7's `<capability> · <provider>`
    // headings are what keep Kokoro and whisper.cpp separately readable inside it.
    assert.deepEqual([...ENGINE_PROVIDERS.voxa], ["kokoro", "whispercpp"]);
    assert.equal(engineOfProvider("kokoro"), "voxa");
    assert.equal(engineOfProvider("whispercpp"), "voxa");
  });

  it("answers nothing for a cloud provider", () => {
    // The lookup is total over providers, not just local ones: the rail asks it of every row.
    for (const id of (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => !PROVIDERS[p].local)) {
      assert.equal(engineOfProvider(id), undefined, `${id} resolved to an engine`);
    }
  });

  it("agrees with itself in both directions", () => {
    for (const engine of engines) {
      for (const provider of ENGINE_PROVIDERS[engine]) {
        assert.equal(engineOfProvider(provider), engine as EngineId);
      }
    }
  });
});

describe("eligibility refuses what cannot run now (SPEC-034 R-15a)", () => {
  const KOKORO: ManifestModel = {
    id: "kokoro-82m",
    provider: "kokoro",
    capability: "voice-tts",
    displayName: "Kokoro 82M",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {},
    pricing: { kind: "unmetered" },
  };
  const base = { providers: [], disabled: [], recipes: [], comfyUiLocality: undefined } as const;

  it("admits a local model whose engine has not been asked yet (R-28)", () => {
    // `untested` is not a refusal: nothing has asked, and an unmeasured machine is offered
    // rather than withheld.
    assert.equal(modelEligible(KOKORO, base), true);
  });

  it("refuses one whose engine answered and failed", () => {
    // The case R-15a names. A local provider takes no credential, so the check above cannot see
    // this — and `routingFaults` reads settings and the manifest, so it cannot see it either.
    const down = [{ id: "kokoro" as const, configured: false, validation: "invalid" as const, probes: [], fault: null }];
    assert.equal(modelEligible(KOKORO, { ...base, providers: down }), false);
  });

  it("refuses one this machine measurably cannot run", () => {
    for (const fit of ["insufficient", "unsupported"] as const) {
      assert.equal(modelEligible(KOKORO, { ...base, gated: [{ modelId: KOKORO.id, fit }] }), false, fit);
    }
  });

  it("admits one that merely runs slowly, or that nothing has measured", () => {
    // `runs slowly` is a warning, not a bar, and `unknown` is R-28's whole point.
    for (const fit of ["runs-well", "runs-slowly", "unknown"] as const) {
      assert.equal(modelEligible(KOKORO, { ...base, gated: [{ modelId: KOKORO.id, fit }] }), true, fit);
    }
  });

  it("refuses a switched-off model whatever else is true", () => {
    assert.equal(modelEligible(KOKORO, { ...base, disabled: [KOKORO.id] }), false);
  });
});
