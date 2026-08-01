import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tempDir } from "./tmp.js";
import {
  ChildLedger,
  ownerStamp,
  platformProbe,
  type ChildRecord,
  type ProcessInfo,
} from "../src/child-ledger.js";

/** An idle child that lives until killed — the thing a force-killed parent leaves behind. */
function spawnIdle(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** A pid guaranteed dead: a process that has already exited. Start time set ancient so a
 * pid-reuse impostor can never be mistaken for the recorded owner. */
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((r) => p.once("exit", () => r()));
  return p.pid!;
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

const nodeImage = basename(process.execPath).toLowerCase();

async function tempLedgerPath(): Promise<string> {
  const dir = await tempDir("arke-ledger-");
  return join(dir, "run", "children.json");
}

async function readChildren(path: string): Promise<ChildRecord[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { children: ChildRecord[] };
  return parsed.children;
}

function record(pid: number, overrides: Partial<ChildRecord> = {}): ChildRecord {
  return {
    pid,
    image: nodeImage,
    id: "test-child",
    ...ownerStamp(),
    recordedAt: Date.now(),
    ...overrides,
  };
}

describe("ChildLedger", () => {
  it("records spawns and releases exits", async () => {
    const path = await tempLedgerPath();
    const ledger = new ChildLedger(path);
    await ledger.record(record(1111));
    await ledger.record(record(2222));
    assert.deepEqual((await readChildren(path)).map((c) => c.pid), [1111, 2222]);
    await ledger.release(1111);
    assert.deepEqual((await readChildren(path)).map((c) => c.pid), [2222]);
    // Releasing an unknown pid is a no-op, not an error.
    await ledger.release(9999);
    assert.deepEqual((await readChildren(path)).map((c) => c.pid), [2222]);
  });

  it("re-recording a pid replaces the old record", async () => {
    const path = await tempLedgerPath();
    const ledger = new ChildLedger(path);
    await ledger.record(record(1111, { id: "old" }));
    await ledger.record(record(1111, { id: "new" }));
    const children = await readChildren(path);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.id, "new");
  });

  it("reapStale on an absent ledger reaps nothing and probes nothing", async () => {
    const ledger = new ChildLedger(await tempLedgerPath(), {
      probe: () => {
        throw new Error("must not probe an empty ledger");
      },
    });
    const report = await ledger.reapStale();
    assert.deepEqual(report, { reaped: [], kept: 0, cleared: 0 });
  });

  it("kills a verified orphan whose recorded owner is dead", async () => {
    const path = await tempLedgerPath();
    const ledger = new ChildLedger(path);
    const orphan = spawnIdle();
    try {
      await ledger.record(
        record(orphan.pid!, { ownerPid: await deadPid(), ownerStartedAt: 1_000 }),
      );
      const report = await ledger.reapStale();
      assert.equal(report.reaped.length, 1, `expected a reap, got ${JSON.stringify(report)}`);
      assert.equal(report.reaped[0]!.pid, orphan.pid);
      await eventually(() => processGone(orphan.pid!));
      assert.deepEqual(await readChildren(path), []);
    } finally {
      orphan.kill("SIGKILL");
    }
  });

  it("keeps the children of a live owner", async () => {
    const path = await tempLedgerPath();
    const ledger = new ChildLedger(path);
    const child = spawnIdle();
    try {
      // The owner on record is this very test process — alive, with a matching start time.
      await ledger.record(record(child.pid!));
      const report = await ledger.reapStale();
      assert.equal(report.reaped.length, 0);
      assert.equal(report.kept, 1);
      assert.ok(!processGone(child.pid!), "the live owner's child must not be touched");
      assert.equal((await readChildren(path)).length, 1);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("never kills a pid whose image no longer matches the record (pid reuse)", async () => {
    const path = await tempLedgerPath();
    const ledger = new ChildLedger(path);
    const bystander = spawnIdle();
    try {
      await ledger.record(
        record(bystander.pid!, {
          image: "somebody-else.exe",
          ownerPid: await deadPid(),
          ownerStartedAt: 1_000,
        }),
      );
      const report = await ledger.reapStale();
      assert.equal(report.reaped.length, 0);
      assert.equal(report.cleared, 1, "the stale record is dropped without a kill");
      assert.ok(!processGone(bystander.pid!), "a reused pid must never be killed");
      assert.deepEqual(await readChildren(path), []);
    } finally {
      bystander.kill("SIGKILL");
    }
  });

  it("treats an owner pid with the wrong start time as dead (pid reuse)", async () => {
    const path = await tempLedgerPath();
    const killed: number[] = [];
    const now = Date.now();
    const fakeProbe = async (pids: number[]): Promise<Map<number, ProcessInfo>> =>
      new Map(pids.map((pid) => [pid, { pid, image: nodeImage, startedAt: now }]));
    const ledger = new ChildLedger(path, {
      probe: fakeProbe,
      kill: async (pid) => {
        killed.push(pid);
      },
    });
    // The "owner" probes alive at pid 4242 but started now; the record claims it started at
    // epoch 5000 — a different process wearing a recycled pid. Its child is an orphan.
    await ledger.record(
      record(1234, { ownerPid: 4242, ownerStartedAt: 5_000, recordedAt: now }),
    );
    const report = await ledger.reapStale();
    assert.deepEqual(killed, [1234]);
    assert.equal(report.reaped.length, 1);
  });

  it("reaps nothing when the probe itself fails", async () => {
    const path = await tempLedgerPath();
    const ledger = new ChildLedger(path, {
      probe: async () => {
        throw new Error("wmi is down");
      },
      kill: async () => {
        assert.fail("must not kill on a failed probe");
      },
    });
    await ledger.record(record(1234, { ownerPid: 999_999 }));
    const report = await ledger.reapStale();
    assert.match(report.skipped ?? "", /wmi is down/);
    assert.equal(report.kept, 1);
    assert.equal((await readChildren(path)).length, 1, "a skipped sweep leaves the file alone");
  });

  it("platformProbe reports this process with a plausible image and start time", async () => {
    const probed = await platformProbe([process.pid]);
    const me = probed.get(process.pid);
    assert.ok(me, "the probe must find the probing process itself");
    assert.ok(me.image.includes(nodeImage.replace(/\.exe$/, "")), `image was ${me.image}`);
    if (me.startedAt !== null) {
      const expected = Date.now() - process.uptime() * 1000;
      assert.ok(
        Math.abs(me.startedAt - expected) < 15_000,
        `start ${me.startedAt} vs expected ${expected}`,
      );
    }
  });

  it("survives a corrupt ledger file", async () => {
    const dir = await tempDir("arke-ledger-");
    const path = join(dir, "children.json");
    const { atomicWriteFile } = await import("../src/world/atomic.js");
    await atomicWriteFile(path, "{ not json");
    const ledger = new ChildLedger(path);
    assert.deepEqual(await ledger.reapStale(), { reaped: [], kept: 0, cleared: 0 });
    await ledger.record(record(1111));
    assert.equal((await readChildren(path)).length, 1);
  });
});
