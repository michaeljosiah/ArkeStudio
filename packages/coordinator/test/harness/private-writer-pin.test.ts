import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { assembleHarness } from "../../src/harness/v2-launch.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { tempDir } from "../tmp.js";

it("a healthy bundled protocol stand-in cannot qualify private writing without the pinned executable bytes", { timeout: 40_000 }, async () => {
  const appRoot = await tempDir("arke-private-writer-pin-"), wiring = await assembleHarness({ appRoot,
    v2: { bundledPath: process.execPath, runCommand: async command => command === "where" || command === "which" ? { status: 1, stdout: "" } : { status: 0, stdout: "2.0.26" } },
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, args: [join(import.meta.dirname, "../fixtures/child.mjs")],
      env: { ...spec.env, PASSWORD: "synthetic-private-password" }, healthPath: "/health", validateHealth: async () => true }, deps),
  });
  assert(wiring.supervisor && wiring.createPrivateWriter); assert.equal(wiring.harnessInfo?.source, "bundled");
  try {
    await wiring.supervisor.start(); assert.equal(wiring.supervisor.status, "healthy");
    assert.equal(await wiring.createPrivateWriter({ model: "ollama/test", system: "Synthetic system", prompt: "PRIVATE_MUST_NOT_SEND", outputTokenLimit: 16 }), null);
  } finally { await wiring.supervisor.stopAndConfirm(); await wiring.adapter?.dispose?.(); }
});
