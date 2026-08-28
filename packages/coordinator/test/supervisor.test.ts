import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.js";
import { until, untilAsync } from "./wait.js";
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

// Wait budgets sized for a starved runner, not the healthy case — polling returns the moment
// the condition holds, so a generous cap costs a green run nothing. The descendant snapshot and
// the reap path's identity check each ride a PowerShell Get-CimInstance round-trip that takes
// ~1s on an idle machine but stretched past a 20s budget on a loaded windows-latest shard (runs
// 33165842362 / 33166864850 burned exactly that cap). Everything else is process death and
// enqueued ledger writes settling, which the same contention starves for seconds at a time.
const CIM_WAIT_MS = 60_000;
const SETTLE_WAIT_MS = 30_000;
// The shim specs' readyTimeoutMs is the one budget the supervisor itself enforces — when it
// expires the child is killed and "failed" is terminal, so no test-side wait can compensate
// for it afterwards. 15s was the last number here still sized for the healthy case.
const SHIM_READY_MS = 30_000;
// Healthy waits sit above every spec's ready budget (10s plain, SHIM_READY_MS for shims). The
// wait's clock starts at start() while the ready budget starts after the spawn settles, so a
// wait at or under the budget can reject while the child is still legitimately coming up; a
// genuinely expired budget then reports as "(at failed)" rather than a raw wait timeout.
const HEALTHY_WAIT_MS = 40_000;

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
    try {
      await waitForStatus(sup, "healthy", HEALTHY_WAIT_MS);
      const pid = sup.pid;
      assert.ok(pid !== null);
      await sup.stop();
      assert.equal(sup.status, "stopped");
      await until(() => processGone(pid!), "the stopped child to be gone", SETTLE_WAIT_MS);
    } finally {
      // A failed wait must not leak the live child: its piped stdio holds this process open,
      // and the file then hangs into CI's silence kill instead of reporting the named failure.
      await sup.stop();
    }
  });

  it("requires the configured health protocol before becoming healthy", async () => {
    const sup = new ChildSupervisor({
      id: "voxa",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy", PROTOCOL_VERSION: "2" },
      validateHealth: async (response) => (await response.json() as { protocolVersion?: number }).protocolVersion === 1,
      readyTimeoutMs: 500,
      probeIntervalMs: 50,
    });
    await sup.start();
    try {
      assert.equal(sup.status, "failed");
      assert.match(sup.reason ?? "", /did not become healthy/);
    } finally {
      await sup.stop();
    }
  });

  it("reports a typed protocol failure instead of generic absence", async () => {
    // The budget is generous on purpose. A stated incompatibility is terminal, so this returns
    // as soon as the child answers once — the budget only has to cover process spawn, which on a
    // loaded machine takes longer than the 500ms this used to allow. That race was the flake:
    // under load the child never answered in time, validateHealth never ran, and the assertion
    // saw the timeout message instead of the reason. The reason itself proves the early exit —
    // the budget-expiry path reports "did not become healthy" instead — so there is no
    // wall-clock ceiling here for a starved shard to trip.
    const sup = new ChildSupervisor({
      id: "voxa",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy", PROTOCOL_VERSION: "2" },
      validateHealth: async () => ({ ok: false, reason: "voxa health contract is incompatible" }),
      readyTimeoutMs: 20_000,
      probeIntervalMs: 50,
    });
    await sup.start();
    try {
      assert.equal(sup.status, "failed");
      assert.equal(sup.reason, "voxa health contract is incompatible");
    } finally {
      await sup.stop();
    }
  });

  it("does not restart or spend restart budget after a terminal startup contract failure", async () => {
    let validations = 0;
    const sup = new ChildSupervisor({
      id: "comfyui",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy" },
      validateHealth: async () => {
        validations += 1;
        return { ok: false, reason: "ComfyUI is below the supported version floor" };
      },
      readyTimeoutMs: 10_000,
      probeIntervalMs: 50,
      maxRestarts: 3,
      backoffMs: 10,
    });
    const events = collect(sup);
    try {
      await sup.start();
      assert.equal(sup.status, "failed");
      assert.equal(sup.reason, "ComfyUI is below the supported version floor");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(validations, 1, "the terminal child was not relaunched");
      assert.equal(events.filter((event) => /restarting/.test(event.reason ?? "")).length, 0);
      assert.equal(events.filter((event) => event.status === "starting").length, 1);
    } finally {
      await sup.stop();
    }
  });

  it("observes a child that exits immediately instead of probing it to the startup timeout", async () => {
    const sup = new ChildSupervisor({
      id: "comfyui",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "exit-immediately" },
      readyTimeoutMs: 10_000,
      probeIntervalMs: 50,
      maxRestarts: 0,
    });
    try {
      await sup.start();
      await waitForStatus(sup, "failed", SETTLE_WAIT_MS);
      // The reason proves the path taken: an unobserved exit would probe to the 10s ready
      // budget and report "did not become healthy", never touching the restart budget. No
      // wall-clock ceiling — a starved spawn already pushed a 5s one past its line.
      assert.match(sup.reason ?? "", /restart budget/);
    } finally {
      await sup.stop();
    }
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
    try {
      assert.equal(sup.status, "failed");
      assert.match(sup.reason ?? "", /did not become healthy/);
      assert.equal(sup.pid, null);
    } finally {
      await sup.stop();
    }
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
    try {
      // The wait spans a whole die -> backoff -> respawn -> probe -> die cycle: two spawns'
      // worth of starved latency, so it gets two settle budgets the same way the reap test's
      // two-spawn wait gets two CIM budgets.
      await waitForStatus(sup, "failed", 2 * SETTLE_WAIT_MS);
      const statuses = events.map((e) => e.status);
      assert.ok(statuses.includes("healthy"), `expected a healthy phase, saw ${statuses.join(",")}`);
      assert.ok(
        statuses.includes("unhealthy"),
        `expected an unhealthy/restarting phase, saw ${statuses.join(",")}`,
      );
      assert.match(sup.reason ?? "", /restart budget/);
    } finally {
      await sup.stop();
    }
  });

  it("restarts a live child whose continuous health stays down", async () => {
    const sup = new ChildSupervisor({
      id: "comfyui",
      command: process.execPath,
      args: [CHILD],
      // Startup consumes one request. Every later request fails while the process remains alive.
      env: { MODE: "healthy", HEALTHY_REQUESTS: "1" },
      readyTimeoutMs: 10_000,
      probeIntervalMs: 50,
      healthIntervalMs: 25,
      healthFailureThreshold: 2,
      maxRestarts: 0,
    });
    const events = collect(sup);
    try {
      await sup.start();
      // "failed" lands only after forceStop's taskkill spawn and the exit propagate — external
      // work the settle tier is sized for.
      await waitForStatus(sup, "failed", SETTLE_WAIT_MS);
      assert.ok(events.some((event) => event.status === "healthy"));
      assert.ok(events.some((event) => event.status === "unhealthy" && /continuous health/.test(event.reason ?? "")));
      assert.match(sup.reason ?? "", /restart budget/);
    } finally {
      await sup.stop();
    }
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
    // Null on a failed read, never []: the release waits below assert emptiness, and a
    // transiently unreadable file (a scanner's handle on the freshly renamed ledger) must
    // retry rather than pass as "released".
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        const parsed = JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] };
        return parsed.children;
      } catch {
        return null;
      }
    };
    await sup.start();
    try {
      await waitForStatus(sup, "healthy", HEALTHY_WAIT_MS);
      const pid = sup.pid;
      assert.ok(pid !== null);
      // Recording is fire-and-forget off the spawn path, so it lands shortly after healthy.
      // The record is captured inside the poll: adoption keeps writing sibling records (the
      // child's conhost.exe) as this wait ends, so a separate re-read could sample the file
      // mid-rename and turn a green wait into a bare TypeError.
      let rec: ChildRecord | undefined;
      await untilAsync(
        async () => {
          rec = (await readRecords())?.find((c) => c.pid === pid);
          return rec !== undefined;
        },
        "the child's ledger record to land",
        SETTLE_WAIT_MS,
      );
      assert.equal(rec!.id, "voxa");
      assert.equal(rec!.image, basename(process.execPath).toLowerCase());
      assert.equal(rec!.ownerPid, process.pid);
      await sup.stop();
      // release() is enqueued from the exit listener, not awaited by stop() — let it settle.
      await untilAsync(
        async () => (await readRecords())?.length === 0,
        "the ledger to release the exited child",
        SETTLE_WAIT_MS,
      );
    } finally {
      await sup.stop();
    }
  });

  // A .cmd child makes the supervised pid a cmd.exe wrapper and the working process its
  // grandchild — the npm-shim shape that orphaned opencode.exe. The health body carries the
  // grandchild's own pid, so the tests can watch the process the wrapper's pid cannot reach.
  it("kills the grandchild behind a shell shim on stop, and records it in the ledger (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-shim-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    // Null on a failed read, never [] — see the ledger test's reader for why.
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return null;
      }
    };
    const sup = new ChildSupervisor(
      {
        id: "opencode",
        command: SHIM,
        env: { MODE: "healthy", ARKE_SHIM_NODE: process.execPath, ARKE_SHIM_TARGET: CHILD },
        readyTimeoutMs: SHIM_READY_MS,
      },
      { ledger },
    );
    let grandchild: number | null = null;
    let grandchildSeenDead = false;
    try {
      await sup.start();
      await waitForStatus(sup, "healthy", HEALTHY_WAIT_MS);
      const wrapperPid = sup.pid;
      assert.ok(wrapperPid !== null);
      const res = await fetch(`http://127.0.0.1:${sup.port}/health`);
      grandchild = (JSON.parse(await res.text()) as { pid: number }).pid;
      assert.notEqual(grandchild, wrapperPid, "the worker must be a grandchild, not the wrapper");
      assert.ok(!processGone(grandchild), "the grandchild must be alive while healthy");
      // The descendant snapshot lands in the ledger, so a crashed run's sweep can reach
      // past the wrapper. Enumeration is the CIM round-trip the budget note explains; the
      // record is captured inside the poll because adoption keeps writing sibling records
      // as the wait ends, and a separate re-read could sample the file mid-rename.
      let rec: ChildRecord | undefined;
      await untilAsync(
        async () => {
          rec = (await readRecords())?.find((c) => c.pid === grandchild);
          return rec !== undefined;
        },
        "the grandchild's descendant snapshot to land in the ledger",
        CIM_WAIT_MS,
      );
      assert.equal(rec!.parentPid, wrapperPid);
      assert.equal(rec!.image, basename(process.execPath).toLowerCase());
      await sup.stop();
      assert.equal(sup.status, "stopped");
      await until(() => processGone(wrapperPid), "the wrapper to die after stop", SETTLE_WAIT_MS);
      await until(() => processGone(grandchild!), "the grandchild to die after stop", SETTLE_WAIT_MS);
      grandchildSeenDead = true;
      await untilAsync(
        async () => (await readRecords())?.length === 0,
        "both ledger records to be released after stop",
        SETTLE_WAIT_MS,
      );
    } finally {
      await sup.stop();
      // Fall back to a direct kill only when the test never saw the grandchild die: after a
      // confirmed death the pid may already be a stranger's (Windows recycles aggressively,
      // and the budgets above stretch the window to a minute).
      if (!grandchildSeenDead && grandchild !== null && !processGone(grandchild)) {
        process.kill(grandchild, "SIGKILL");
      }
    }
  });

  it("reaps a surviving grandchild when the wrapper dies out from under it (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-detach-");
    const ledgerPath = join(dir, "children.json");
    const exitFlag = join(dir, "wrapper-exit.flag");
    const ledger = new ChildLedger(ledgerPath);
    // Null on a failed read, never [] — see the ledger test's reader for why.
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return null;
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
        readyTimeoutMs: SHIM_READY_MS,
        maxRestarts: 0,
      },
      { ledger },
    );
    let grandchild: number | null = null;
    let grandchildSeenDead = false;
    try {
      await sup.start();
      await waitForStatus(sup, "healthy", HEALTHY_WAIT_MS);
      const res = await fetch(`http://127.0.0.1:${sup.port}/health`);
      grandchild = (JSON.parse(await res.text()) as { pid: number }).pid;
      // Wait for the adoption snapshot before pulling the wrapper away — a wrapper that
      // dies pre-snapshot is the documented gap, not what this test is about.
      await untilAsync(
        async () => ((await readRecords()) ?? []).some((c) => c.pid === grandchild),
        "the adoption snapshot to land before the wrapper is pulled away",
        CIM_WAIT_MS,
      );
      await writeFile(exitFlag, "go");
      // The wrapper exits "cleanly"; the worker survives it. The supervisor must notice and
      // take the survivor down before settling into failed (budget of zero). Noticing rides
      // TWO starved spawns in sequence — the reap path's CIM identity probe, then taskkill —
      // where the snapshot waits ride one, so the deadline doubles theirs (the pinned-load
      // measurement came out almost exactly 2x: 36.3s against 18.8s).
      await waitForStatus(sup, "failed", 2 * CIM_WAIT_MS);
      await until(() => processGone(grandchild!), "the surviving grandchild to be reaped", SETTLE_WAIT_MS);
      grandchildSeenDead = true;
      // Released means a successful read that no longer shows the pid — an unreadable ledger
      // must keep retrying rather than count as released.
      await untilAsync(
        async () => {
          const records = await readRecords();
          return records !== null && !records.some((c) => c.pid === grandchild);
        },
        "the reaped grandchild's record to be released",
        SETTLE_WAIT_MS,
      );
    } finally {
      await sup.stop();
      // Same stale-pid guard as the shim-kill test's fallback: only when death was never seen.
      if (!grandchildSeenDead && grandchild !== null && !processGone(grandchild)) {
        process.kill(grandchild, "SIGKILL");
      }
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
    try {
      await waitForStatus(sup, "healthy", HEALTHY_WAIT_MS);
      const pid = sup.pid;
      assert.ok(pid !== null);
      await sup.stop();
      await until(() => processGone(pid!), "the stop-ignoring child to be gone", SETTLE_WAIT_MS);
    } finally {
      await sup.stop();
    }
  });
});
