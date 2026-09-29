import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleHarness } from "../../src/harness/v2-launch.js";

const codex = (version: string, helper = true) => ({
  configuredPath: "/bin/codex.exe", exists: async () => true,
  runCommand: async (_command: string, args: string[]) => args[0] === "--version"
    ? { status: 0, stdout: `codex ${version}` }
    : args[0] === "--help" ? { status: helper ? 0 : 1, stdout: "--listen" } : { status: 1, stdout: "" },
});

describe("the private Codex lane", () => {
  it("assembles independently and keeps Arke media keys out of the Codex login lane", async () => {
    const unrelated = async () => { throw new Error("OpenCode discovery must not run"); };
    const wiring = await assembleHarness({ appRoot: process.cwd(), engine: "codex", codex: codex("0.154.0"),
      v1: { runCommand: unrelated }, v2: { runCommand: unrelated },
    });
    assert.equal(wiring.adapter?.id, "codex");
    assert.equal(wiring.supervisor, null);
    assert.equal(wiring.harnessInfo?.version, "0.154.0");
    assert.equal(wiring.harnessInfo?.source, "configured");
    const envUpdates: unknown[] = [];
    Object.defineProperty(wiring.adapter, "updateEnvironment", { value: async (env: unknown) => { envUpdates.push(env); } });
    await wiring.relaunchHarness({ openai: "fake-test-key" });
    await wiring.relaunchHarness({});
    assert.deepEqual(envUpdates, [], "saving media keys neither replaces Codex authentication nor restarts its sessions");
    assert.equal(wiring.adapter?.readiness().ready, false);
    await wiring.adapter?.dispose?.();
  });

  it("refuses old or incomplete installs without silently launching another engine", async () => {
    for (const discovery of [codex("0.144.0"), codex("0.154.0", false)]) {
      const wiring = await assembleHarness({ appRoot: process.cwd(), engine: "codex", codex: discovery });
      assert.equal(wiring.supervisor, null);
      assert.equal(wiring.adapter, null);
      assert.ok(wiring.unavailableReason);
      assert.match(wiring.logLines.join(" "), /Codex unavailable/);
    }
  });
});
