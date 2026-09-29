import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfinementCache } from "@arke-studio/adapter-claude";
import { assembleHarness } from "../../src/harness/v2-launch.js";

/**
 * The bring-your-own lane inside `assembleHarness` — the one place both hosts get it from.
 * The confinement probe is injected here; the real one spends a live turn, which is exactly
 * why it is opt-in rather than something every boot pays for.
 */

const verified = async () => ({ gateInvokedFor: ["Bash"], deniedActionHappened: false, version: "2.1.235", apiKeySource: "none" });
const broken = async () => ({ gateInvokedFor: ["Bash"], deniedActionHappened: true, version: "2.1.235", apiKeySource: "none" });

/** Answers `where`/`which` and `--version` so discovery resolves without a real binary. */
const runCommand = (version: string | null) => async (command: string, args: string[]) => {
  if (command === "where" || command === "which") return { status: 0, stdout: "/usr/local/bin/claude\n" };
  if (args[0] === "--version" && version) return { status: 0, stdout: `${version} (Claude Code)\n` };
  return { status: 1, stdout: "" };
};

// A fresh cache per assembly: verdicts are meant to outlive one assembly within a run, which
// is exactly what would let one case here answer the next one's question.
const assemble = (claude: Record<string, unknown>) =>
  assembleHarness({
    appRoot: process.cwd(),
    claude: { cache: new ConfinementCache(), ...claude },
    v1: { runCommand: async () => ({ status: 1, stdout: "" }) } as never,
    v2: { runCommand: async () => ({ status: 1, stdout: "" }) },
  });

describe("the bring-your-own Claude lane (SPEC-005 R-1, R-4)", () => {
  it("never discovers OpenCode when Claude is selected, and an explicit engine overrides a legacy flag", async () => {
    const unrelated = async () => { throw new Error("OpenCode discovery must not run"); };
    const selected = await assembleHarness({ appRoot: process.cwd(), engine: "claude",
      claude: { cache: new ConfinementCache(), runCommand: runCommand("2.1.235"), runTurn: verified },
      v1: { runCommand: unrelated }, v2: { runCommand: unrelated },
    });
    assert.equal(selected.adapter?.id, "claude");
    assert.equal(selected.supervisor, null);
    const absent = async () => ({ status: 1, stdout: "" });
    const overridden = await assembleHarness({ appRoot: process.cwd(), engine: "opencode",
      claude: { enabled: true, runCommand: unrelated, runTurn: broken },
      v1: { runCommand: absent }, v2: { runCommand: absent },
    });
    assert.equal(overridden.adapter, null);
    assert.ok(overridden.supervisor);
  });
  it("is not taken unless asked for — OpenCode is the default and ships in the installer", async () => {
    const wiring = await assemble({ enabled: false, runCommand: runCommand("2.1.235"), runTurn: verified });
    assert.notEqual(wiring.harnessInfo?.generation, "claude");
    assert.equal(
      wiring.logLines.some((l) => l.includes("Claude Code")),
      false,
      "a lane nobody asked for says nothing",
    );
  });

  it("is taken when asked for and verified, and names itself in what Settings reads", async () => {
    const wiring = await assemble({ enabled: true, runCommand: runCommand("2.1.235"), runTurn: verified });
    assert.equal(wiring.harnessInfo?.generation, "claude");
    assert.equal(wiring.harnessInfo?.version, "2.1.235");
    assert.equal(wiring.harnessInfo?.beta, false, "beta is a v2-generation concept");
    assert.ok(wiring.adapter, "an adapter to author with");
    assert.equal(wiring.supervisor, null, "Claude does not depend on an OpenCode process");
    assert.equal(wiring.adapter.capabilities().has("models"), true);
    await wiring.adapter.init();
    assert.equal(wiring.adapter.readiness().ready, true);
    await wiring.adapter.dispose?.();
    assert.ok(wiring.logLines.some((l) => l.includes("confinement verified")));
    assert.ok(
      wiring.logLines.some((l) => l.includes("your Claude subscription")),
      "and which credential answered, since the surprising case is the silent one",
    );
  });

  it("names an environment key when one outranked the subscription", async () => {
    const keyed = async () => ({ gateInvokedFor: ["Bash"], deniedActionHappened: false, version: "2.1.235", apiKeySource: "ANTHROPIC_API_KEY" });
    const wiring = await assemble({ enabled: true, runCommand: runCommand("2.1.235"), runTurn: keyed });
    const said = wiring.logLines.find((l) => l.includes("Claude Code 2.1.235"));
    assert.match(said!, /ANTHROPIC_API_KEY/);
    assert.match(said!, /not your subscription/);
  });

  it("carries no credential path, because the user's own login is the whole point", async () => {
    const wiring = await assemble({ enabled: true, runCommand: runCommand("2.1.235"), runTurn: verified });
    // Must not spawn or re-spawn OpenCode: on this lane there is no child holding keys.
    await wiring.relaunchHarness({ anthropic: "sk-should-not-matter" });
  });

  it("keeps the requested engine blocked when the probe refuses and states why (R-4)", async () => {
    const wiring = await assemble({ enabled: true, runCommand: runCommand("2.1.235"), runTurn: broken });
    assert.notEqual(wiring.harnessInfo?.generation, "claude", "unverified is not offered");
    assert.equal(wiring.supervisor, null);
    assert.equal(wiring.adapter, null);
    assert.match(wiring.unavailableReason!, /does not honour the tool gate/);
    const said = wiring.logLines.find((l) => l.startsWith("Claude Code unavailable"));
    assert.ok(said, "a refusal is a statement, not a silence");
    assert.match(said!, /does not honour the tool gate/);
  });

  it("says so when it was asked for and nothing is installed", async () => {
    const absent = async (command: string) =>
      command === "where" || command === "which" ? { status: 1, stdout: "" } : { status: 1, stdout: "" };
    const wiring = await assemble({ enabled: true, runCommand: absent, runTurn: verified });
    assert.ok(wiring.logLines.some((l) => l.includes("not installed")));
  });

  it("names both versions when the install is below the floor", async () => {
    const wiring = await assemble({ enabled: true, runCommand: runCommand("2.1.177"), runTurn: verified });
    const said = wiring.logLines.find((l) => l.startsWith("Claude Code unavailable"));
    assert.match(said!, /2\.1\.177/);
    assert.match(said!, /2\.1\.227/);
  });
});
