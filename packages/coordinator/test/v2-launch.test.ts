import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
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
});
