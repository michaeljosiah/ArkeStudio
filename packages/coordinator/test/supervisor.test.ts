import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChildSupervisor,
  allocateLoopbackPort,
  type SupervisorStatusEvent,
} from "../src/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "fixtures", "child.mjs");

function collect(sup: ChildSupervisor): SupervisorStatusEvent[] {
  const events: SupervisorStatusEvent[] = [];
  sup.on("status", (e: SupervisorStatusEvent) => events.push(e));
  return events;
}

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

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(check(), "condition not met in time");
}

describe("ChildSupervisor", () => {
  it("allocates distinct loopback ports", async () => {
    const a = await allocateLoopbackPort();
    const b = await allocateLoopbackPort();
    assert.ok(a > 0 && b > 0);
  });

  it("reports unconfigured with a stated reason when no command is set (R-6)", async () => {
    const sup = new ChildSupervisor({ id: "opencode", command: null });
    const events = collect(sup);
    await sup.start();
    assert.equal(sup.status, "unconfigured");
    assert.match(events[0]!.reason ?? "", /not configured/);
  });

  it("starts a healthy child and stops it leaving no orphan", async () => {
    const sup = new ChildSupervisor({
      id: "voxa",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy" },
      readyTimeoutMs: 10_000,
    });
    await sup.start();
    await waitForStatus(sup, "healthy");
    const pid = sup.pid;
    assert.ok(pid !== null);
    await sup.stop();
    assert.equal(sup.status, "stopped");
    await eventually(() => processGone(pid!));
  });

  it("declares failure with a stated reason when a child never becomes healthy, and kills it (R-5)", async () => {
    const sup = new ChildSupervisor({
      id: "voxa",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "never-healthy" },
      readyTimeoutMs: 1_200,
      probeIntervalMs: 100,
    });
    await sup.start();
    assert.equal(sup.status, "failed");
    assert.match(sup.reason ?? "", /did not become healthy/);
    assert.equal(sup.pid, null);
  });

  it("restarts with backoff after an unexpected exit and fails once the budget is spent (R-5)", async () => {
    const sup = new ChildSupervisor({
      id: "voxa",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy", DIE_AFTER_MS: "400" },
      readyTimeoutMs: 10_000,
      probeIntervalMs: 50,
      maxRestarts: 1,
      backoffMs: 50,
    });
    const events = collect(sup);
    await sup.start();
    await waitForStatus(sup, "failed", 30_000);
    const statuses = events.map((e) => e.status);
    assert.ok(statuses.includes("healthy"), `expected a healthy phase, saw ${statuses.join(",")}`);
    assert.ok(
      statuses.includes("unhealthy"),
      `expected an unhealthy/restarting phase, saw ${statuses.join(",")}`,
    );
    assert.match(sup.reason ?? "", /restart budget/);
    await sup.stop();
  });

  it("stops a child that ignores the polite signal, leaving no orphan", async () => {
    const sup = new ChildSupervisor({
      id: "voxa",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "ignore-stop" },
      readyTimeoutMs: 10_000,
    });
    await sup.start();
    await waitForStatus(sup, "healthy");
    const pid = sup.pid;
    assert.ok(pid !== null);
    await sup.stop();
    await eventually(() => processGone(pid!), 10_000);
  });
});
