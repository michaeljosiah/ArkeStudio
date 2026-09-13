import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ChildLedger, killTree, type ChildRecord, type DescendantInfo, type ProcessInfo } from "../../src/child-ledger.js";
import { ownedChildHooks } from "../../src/harness/owned-child.js";
import { tempDir } from "../tmp.js";
import { untilAsync } from "../wait.js";

const fakeExitBackstops = new Set<() => void>();
const fakeOwnedChildHooks = (
  id: string, command: string, deps: Parameters<typeof ownedChildHooks>[2], trace?: Parameters<typeof ownedChildHooks>[3],
) => ownedChildHooks(id, command, { ...deps, registerExitBackstop: callback => {
  fakeExitBackstops.add(callback);
  return () => { fakeExitBackstops.delete(callback); };
} }, trace);

const processStopped = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return true; }
  if (process.platform === "win32") return false;
  // Minimal Linux containers do not always reap adopted zombies. They are already dead;
  // counting an unreaped corpse as a live helper would misdiagnose the group-kill result.
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  return (status.stdout?.trim() ?? "").startsWith("Z");
};

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
    const hooks = fakeOwnedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", ledger: new ChildLedger(path), listDescendants: async () => [helper],
      probe: async () => processes,
      leash: async pid => { leashed.push(pid); return { ok: true }; },
      kill: async pid => {
        killed.push(pid); processes.delete(pid);
        if (pid === child.pid) exit(child, 0);
      },
    });
    const before = fakeExitBackstops.size;
    await hooks.onSpawn(child);
    assert.equal(fakeExitBackstops.size, before + 1);
    assert.deepEqual(leashed, [child.pid]);
    assert.deepEqual((await readLedger(path)).map(row => row.pid).sort(), [child.pid, helper.pid]);
    await hooks.killProcess(child);
    assert.equal(fakeExitBackstops.size, before, "normal disposal removes its abrupt-exit callback");
    assert.deepEqual(killed, [child.pid, helper.pid]);
    assert.deepEqual(await readLedger(path), []);
    await hooks.killProcess(child);
    assert.equal(killed.length, 2, "cleanup is idempotent after an exit race");
  });

  for (const mode of ["ready", "during-spawn", ...(process.platform === "win32" ? ["orphan"] : [])]) {
    it(`kills its real child and helper when the host exits abruptly (${mode})`, { timeout: 90_000 }, async t => {
      const host = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/owned-host.mjs", import.meta.url)), mode],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = ""; let err = "";
      let pids: { root: number; helper: number } | undefined;
      host.stdout.on("data", chunk => {
        out += chunk.toString();
        try { pids = JSON.parse(out) as { root: number; helper: number }; } catch { /* waiting for the rest of the frame */ }
      });
      host.stderr.on("data", chunk => { err += chunk.toString(); });
      t.after(async () => {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        if (pids) for (const pid of [pids.root, pids.helper]) {
          if (!processStopped(pid)) await killTree(pid);
        }
      });
      const code = await new Promise<number | null>((resolve, reject) => { host.once("error", reject); host.once("exit", resolve); });
      assert.equal(code, 17, err);
      pids = JSON.parse(out) as { root: number; helper: number };
      await untilAsync(async () => processStopped(pids!.root) && processStopped(pids!.helper), "abrupt host exit kills app-server and helper", 30_000);
    });
  }

  it("retains records without killing a helper pid whose process identity changed", async () => {
    const path = join(await tempDir("owned-codex-reuse-"), "children.json");
    const child = fakeChild(); const killed: number[] = [];
    const hooks = fakeOwnedChildHooks("codex", "/bin/codex.exe", {
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
    const killed: number[] = [];
    const processes = new Map<number, ProcessInfo>([[helper.pid, helper]]);
    const hooks = fakeOwnedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", snapshotMs: 5, ledger: new ChildLedger(path),
      listDescendants: async () => ++scans === 1 ? [] : [helper],
      probe: async () => processes, leash: async () => ({ ok: true }),
      kill: async pid => { killed.push(pid); processes.delete(pid); },
    });
    await hooks.onSpawn(child);
    await untilAsync(async () => (await readLedger(path)).some(row => row.pid === helper.pid), "helper ownership recorded");
    assert.ok(scans > 1);
    exit(child, 1);
    await hooks.killProcess(child);
    assert.deepEqual(killed, [helper.pid]);
    assert.deepEqual(await readLedger(path), []);
  });

  for (const rejectKill of [false, true]) it(`retains a helper's ownership when its kill ${rejectKill ? "rejects" : "returns without stopping it"}`, async () => {
    const path = join(await tempDir("owned-codex-kill-refused-"), "children.json");
    const child = fakeChild(); const killed: number[] = [];
    const processes = new Map<number, ProcessInfo>([[helper.pid, helper]]);
    let directKills = 0;
    Object.assign(child, { kill: () => { directKills++; exit(child, 0); return true; } });
    const hooks = fakeOwnedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", ledger: new ChildLedger(path), listDescendants: async () => [helper],
      probe: async () => processes, leash: async () => ({ ok: true }),
      kill: async pid => { killed.push(pid); if (rejectKill) throw new Error("Process inspection timed out."); },
    });
    await hooks.onSpawn(child); await hooks.killProcess(child);
    assert.equal(directKills, 1, "a failed tree kill still stops the owned root process");
    assert.deepEqual(killed, [child.pid, helper.pid]);
    assert.deepEqual((await readLedger(path)).map(row => row.pid), [helper.pid]);
  });

  it("bounds initial inspection and rejects a late result after shutdown", async () => {
    const path = join(await tempDir("owned-codex-timeout-"), "children.json");
    const child = fakeChild(); const killed: number[] = [];
    let finishScan!: (rows: DescendantInfo[]) => void;
    let scanSignal: AbortSignal | undefined;
    const traces: string[] = [];
    const hooks = fakeOwnedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", ledger: new ChildLedger(path), snapshotTimeoutMs: 20,
      listDescendants: (_pid, signal) => { scanSignal = signal; return new Promise(resolve => { finishScan = resolve; }); },
      leash: async () => ({ ok: true }), kill: async pid => { killed.push(pid); exit(child, 0); },
    }, line => { traces.push(String(line.at)); });
    await hooks.onSpawn(child);
    assert.equal(scanSignal?.aborted, true);
    assert.ok(traces.includes("harness.descendant-snapshot-failed"));
    await hooks.killProcess(child);
    finishScan([helper]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(killed, [child.pid]);
    assert.deepEqual(await readLedger(path), []);
  });

  it("cancels an active inspection before killing without waiting for its deadline", async () => {
    const path = join(await tempDir("owned-codex-stop-scan-"), "children.json");
    const child = fakeChild(); const killed: number[] = [];
    let finishScan!: (rows: DescendantInfo[]) => void;
    let scanSignal: AbortSignal | undefined;
    const hooks = fakeOwnedChildHooks("codex", "/bin/codex.exe", {
      platform: "win32", ledger: new ChildLedger(path), snapshotTimeoutMs: 30_000,
      listDescendants: (_pid, signal) => { scanSignal = signal; return new Promise(resolve => { finishScan = resolve; }); },
      leash: async () => ({ ok: true }), kill: async pid => { killed.push(pid); exit(child, 0); },
    });
    const startup = hooks.onSpawn(child);
    await untilAsync(async () => scanSignal !== undefined, "initial inspection started");
    await hooks.killProcess(child);
    await startup;
    assert.equal(scanSignal?.aborted, true);
    finishScan([helper]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(killed, [child.pid]);
    assert.deepEqual(await readLedger(path), []);
  });
});
