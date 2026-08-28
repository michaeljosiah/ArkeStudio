import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENGINE_PROVIDERS,
  EngineIdSchema,
  engineOfProvider,
  PROVIDERS,
  type EngineId,
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
