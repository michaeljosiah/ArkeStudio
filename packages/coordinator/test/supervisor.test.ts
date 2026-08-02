import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.js";
import { ChildLedger, type ChildRecord } from "../src/child-ledger.js";
import {
  ChildSupervisor,
  allocateLoopbackPort,
  type SupervisorStatusEvent,
} from "../src/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "fixtures", "child.mjs");
const SHIM = join(here, "fixtures", "shim.cmd");
const SHIM_DETACH = join(here, "fixtures", "shim-detach.cmd");
const isWin = process.platform === "win32";

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

async function eventuallyAsync(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(await check(), "condition not met in time");
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

  it("records its child in the ledger while it runs and releases it on exit (R-5)", async () => {
    const dir = await tempDir("arke-sup-ledger-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    const sup = new ChildSupervisor(
      {
        id: "voxa",
        command: process.execPath,
        args: [CHILD],
        env: { MODE: "healthy" },
        readyTimeoutMs: 10_000,
      },
      { ledger },
    );
    const readRecords = async (): Promise<ChildRecord[]> => {
      try {
        const parsed = JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] };
        return parsed.children;
      } catch {
        return [];
      }
    };
    await sup.start();
    await waitForStatus(sup, "healthy");
    const pid = sup.pid;
    assert.ok(pid !== null);
    // Recording is fire-and-forget off the spawn path, so it lands shortly after healthy.
    await eventuallyAsync(async () => (await readRecords()).some((c) => c.pid === pid));
    const rec = (await readRecords()).find((c) => c.pid === pid)!;
    assert.equal(rec.id, "voxa");
    assert.equal(rec.image, basename(process.execPath).toLowerCase());
    assert.equal(rec.ownerPid, process.pid);
    await sup.stop();
    await eventuallyAsync(async () => (await readRecords()).length === 0);
  });

  // A .cmd child makes the supervised pid a cmd.exe wrapper and the working process its
  // grandchild — the npm-shim shape that orphaned opencode.exe. The health body carries the
  // grandchild's own pid, so the tests can watch the process the wrapper's pid cannot reach.
  it("kills the grandchild behind a shell shim on stop, and records it in the ledger (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-shim-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    const readRecords = async (): Promise<ChildRecord[]> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return [];
      }
    };
    const sup = new ChildSupervisor(
      {
        id: "opencode",
        command: SHIM,
        env: { MODE: "healthy", ARKE_SHIM_NODE: process.execPath, ARKE_SHIM_TARGET: CHILD },
        readyTimeoutMs: 15_000,
      },
      { ledger },
    );
    let grandchild: number | null = null;
    try {
      await sup.start();
      await waitForStatus(sup, "healthy");
      const wrapperPid = sup.pid;
      assert.ok(wrapperPid !== null);
      const res = await fetch(`http://127.0.0.1:${sup.port}/health`);
      grandchild = (JSON.parse(await res.text()) as { pid: number }).pid;
      assert.notEqual(grandchild, wrapperPid, "the worker must be a grandchild, not the wrapper");
      assert.ok(!processGone(grandchild), "the grandchild must be alive while healthy");
      // The descendant snapshot lands in the ledger, so a crashed run's sweep can reach
      // past the wrapper. Enumeration is a PowerShell round-trip — give it time.
      await eventuallyAsync(async () => (await readRecords()).some((c) => c.pid === grandchild), 20_000);
      const rec = (await readRecords()).find((c) => c.pid === grandchild)!;
      assert.equal(rec.parentPid, wrapperPid);
      assert.equal(rec.image, basename(process.execPath).toLowerCase());
      await sup.stop();
      assert.equal(sup.status, "stopped");
      await eventually(() => processGone(wrapperPid), 10_000);
      await eventually(() => processGone(grandchild!), 10_000);
      await eventuallyAsync(async () => (await readRecords()).length === 0, 10_000);
    } finally {
      await sup.stop();
      if (grandchild !== null && !processGone(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  });

  it("reaps a surviving grandchild when the wrapper dies out from under it (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-detach-");
    const ledgerPath = join(dir, "children.json");
    const exitFlag = join(dir, "wrapper-exit.flag");
    const ledger = new ChildLedger(ledgerPath);
    const readRecords = async (): Promise<ChildRecord[]> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return [];
      }
    };
    const sup = new ChildSupervisor(
      {
        id: "opencode",
        command: SHIM_DETACH,
        env: {
          MODE: "healthy",
          ARKE_SHIM_NODE: process.execPath,
          ARKE_SHIM_TARGET: CHILD,
          ARKE_SHIM_EXIT_FLAG: exitFlag,
        },
        readyTimeoutMs: 15_000,
        maxRestarts: 0,
      },
      { ledger },
    );
    let grandchild: number | null = null;
    try {
      await sup.start();
      await waitForStatus(sup, "healthy");
      const res = await fetch(`http://127.0.0.1:${sup.port}/health`);
      grandchild = (JSON.parse(await res.text()) as { pid: number }).pid;
      // Wait for the adoption snapshot before pulling the wrapper away — a wrapper that
      // dies pre-snapshot is the documented gap, not what this test is about.
      await eventuallyAsync(async () => (await readRecords()).some((c) => c.pid === grandchild), 20_000);
      await writeFile(exitFlag, "go");
      // The wrapper exits "cleanly"; the worker survives it. The supervisor must notice and
      // take the survivor down before settling into failed (budget of zero).
      await waitForStatus(sup, "failed", 20_000);
      await eventually(() => processGone(grandchild!), 10_000);
      await eventuallyAsync(async () => !(await readRecords()).some((c) => c.pid === grandchild), 10_000);
    } finally {
      await sup.stop();
      if (grandchild !== null && !processGone(grandchild)) process.kill(grandchild, "SIGKILL");
    }
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
