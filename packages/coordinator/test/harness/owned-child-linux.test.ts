import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, link, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { ChildLedger, platformProbe, type ChildRecord } from "../../src/child-ledger.js";
import { tempDir } from "../tmp.js";
import { untilAsync } from "../wait.js";

for (const name of ["codex-app-server", "12345678901234猫-codex"]) {
  it(`reaps the full Linux executable identity ${name} after an uncatchable host exit`, { skip: process.platform !== "linux", timeout: 30_000 }, async t => {
    const base = await tempDir("owned-codex-linux-identity-");
    const command = join(base, name); const path = join(base, "children.json");
    await link(process.execPath, command).catch(() => copyFile(process.execPath, command));
    const host = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/owned-ledger-host.mjs", import.meta.url)), command, path],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = ""; let pid: number | undefined; let helperPid: number | undefined; let ready = false;
    host.stdout.on("data", chunk => {
      output += chunk.toString();
      for (;;) {
        const end = output.indexOf("\n"); if (end < 0) break;
        const evidence = JSON.parse(output.slice(0, end)) as { pid: number; helper?: number; ready?: boolean };
        output = output.slice(end + 1); pid = evidence.pid;
        helperPid ??= evidence.helper; ready ||= evidence.ready === true;
      }
    });
    host.stderr.resume();
    const ended = once(host, "exit"); void ended.catch(() => {});
    t.after(async () => {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await ended.catch(() => {});
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
    });
    await untilAsync(async () => ready, "owned executable ledger has been flushed", 10_000);
    const rows = (JSON.parse(await readFile(path, "utf8")) as { children: ChildRecord[] }).children;
    assert.equal(rows[0]?.imageKind, "executable");
    assert.equal(rows[0]?.processGroupLeader, true);
    assert.equal(rows[0]?.image, name);
    assert.equal((await platformProbe([pid!])).get(pid!)?.executableImage, name);
    host.kill("SIGKILL"); await ended;
    const report = await new ChildLedger(path).reapStale();
    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0]?.pid, pid);
    assert.deepEqual((JSON.parse(await readFile(path, "utf8")) as { children: ChildRecord[] }).children, []);
    const stopped = async (target: number) => {
      try {
        const stat = await readFile(`/proc/${target}/stat`, "utf8");
        return /^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
      } catch { return true; }
    };
    assert.ok(helperPid);
    await untilAsync(async () => await stopped(pid!) && await stopped(helperPid!), "the long-named orphan and its group helper have stopped", 5000);
  });
}
