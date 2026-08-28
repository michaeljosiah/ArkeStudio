import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.js";
import { until, untilAsync } from "./wait.js";
import { ChildLedger, type ChildRecord, type ProcessInfo } from "../src/child-ledger.js";
import { ChildSupervisor } from "../src/supervisor.js";

// The CIM retry paths in adoptDescendants and reapSurvivors exist for failures the real
// process table will not produce on demand, so these tests inject the failures through the
// SupervisorDeps seams instead of hoping WMI misbehaves. Everything else — the child, the
// ledger, the kill — is real. The review of PR #614 is where the two gaps were confirmed:
// a single thrown enumeration untracked a grandchild for the child's whole lifetime, and a
// single thrown identity probe stranded survivors that nothing in-process ever re-probed.

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "fixtures", "child.mjs");
const isWin = process.platform === "win32";

// Budgets follow supervisor.test.ts's tiers. The injected calls settle instantly, so these
// are starved-runner ceilings, not expectations — polling returns the moment each holds.
const SETTLE_WAIT_MS = 30_000;

// A pid no live process plausibly wears, for descendants that only need to exist on paper.
const PAPER_PID = 999_999_937;

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function healthySpec() {
  return {
    id: "voxa",
    command: process.execPath,
    args: [CHILD],
    env: { MODE: "healthy" },
    readyTimeoutMs: 30_000,
  };
}

async function quiet(ms: number): Promise<void> {
  // Proving a non-event has no wait to poll for — see wait.ts's header on the asymmetry.
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ChildSupervisor CIM retries", () => {
  it("retries the descendant enumeration and snapshots on a later attempt (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-retry-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return null;
      }
    };
    let calls = 0;
    const sup = new ChildSupervisor(healthySpec(), {
      ledger,
      listDescendants: async () => {
        calls += 1;
        if (calls === 1) throw new Error("the RPC server is unavailable");
        return [{ pid: PAPER_PID, parentPid: 0, image: "node.exe", startedAt: Date.now() }];
      },
    });
    try {
      await sup.start();
      await until(() => sup.status === "healthy", "the child to become healthy", SETTLE_WAIT_MS);
      // The first attempt failed; the snapshot must still land, from the retry.
      let rec: ChildRecord | undefined;
      await untilAsync(
        async () => {
          rec = (await readRecords())?.find((c) => c.pid === PAPER_PID);
          return rec !== undefined;
        },
        "the retried snapshot to land in the ledger",
        SETTLE_WAIT_MS,
      );
      assert.equal(calls, 2, "one failure, one success — no third attempt");
      assert.equal(rec!.parentPid, sup.pid);
      assert.ok(sup.descendantPids.includes(PAPER_PID), "the exit backstop sees the snapshot too");
      await sup.stop();
      // The paper descendant is already "dead", so stop releases it alongside the child.
      await untilAsync(
        async () => (await readRecords())?.length === 0,
        "both records to be released after stop",
        SETTLE_WAIT_MS,
      );
    } finally {
      await sup.stop();
    }
  });

  it("gives up after three enumeration attempts and leaves no snapshot (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-retry-");
    const ledger = new ChildLedger(join(dir, "children.json"));
    let calls = 0;
    const sup = new ChildSupervisor(healthySpec(), {
      ledger,
      listDescendants: async () => {
        calls += 1;
        throw new Error("the RPC server is unavailable");
      },
    });
    try {
      await sup.start();
      await until(() => sup.status === "healthy", "the child to become healthy", SETTLE_WAIT_MS);
      await until(() => calls === 3, "all three enumeration attempts to be spent", SETTLE_WAIT_MS);
      await quiet(800);
      assert.equal(calls, 3, "the bound holds — no fourth attempt");
      assert.deepEqual(sup.descendantPids, [], "no snapshot from failed enumeration");
    } finally {
      await sup.stop();
    }
  });

  it("abandons the enumeration retry when stopped mid-backoff (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-retry-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return null;
      }
    };
    let calls = 0;
    const sup = new ChildSupervisor(healthySpec(), {
      ledger,
      listDescendants: async () => {
        calls += 1;
        if (calls === 1) throw new Error("the RPC server is unavailable");
        return [{ pid: PAPER_PID, parentPid: 0, image: "node.exe", startedAt: Date.now() }];
      },
    });
    try {
      await sup.start();
      await until(() => sup.status === "healthy", "the child to become healthy", SETTLE_WAIT_MS);
      await until(() => calls === 1, "the first enumeration attempt to fail", SETTLE_WAIT_MS);
      // The loop is now in its 500ms backoff. stop() nulls the child synchronously and
      // resolves the sleep early, so the second attempt must never run — and this ordering
      // holds under load, because the poll timer above fires before the longer backoff timer
      // and stop() runs inside its callback.
      await sup.stop();
      await quiet(800);
      assert.equal(calls, 1, "the abandoned retry never re-enumerated");
      assert.deepEqual(sup.descendantPids, [], "no snapshot after stop");
      const records = await readRecords();
      assert.ok(records !== null && !records.some((c) => c.pid === PAPER_PID), "no paper record either");
    } finally {
      await sup.stop();
    }
  });

  it("retries the identity probe once at reap time and still kills the survivor (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-retry-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return null;
      }
    };
    // A real process stands in for the surviving grandchild: identity checks and the kill
    // are the parts under test, so they must run against something that can actually die.
    const survivor: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const survivorPid = survivor.pid!;
    const survivorStartedAt = Date.now();
    let probes = 0;
    const probedPids: number[][] = [];
    const sup = new ChildSupervisor(healthySpec(), {
      ledger,
      listDescendants: async () => [
        { pid: survivorPid, parentPid: 0, image: "node.exe", startedAt: survivorStartedAt },
      ],
      // No asserts inside the seam: a throw here is indistinguishable from the injected
      // failure and would be eaten by the retry's catch. Capture, assert outside.
      probe: async (pids) => {
        probes += 1;
        probedPids.push([...pids]);
        if (probes === 1) throw new Error("the RPC server is unavailable");
        return new Map<number, ProcessInfo>([
          [survivorPid, { pid: survivorPid, image: "node.exe", startedAt: survivorStartedAt }],
        ]);
      },
    });
    try {
      await sup.start();
      await until(() => sup.status === "healthy", "the child to become healthy", SETTLE_WAIT_MS);
      await untilAsync(
        async () => ((await readRecords()) ?? []).some((c) => c.pid === survivorPid),
        "the survivor's snapshot to land before stopping",
        SETTLE_WAIT_MS,
      );
      await sup.stop();
      assert.equal(probes, 2, "one failed probe, one that answered");
      assert.deepEqual(probedPids, [[survivorPid], [survivorPid]], "both attempts probed the survivor alone");
      await until(() => processGone(survivorPid), "the survivor to be killed after the retried probe", SETTLE_WAIT_MS);
      await untilAsync(
        async () => (await readRecords())?.length === 0,
        "every record to be released after the reap",
        SETTLE_WAIT_MS,
      );
    } finally {
      await sup.stop();
      if (!processGone(survivorPid)) survivor.kill();
    }
  });

  it("keeps the survivor and its record when both probe attempts fail (win32)", { skip: !isWin }, async () => {
    const dir = await tempDir("arke-sup-retry-");
    const ledgerPath = join(dir, "children.json");
    const ledger = new ChildLedger(ledgerPath);
    const readRecords = async (): Promise<ChildRecord[] | null> => {
      try {
        return (JSON.parse(await readFile(ledgerPath, "utf8")) as { children: ChildRecord[] }).children;
      } catch {
        return null;
      }
    };
    const survivor: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const survivorPid = survivor.pid!;
    let probes = 0;
    const sup = new ChildSupervisor(healthySpec(), {
      ledger,
      listDescendants: async () => [
        { pid: survivorPid, parentPid: 0, image: "node.exe", startedAt: Date.now() },
      ],
      probe: async () => {
        probes += 1;
        throw new Error("the RPC server is unavailable");
      },
    });
    try {
      await sup.start();
      await until(() => sup.status === "healthy", "the child to become healthy", SETTLE_WAIT_MS);
      await untilAsync(
        async () => ((await readRecords()) ?? []).some((c) => c.pid === survivorPid),
        "the survivor's snapshot to land before stopping",
        SETTLE_WAIT_MS,
      );
      await sup.stop();
      // Identity was never established, so nothing may die and the record must survive as
      // the next startup sweep's evidence — the documented contract, now after one retry.
      assert.equal(probes, 2, "exactly the bounded two attempts");
      assert.ok(!processGone(survivorPid), "an unverified survivor is never killed");
      await untilAsync(
        async () => {
          const records = await readRecords();
          return records !== null && records.some((c) => c.pid === survivorPid);
        },
        "the survivor's record to remain for the sweep",
        SETTLE_WAIT_MS,
      );
    } finally {
      await sup.stop();
      if (!processGone(survivorPid)) survivor.kill();
    }
  });
});
