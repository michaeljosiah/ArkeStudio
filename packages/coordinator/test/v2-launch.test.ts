import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.js";
import {
  assembleHarness,
  HarnessPasswordHolder,
  harnessProfileDir,
  passwordFromLine,
  v2ProfileEnv,
} from "../src/harness/v2-launch.js";
import { ChildSupervisor, type SupervisorStatusEvent } from "../src/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "fixtures", "child.mjs");

function waitForStatus(sup: ChildSupervisor, wanted: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sup.status === wanted) return resolve();
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${wanted}" (at "${sup.status}")`)),
      timeoutMs,
    );
    sup.on("status", (e: SupervisorStatusEvent) => {
      if (e.status === wanted) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe("the v2 launch protocol (issue 327 §4)", () => {
  it("parses the password line and only the password line", () => {
    assert.equal(passwordFromLine("server password s3cret_value"), "s3cret_value");
    assert.equal(passwordFromLine("  server password s3cret_value \r"), "s3cret_value");
    assert.equal(passwordFromLine("server listening on http://127.0.0.1:14099"), null);
    assert.equal(passwordFromLine("server password"), null);
    assert.equal(passwordFromLine(""), null);
  });

  it("answers bare headers before the password and Basic auth after", () => {
    const holder = new HarnessPasswordHolder();
    assert.deepEqual(holder.healthHeaders(), {}, "a bare probe reads as 'not yet', never a guess");
    holder.onStdoutLine("server listening on http://127.0.0.1:14099");
    holder.onStdoutLine("server password pw_1");
    assert.equal(holder.current(), "pw_1");
    assert.deepEqual(holder.healthHeaders(), {
      authorization: "Basic " + Buffer.from("opencode:pw_1").toString("base64"),
    });
    // A restarted child prints a fresh secret; the newest one wins.
    holder.onStdoutLine("server password pw_2");
    assert.equal(holder.current(), "pw_2");
  });

  it("redirects the whole profile, all four variables together (issue 327 §2)", () => {
    const env = v2ProfileEnv("C:\\root\\harness\\profile");
    assert.equal(env["HOME"], "C:\\root\\harness\\profile");
    assert.equal(env["USERPROFILE"], "C:\\root\\harness\\profile");
    assert.equal(env["XDG_CONFIG_HOME"], join("C:\\root\\harness\\profile", ".config"));
    assert.equal(env["XDG_DATA_HOME"], join("C:\\root\\harness\\profile", ".local", "share"));
    assert.equal(harnessProfileDir("C:\\root"), join("C:\\root", "harness", "profile"));
  });

  it("carries a v2 child from password line to authenticated health, no secret in any status", async () => {
    const holder = new HarnessPasswordHolder();
    const events: SupervisorStatusEvent[] = [];
    const sup = new ChildSupervisor({
      id: "opencode",
      command: process.execPath,
      args: [CHILD],
      env: { PASSWORD: "spike-launch-secret" },
      healthPath: "/api/health",
      healthHeaders: holder.healthHeaders,
      onStdoutLine: holder.onStdoutLine,
      readyTimeoutMs: 10_000,
    });
    sup.on("status", (e: SupervisorStatusEvent) => events.push(e));
    try {
      await sup.start();
      await waitForStatus(sup, "healthy");
      assert.equal(holder.current(), "spike-launch-secret", "the launch line reached the holder");
      // The fixture 401s unauthenticated requests, so healthy PROVES the header flowed.
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes("spike-launch-secret"), "the password appears in no status event");
    } finally {
      await sup.stop();
    }
  });

  it("updateEnv before start only stores; after start it restarts the child", async () => {
    const sup = new ChildSupervisor({
      id: "opencode",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy" },
      healthPath: "/api/health",
      readyTimeoutMs: 10_000,
    });
    try {
      // Before the first start: stored, nothing spawned.
      await sup.updateEnv({ ANTHROPIC_API_KEY: "sk-test" });
      assert.equal(sup.pid, null, "an unstarted child stays unstarted");
      await sup.start();
      await waitForStatus(sup, "healthy");
      const firstPid = sup.pid;
      assert.ok(firstPid !== null);
      // After start: the merge restarts, because environment reaches a process only at spawn.
      await sup.updateEnv({ OPENAI_API_KEY: "sk-test-2" });
      await waitForStatus(sup, "healthy");
      assert.notEqual(sup.pid, firstPid, "a running child restarts to pick up the new env");
    } finally {
      await sup.stop();
    }
  });

  it("updateEnv honours deletion markers and skips restarts when nothing changed", async () => {
    const sup = new ChildSupervisor({
      id: "opencode",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy", ANTHROPIC_API_KEY: "sk-revoke-me" },
      healthPath: "/api/health",
      readyTimeoutMs: 10_000,
    });
    const events: SupervisorStatusEvent[] = [];
    sup.on("status", (e: SupervisorStatusEvent) => events.push(e));
    try {
      await sup.start();
      await waitForStatus(sup, "healthy");
      const firstPid = sup.pid;

      // An identical patch must not cost an in-flight turn its harness.
      const restartsBefore = events.filter((e) => e.status === "starting").length;
      await sup.updateEnv({ ANTHROPIC_API_KEY: "sk-revoke-me" });
      assert.equal(sup.pid, firstPid, "re-saving the same key does not restart");
      assert.equal(
        events.filter((e) => e.status === "starting").length,
        restartsBefore,
        "no restart cycle ran for a no-op patch",
      );

      // A cleared credential is a DELETION the merge must honour — the revoked key
      // surviving the next spawn is a revocation that did not happen (issue 327 review).
      await sup.updateEnv({ ANTHROPIC_API_KEY: undefined });
      await waitForStatus(sup, "healthy");
      assert.notEqual(sup.pid, firstPid, "removal restarts to shed the key");
      const port = sup.port;
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = (await res.json()) as { env?: Record<string, string | undefined> };
      assert.equal(body.env?.["ANTHROPIC_API_KEY"], undefined, "the revoked key is gone from the child env");
    } finally {
      await sup.stop();
    }
  });

  it("assembles the absent case honestly: null adapter, unconfigured supervisor, stated reason", async () => {
    const nothing = async () => ({ status: 1, stdout: "" });
    const wiring = await assembleHarness({
      appRoot: await tempDir("v2-launch-"),
      v1: { runCommand: nothing },
      v2: { runCommand: nothing },
    });
    assert.equal(wiring.harness, null);
    assert.equal(wiring.adapter, null);
    assert.equal(wiring.harnessInfo, undefined);
    assert.deepEqual(wiring.logLines, ["OpenCode: not found — authoring disabled"]);
    await wiring.supervisor.start();
    assert.equal(wiring.supervisor.status, "unconfigured");
  });

  it("names the legacy knob's fate instead of routing around it silently", async () => {
    const machine = (answers: Record<string, string>) => async (command: string, args: string[]) => {
      if (command === "where" || command === "which") {
        const target = args[0]!;
        return answers[target] !== undefined
          ? { status: 0, stdout: `C:\\bin\\${target}.exe\n` }
          : { status: 1, stdout: "" };
      }
      const name = command.replace(/^C:\\bin\\/, "").replace(/\.exe$/, "");
      return answers[name] !== undefined ? { status: 0, stdout: answers[name]! } : { status: 1, stdout: "" };
    };
    // A configured v1 path exists, but v2 on PATH wins: the pass-over is stated (R-4).
    const both = { opencode: "opencode v1.18.18", opencode2: "opencode2 v0.0.0-next-17444" };
    const wiring = await assembleHarness({
      appRoot: await tempDir("v2-launch-"),
      v1: { configuredPath: process.execPath, runCommand: machine(both) },
      v2: { runCommand: machine(both) },
    });
    assert.equal(wiring.isV2, true);
    assert.ok(
      wiring.logLines.some((l) => l.includes("configured OpenCode path passed over")),
      `the pass-over is stated: ${wiring.logLines.join(" | ")}`,
    );
  });
});
