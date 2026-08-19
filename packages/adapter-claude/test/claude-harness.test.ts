import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_MIN_VERSION,
  ConfinementCache,
  discoverClaudeCode,
  meetsClaudeFloor,
  probeConfinement,
  resolveClaudeHarness,
  type ProbeTurnResult,
} from "../src/index.js";

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A file that exists, so the configured-path branch's existsSync check is real. */
function fakeBinary(name = "claude.exe"): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-claude-"));
  scratch.push(dir);
  const path = join(dir, name);
  writeFileSync(path, "");
  return path;
}

/** Answers `where`/`which` and `--version`; everything else is a miss. */
function fakeRunner(spec: { onPath?: string | null; versions?: Record<string, string> }) {
  return async (command: string, args: string[]) => {
    if (command === "where" || command === "which") {
      return spec.onPath ? { status: 0, stdout: `${spec.onPath}\n` } : { status: 1, stdout: "" };
    }
    if (args[0] === "--version") {
      const version = spec.versions?.[command];
      return version ? { status: 0, stdout: `${version} (Claude Code)\n` } : { status: 1, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
}

const turn = (over: Partial<ProbeTurnResult> = {}): ProbeTurnResult => ({
  gateInvokedFor: ["Bash"],
  deniedActionHappened: false,
  version: "2.1.235",
  ...over,
});

describe("the version floor is a pre-filter, not the decision", () => {
  it("accepts the floor itself and anything newer", () => {
    assert.equal(meetsClaudeFloor(CLAUDE_MIN_VERSION), true);
    assert.equal(meetsClaudeFloor("2.1.235"), true);
    assert.equal(meetsClaudeFloor("2.2.0"), true);
    assert.equal(meetsClaudeFloor("3.0.0"), true, "a newer major is newer, not unrecognised");
  });

  it("rejects anything older than the oldest build the probe has been exercised against", () => {
    assert.equal(meetsClaudeFloor("2.1.177"), false, "untested, not known-broken — the probe is what decides");
    assert.equal(meetsClaudeFloor("2.1.226"), false);
    assert.equal(meetsClaudeFloor("2.0.999"), false);
    assert.equal(meetsClaudeFloor("1.9.9"), false);
  });

  it("treats an unreadable version as failing, never as passing", () => {
    assert.equal(meetsClaudeFloor(null), false);
    assert.equal(meetsClaudeFloor("(Claude Code)"), false);
  });

  it("ignores a prerelease suffix rather than pretending to order it", () => {
    assert.equal(meetsClaudeFloor("2.1.227-beta.1"), true);
  });
});

describe("discovery over the user's own installation", () => {
  it("finds Claude Code on PATH", async () => {
    const found = await discoverClaudeCode({
      runCommand: fakeRunner({ onPath: "/usr/local/bin/claude", versions: { "/usr/local/bin/claude": "2.1.235" } }),
    });
    assert.equal(found.found?.source, "path");
    assert.equal(found.found?.version, "2.1.235");
  });

  it("prefers a configured path that clears the floor", async () => {
    const configured = fakeBinary();
    const found = await discoverClaudeCode({
      configuredPath: configured,
      runCommand: fakeRunner({
        onPath: "/usr/local/bin/claude",
        versions: { [configured]: "2.1.229", "/usr/local/bin/claude": "2.1.235" },
      }),
    });
    assert.equal(found.found?.source, "configured");
    assert.equal(found.found?.command, configured);
  });

  it("falls through to PATH when the configured binary is too old, rather than hiding it", async () => {
    const configured = fakeBinary();
    const found = await discoverClaudeCode({
      configuredPath: configured,
      runCommand: fakeRunner({
        onPath: "/usr/local/bin/claude",
        versions: { [configured]: "2.1.177", "/usr/local/bin/claude": "2.1.235" },
      }),
    });
    assert.equal(found.found?.source, "path", "a stale Settings entry must not mask a current install");
    assert.equal(found.rejected, null, "nothing was rejected — something better was found");
  });

  it("reports the version it turned down, so the reason can be stated", async () => {
    const found = await discoverClaudeCode({
      runCommand: fakeRunner({ onPath: "/usr/local/bin/claude", versions: { "/usr/local/bin/claude": "2.1.177" } }),
    });
    assert.equal(found.found, null);
    assert.equal(found.rejected?.version, "2.1.177");
  });

  it("distinguishes absent from too old — absence is a normal state here", async () => {
    const found = await discoverClaudeCode({ runCommand: fakeRunner({ onPath: null }) });
    assert.equal(found.found, null);
    assert.equal(found.rejected, null, "nothing answered, so nothing was rejected");
  });

  it("treats a binary that never answers as absent, not as a rejection", async () => {
    const found = await discoverClaudeCode({
      runCommand: fakeRunner({ onPath: "/usr/local/bin/claude", versions: {} }),
    });
    assert.equal(found.found, null);
    assert.equal(found.rejected, null);
  });
});

describe("the confinement probe decides, and fails closed", () => {
  it("passes only when the gate was consulted AND the action did not happen", async () => {
    const verdict = await probeConfinement("claude", async () => turn());
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.version, "2.1.235");
  });

  it("fails when a denied command ran anyway — the callback firing is not enough", async () => {
    const verdict = await probeConfinement("claude", async () => turn({ deniedActionHappened: true }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /ran anyway/);
  });

  it("fails when the gate was never consulted — unproven is not the same as safe", async () => {
    const verdict = await probeConfinement("claude", async () => turn({ gateInvokedFor: [] }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /never consulted/);
  });

  it("does not accept a gate consulted only about harmless tools", async () => {
    const verdict = await probeConfinement("claude", async () => turn({ gateInvokedFor: ["Read", "Edit"] }));
    assert.equal(verdict.ok, false, "the probe asks about the shell; anything else proves nothing");
  });

  it("counts PowerShell, because denying Bash alone was measured to be routed around", async () => {
    const verdict = await probeConfinement("claude", async () => turn({ gateInvokedFor: ["PowerShell"] }));
    assert.equal(verdict.ok, true);
  });

  it("fails closed when the probe cannot run at all", async () => {
    const verdict = await probeConfinement("claude", async () => {
      throw new Error("no auth");
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /could not run/);
  });
});

describe("the verdict cache tracks the binary updating underneath us", () => {
  it("probes once per binary and version", async () => {
    const cache = new ConfinementCache();
    let calls = 0;
    const run = async () => {
      calls += 1;
      return turn();
    };
    await cache.ensure("claude", "2.1.235", run);
    await cache.ensure("claude", "2.1.235", run);
    assert.equal(calls, 1);
  });

  it("re-probes when the version moves, because an auto-update is a different binary", async () => {
    const cache = new ConfinementCache();
    let calls = 0;
    // Each probe reports the version discovery asked about — the ordinary case, where the
    // binary is stable during the probe and only changes between sessions.
    const run = (reports: string) => async () => {
      calls += 1;
      return turn({ version: reports });
    };
    await cache.ensure("claude", "2.1.229", run("2.1.229"));
    await cache.ensure("claude", "2.1.235", run("2.1.235"));
    assert.equal(calls, 2);
  });

  it("also keys the verdict under the version that actually ran", async () => {
    // --version and the turn can disagree if the binary updates between them; without this
    // the pair would be re-probed forever under a key nothing ever matches.
    const cache = new ConfinementCache();
    let calls = 0;
    await cache.ensure("claude", "2.1.229", async () => {
      calls += 1;
      return turn({ version: "2.1.235" });
    });
    await cache.ensure("claude", "2.1.235", async () => {
      calls += 1;
      return turn({ version: "2.1.235" });
    });
    assert.equal(calls, 1);
  });

  it("caches a refusal too — a broken build is not retried every session", async () => {
    const cache = new ConfinementCache();
    let calls = 0;
    const run = async () => {
      calls += 1;
      return turn({ deniedActionHappened: true });
    };
    const first = await cache.ensure("claude", "2.1.235", run);
    const second = await cache.ensure("claude", "2.1.235", run);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(calls, 1);
  });
});

describe("whether the harness may be offered at all", () => {
  const resolve = (opts: Parameters<typeof resolveClaudeHarness>[0]) => resolveClaudeHarness(opts);

  it("is simply absent when nothing is installed", async () => {
    const result = await resolve({
      discovery: { runCommand: fakeRunner({ onPath: null }) },
      cache: new ConfinementCache(),
      runTurn: async () => turn(),
    });
    assert.equal(result.available, false);
    assert.equal(result.available === false && result.kind, "absent");
  });

  it("names both versions when the install is too old", async () => {
    const result = await resolve({
      discovery: {
        runCommand: fakeRunner({ onPath: "/usr/local/bin/claude", versions: { "/usr/local/bin/claude": "2.1.177" } }),
      },
      cache: new ConfinementCache(),
      runTurn: async () => turn(),
    });
    assert.equal(result.available === false && result.kind, "too-old");
    const reason = result.available === false ? result.reason : "";
    assert.match(reason, /2\.1\.177/, "what they have");
    assert.match(reason, new RegExp(CLAUDE_MIN_VERSION.replace(/\./g, "\\.")), "what they need");
  });

  it("refuses a build that clears the floor but fails the probe", async () => {
    const result = await resolve({
      discovery: {
        runCommand: fakeRunner({ onPath: "/usr/local/bin/claude", versions: { "/usr/local/bin/claude": "2.9.0" } }),
      },
      cache: new ConfinementCache(),
      runTurn: async () => turn({ deniedActionHappened: true, version: "2.9.0" }),
    });
    assert.equal(result.available, false, "a newer version is not evidence the gate still works");
    assert.equal(result.available === false && result.kind, "unverified");
  });

  it("offers it when discovery and the probe both agree, preferring the version that ran", async () => {
    const result = await resolve({
      discovery: {
        runCommand: fakeRunner({ onPath: "/usr/local/bin/claude", versions: { "/usr/local/bin/claude": "2.1.229" } }),
      },
      cache: new ConfinementCache(),
      runTurn: async () => turn({ version: "2.1.235" }),
    });
    assert.equal(result.available, true);
    assert.equal(result.available && result.command, "/usr/local/bin/claude");
    assert.equal(result.available && result.version, "2.1.235", "the binary updated after --version was read");
  });
});
