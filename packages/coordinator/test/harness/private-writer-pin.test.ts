import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { assembleHarness, managedStudioAssistant } from "../../src/harness/v2-launch.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { tempDir } from "../tmp.js";

it("a healthy bundled protocol stand-in cannot qualify private writing without the pinned executable bytes", { timeout: 40_000 }, async () => {
  const appRoot = await tempDir("arke-private-writer-pin-"), wiring = await assembleHarness({ appRoot,
    v2: { bundledPath: process.execPath, runCommand: async command => command === "where" || command === "which" ? { status: 1, stdout: "" } : { status: 0, stdout: "2.0.26" } },
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, args: [join(import.meta.dirname, "../fixtures/child.mjs")],
      env: { ...spec.env, PASSWORD: "synthetic-private-password" }, healthPath: "/health", validateHealth: async () => true }, deps),
  });
  assert(wiring.supervisor && wiring.createPrivateWriter); assert.equal(wiring.harnessInfo?.source, "bundled");
  const service = new OllamaEngineService({ appRoot, port: 24319, fetch: async () => Response.json({ version: "0.40.11" }) });
  try {
    await wiring.supervisor.start(); assert.equal(wiring.supervisor.status, "healthy");
    assert.equal(await wiring.createPrivateWriter({ model: "ollama/test", system: "Synthetic system", prompt: "PRIVATE_MUST_NOT_SEND", outputTokenLimit: 16 }), null);
    const production = managedStudioAssistant(wiring, service);
    assert.equal(production.destination!("ollama/test", "ollama"), null);
    await service.applySettings({ engineUrl: "http://127.0.0.1:11434", modelsDir: null }); assert.equal(service.status().state, "ready");
    assert.equal(production.destination!("ollama/test", "ollama"), null, "a healthy personal endpoint cannot supply managed locality");
    await assert.rejects(production.privateTransport!({ model: "ollama/test", system: "Synthetic system", prompt: "PRIVATE_MUST_NOT_SEND", outputTokenLimit: 16 }, new AbortController().signal), /destination is unavailable/);
    assert.equal(production.destination!("other/test", "other"), null);
  } finally { await service.dispose(); await wiring.supervisor.stopAndConfirm(); await wiring.adapter?.dispose?.(); }
});
