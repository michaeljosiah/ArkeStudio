import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { leashChildToParent } from "../src/job-leash.js";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "fixtures", "leash-host.ts");
const pkgRoot = resolve(here, "..");

const onWindows = process.platform === "win32";

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(check(), "condition not met in time");
}

describe("job leash", () => {
  it(
    "the kernel kills a leashed child when its parent is force-killed (R-5)",
    { skip: !onWindows, timeout: 60_000 },
    async () => {
      // The host process plays the coordinator: spawn, leash, idle. tsx resolves its TS import.
      const host = spawn(process.execPath, ["--import", "tsx", HOST], {
        cwd: pkgRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      host.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      const childPid = await new Promise<number>((resolvePid, reject) => {
        let out = "";
        const timer = setTimeout(
          () => reject(new Error(`host never leashed; stderr: ${stderr.trim()}`)),
          45_000,
        );
        host.stdout.on("data", (c: Buffer) => {
          out += c.toString();
          const m = /leashed (\d+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolvePid(Number(m[1]));
          }
        });
        host.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`host exited early (${code}); stderr: ${stderr.trim()}`));
        });
      });

      try {
        assert.ok(!processGone(childPid), "the leashed child starts out alive");
        // TerminateProcess: the host runs no exit hooks, exactly like Stop-Process on the app.
        host.kill("SIGKILL");
        await eventually(() => processGone(childPid));
      } finally {
        // Belt and braces if the assertion above ever fails.
        if (!processGone(childPid)) {
          spawn("taskkill", ["/pid", String(childPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        }
        host.kill("SIGKILL");
      }
    },
  );

  it("states its reason when the child does not exist", { skip: !onWindows, timeout: 60_000 }, async () => {
    // Near the top of the pid space and even — valid form, never a live process in practice.
    const result = await leashChildToParent(0x7ffffffc);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /OpenProcess|helper exited/);
  });

  it("declines off Windows rather than pretending", { skip: onWindows }, async () => {
    const result = await leashChildToParent(1234);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Windows/);
  });
});
