import test from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { discoverCodex, meetsCodexFloor, codexServerArgs, runCodexDiscoveryCommand } from "../src/discovery.js";

test("Codex floor refuses unverified older and prerelease protocol versions", () => {
  assert.equal(meetsCodexFloor("0.144.0"), false); assert.equal(meetsCodexFloor("0.154.0"), true);
  assert.equal(meetsCodexFloor("0.155.0"), true); assert.equal(meetsCodexFloor("0.154.0-beta"), false);
  assert.equal(meetsCodexFloor(null), false);
});
test("discovery requires a runnable sibling helper and distinguishes standalone executable", async () => {
  const command = process.platform === "win32" ? "C:\\Codex\\codex-app-server.exe" : "/opt/codex/codex-app-server";
  const runCommand = async (path: string, args: string[]) => ({ status: 0, stdout: args[0] === "--version" ? "codex-app-server 0.154.0\n" : basename(path).startsWith("codex-code-mode-host") ? "Usage: codex-code-mode-host --listen" : "" });
  const found = await discoverCodex({ configuredPath: command, runCommand, exists: async () => true });
  assert.equal(found.found?.source, "configured"); assert.deepEqual(found.found?.args, ["--listen", "stdio://"]);
  const missing = await discoverCodex({ configuredPath: command, runCommand, exists: async path => !path.includes("code-mode-host") });
  assert.equal(missing.found, null); assert.match(missing.reason!, /helper/);
  assert.deepEqual(codexServerArgs("codex.exe"), ["app-server", "--listen", "stdio://"]);
});
test("a configured old executable is authoritative even when PATH has another installation", async () => {
  let pathProbed = false;
  const result = await discoverCodex({ configuredPath: "old-codex.exe", exists: async () => true,
    runCommand: async (_path, args) => { if (args[0] !== "--version") pathProbed = true; return { status: 0, stdout: args[0] === "--version" ? "codex 0.144.0" : "new-codex.exe" }; } });
  assert.equal(pathProbed, false); assert.equal(result.found, null); assert.match(result.reason!, /0.144.0/);
});

test("a discovery deadline terminates a real executable even when POSIX SIGTERM is ignored", { timeout: 12_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "arke-codex-discovery-"));
  const pidPath = join(root, "pid"); const ignoredPath = join(root, "ignored");
  let pid: number | undefined;
  const source = `const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(ignoredPath)}, 'ignored')); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdout.write('codex 0.154.0\\n'); setInterval(() => {}, 1000);`;
  const deadlineAt = Date.now() + 5000;
  const pending = runCodexDiscoveryCommand(process.execPath, ["-e", source], 5000);
  t.after(async () => {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await pending;
    await rm(root, { recursive: true, force: true });
  });
  const until = async (condition: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 3000;
    while (!await condition()) { assert.ok(Date.now() < deadline, "expected discovery process transition"); await delay(10); }
  };
  await until(async () => { try { pid = Number(await readFile(pidPath, "utf8")); return Number.isSafeInteger(pid) && pid! > 0; } catch { return false; } });
  if (process.platform !== "win32") {
    process.kill(pid!, "SIGTERM");
    await until(async () => { try { return await readFile(ignoredPath, "utf8") === "ignored"; } catch { return false; } });
    assert.doesNotThrow(() => process.kill(pid!, 0), "the executable really ignored SIGTERM");
  }
  let backstop: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => { backstop = setTimeout(() => reject(new Error("Discovery never settled its deadline.")), Math.max(0, deadlineAt - Date.now()) + 4000); })]);
    assert.deepEqual(result, { status: null, stdout: "" }, "partial version output is not successful discovery");
    await until(() => { try { process.kill(pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
    pid = undefined;
  } finally { clearTimeout(backstop); }
});

test("the native discovery runner retains successful command output", async () => {
  assert.deepEqual(await runCodexDiscoveryCommand(process.execPath, ["-e", "process.stdout.write('codex 0.154.0\\n')"], 5000), { status: 0, stdout: "codex 0.154.0\n" });
});
