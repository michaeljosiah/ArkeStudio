import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WINDOWS_FILES_BOOTSTRAP, WINDOWS_FILES_SOURCE } from "../src/windows-files.js";

test("Windows helper preserves JSON prefetched with source and UTF-8 across pipe buffers", { skip: process.platform !== "win32", timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "arke-pipe-日本-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_FILES_BOOTSTRAP, "utf16le").toString("base64")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { SystemRoot: process.env["SystemRoot"], WINDIR: process.env["WINDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"], PATH: dirname(command) },
  });
  const frames: Record<string, unknown>[] = [];
  let buffer = ""; let malformed = false; let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { frames.push(JSON.parse(line) as Record<string, unknown>); } catch { malformed = true; }
    }
  });
  child.stderr.resume(); child.stdin.on("error", () => {});
  const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 35_000);
  t.after(async () => { clearTimeout(deadline); child.kill(); await ended.catch(() => {}); });
  const path = join(root, "café-日本.txt"); const content = "héllo 日本\n".repeat(32768);
  // A single write deliberately allows the source reader to prefetch request bytes.
  // Replacing Console.In after reading source loses those bytes on .NET Framework.
  child.stdin.end([
    Buffer.from(WINDOWS_FILES_SOURCE, "utf8").toString("base64"),
    JSON.stringify({ op: "pin", path: root }),
    JSON.stringify({ op: "write", path, data: Buffer.from(content).toString("base64") }),
    JSON.stringify({ op: "read", path, limit: 16 * 1024 * 1024 }),
  ].join("\n") + "\n");
  assert.equal(await ended, 0);
  assert.equal(timedOut, false);
  assert.equal(malformed, false);
  assert.deepEqual(frames.filter(frame => frame.startup).map(frame => frame.startup), ["bootstrap", "transport", "source", "parsed", "entered", "assembly", "emitting", "native", "utility"]);
  assert.equal(frames.some(frame => frame.ready === true), true);
  assert.equal(frames.some(frame => frame.error || frame.startupError), false);
  const results = frames.filter(frame => frame.result).map(frame => frame.result as Record<string, unknown>);
  assert.equal(results.length, 3);
  assert.equal(Buffer.from(String(results[2]!.data), "base64").toString("utf8"), content);
  assert.equal(await readFile(path, "utf8"), content);
});
