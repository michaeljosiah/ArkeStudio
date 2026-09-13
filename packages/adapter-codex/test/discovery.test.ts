import test from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { discoverCodex, meetsCodexFloor, codexServerArgs } from "../src/discovery.js";

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
