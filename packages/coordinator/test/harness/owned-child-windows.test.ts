import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ChildLedger, killTree, type ChildRecord } from "../../src/child-ledger.js";
import { ownedChildHooks } from "../../src/harness/owned-child.js";
import { tempDir } from "../tmp.js";
import { untilAsync } from "../wait.js";

it("reaps a real late Windows helper after its parent exits between snapshots and the leash failed",
  { skip: process.platform !== "win32", timeout: 60_000 }, async t => {
    const path = join(await tempDir("owned-codex-late-windows-"), "children.json");
    const source = `
      const { spawn } = require('node:child_process');
      process.stdin.once('data', () => {
        const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        helper.once('spawn', () => process.stdout.write(JSON.stringify({ helper: helper.pid }) + '\\n', () => process.exit(0)));
      });
    `;
    const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let helperPid: number | undefined;
    let out = ""; let err = "";
    child.stdout.on("data", chunk => {
      out += chunk.toString();
      try { helperPid = (JSON.parse(out) as { helper: number }).helper; } catch { /* waiting for the complete frame */ }
    });
    child.stderr.on("data", chunk => { err += chunk.toString(); });
    const traces: string[] = [];
    const hooks = ownedChildHooks("codex", process.execPath, {
      ledger: new ChildLedger(path), leash: async () => ({ ok: false }), snapshotMs: 60_000,
    }, line => { traces.push(String(line.at)); });
    const stopped = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    t.after(async () => {
      await hooks.killProcess(child);
      if (child.pid && !stopped(child.pid)) await killTree(child.pid);
      if (helperPid && !stopped(helperPid)) await killTree(helperPid);
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    await hooks.onSpawn(child);
    assert.ok(traces.includes("harness.child-leash-failed"));
    const before = JSON.parse(await readFile(path, "utf8")) as { children: ChildRecord[] };
    assert.ok(before.children.some(row => row.pid === child.pid));
    assert.equal(helperPid, undefined, "the initial snapshot precedes the controlled helper's creation");

    child.stdin.end("create helper and exit");
    const [code] = await closed;
    assert.equal(code, 0, err);
    assert.ok(Number.isSafeInteger(helperPid) && helperPid! > 0, out);
    assert.ok(!before.children.some(row => row.pid === helperPid), "the helper was not in the initial snapshot");
    await hooks.killProcess(child);
    await untilAsync(async () => stopped(helperPid!), "the final snapshot reaps the helper behind a dead root", 10_000);
    const after = JSON.parse(await readFile(path, "utf8")) as { children: ChildRecord[] };
    assert.deepEqual(after.children, []);
  });
