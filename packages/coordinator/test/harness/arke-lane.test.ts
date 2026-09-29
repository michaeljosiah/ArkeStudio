import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleHarness } from "../../src/harness/v2-launch.js";

describe("Arke's own local lane (issue 1247)", () => {
  it("assembles with no discovery, no process and no credentials, and never falls back to OpenCode", async () => {
    const unrelated = async () => { throw new Error("OpenCode discovery must not run"); };
    const wiring = await assembleHarness({ appRoot: process.cwd(), engine: "arke", arke: { maxContextTokens: 16_384 },
      v1: { runCommand: unrelated }, v2: { runCommand: unrelated },
    });
    assert.equal(wiring.adapter?.id, "arke");
    assert.equal(wiring.supervisor, null, "nothing to supervise: the adapter talks to Ollama directly");
    assert.equal(wiring.harness, null);
    assert.deepEqual(wiring.harnessInfo, { generation: "arke", source: "bundled", version: null, beta: false });
    assert.equal(wiring.publishLocalModels, undefined, "the lane reads Ollama itself; there is no profile to write");
    assert.equal(wiring.adapter?.capabilities().has("auth"), false);
    await wiring.relaunchHarness({ openai: "fake-test-key" });
    assert.equal(wiring.adapter?.readiness().ready, false, "ready only once init reaches Ollama");
    await wiring.adapter?.dispose?.();
  });

  it("is chosen by its enabled flag when no engine is named, like the other lanes", async () => {
    const wiring = await assembleHarness({ appRoot: process.cwd(), arke: { enabled: true } });
    assert.equal(wiring.adapter?.id, "arke");
    await wiring.adapter?.dispose?.();
  });
});
