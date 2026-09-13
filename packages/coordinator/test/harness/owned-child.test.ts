import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ChildLedger, type ChildRecord, type DescendantInfo, type ProcessInfo } from "../../src/child-ledger.js";
import { ownedChildHooks } from "../../src/harness/owned-child.js";
import { tempDir } from "../tmp.js";

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams;
const exit = (child: ChildProcessWithoutNullStreams, code: number) => {
  Object.defineProperty(child, "exitCode", { value: code, configurable: true });
  child.emit("exit", code, null);
};
const helper: DescendantInfo = { pid: 23456, parentPid: 12345, image: "codex-code-mode-host.exe", startedAt: 1000 };
const readLedger = async (file: string) => (JSON.parse(await readFile(file, "utf8")) as { children: ChildRecord[] }).children;

describe("owned stdio child lifecycle", () => {
  it("tethers the child, records helpers, kills the tree and releases completed records", async () => {
    const path = join(await tempDir("owned-codex-"), "children.json");
    const child = fakeChild(); const killed: number[] = []; const leashed: number[] = [];
    const processes = new Map<number, ProcessInfo>([[helper.pid, helper]]);
    const hooks = ownedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", ledger: new ChildLedger(path), listDescendants: async () => [helper],
      probe: async () => processes,
      leash: async pid => { leashed.push(pid); return { ok: true }; },
      kill: async pid => {
        killed.push(pid); processes.delete(pid);
        if (pid === child.pid) exit(child, 0);
      },
    });
    await hooks.onSpawn(child);
    assert.deepEqual(leashed, [child.pid]);
    assert.deepEqual((await readLedger(path)).map(row => row.pid).sort(), [child.pid, helper.pid]);
    await hooks.killProcess(child);
    assert.deepEqual(killed, [child.pid, helper.pid]);
    assert.deepEqual(await readLedger(path), []);
    await hooks.killProcess(child);
    assert.equal(killed.length, 2, "cleanup is idempotent after an exit race");
  });

  it("retains records without killing a helper pid whose process identity changed", async () => {
    const path = join(await tempDir("owned-codex-reuse-"), "children.json");
    const child = fakeChild(); const killed: number[] = [];
    const hooks = ownedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", ledger: new ChildLedger(path), listDescendants: async () => [helper],
      probe: async () => new Map([[helper.pid, { ...helper, startedAt: 20_000 }]]),
      leash: async () => ({ ok: true }),
      kill: async pid => { killed.push(pid); exit(child, 0); },
    });
    await hooks.onSpawn(child); await hooks.killProcess(child);
    assert.deepEqual(killed, [child.pid]);
    assert.deepEqual((await readLedger(path)).map(row => row.pid), [helper.pid]);
  });

  it("adopts a helper created later and reaps it after unexpected app-server exit", async () => {
    const path = join(await tempDir("owned-codex-later-"), "children.json");
    const child = fakeChild(); let scans = 0;
    let adopted!: () => void; const foundLater = new Promise<void>(resolve => { adopted = resolve; });
    const killed: number[] = [];
    const hooks = ownedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", snapshotMs: 5, ledger: new ChildLedger(path),
      listDescendants: async () => { if (++scans === 1) return []; adopted(); return [helper]; },
      probe: async () => new Map([[helper.pid, helper]]), leash: async () => ({ ok: true }),
      kill: async pid => { killed.push(pid); },
    });
    await hooks.onSpawn(child);
    // The periodic ownership timer is intentionally unref'ed; this awaited bounded guard is
    // what keeps the hermetic test alive while the fake process has no OS handle.
    const timer = setTimeout(() => adopted(), 500);
    await foundLater; clearTimeout(timer);
    assert.ok(scans > 1);
    exit(child, 1);
    await hooks.killProcess(child);
    assert.deepEqual(killed, [helper.pid]);
    assert.deepEqual(await readLedger(path), []);
  });
});
