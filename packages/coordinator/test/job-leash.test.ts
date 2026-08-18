import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helperBudgetMs, leashChildToParent, statedFailure } from "../src/job-leash.js";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "fixtures", "leash-host.ts");
const pkgRoot = resolve(here, "..");

const onWindows = process.platform === "win32";

// The leash gives its helper a generous budget and retries once, so the worst legitimate wait
// is two attempts plus the time tsx needs to boot the host. Deriving the deadlines from that
// keeps a loaded machine slow rather than red — the failure this test used to produce itself.
// Read from the module rather than copied, so an ARKE_LEASH_TIMEOUT_MS override moves this
// deadline with it instead of failing the test for outrunning a stale constant.
const LEASH_CEILING_MS = 2 * helperBudgetMs() + 30_000;

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
    { skip: !onWindows, timeout: LEASH_CEILING_MS + 60_000 },
    async () => {
      // The host process plays the coordinator: spawn, leash, idle. tsx resolves its TS import.
      const host = spawn(process.execPath, ["--import", "tsx", HOST], {
        cwd: pkgRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      host.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      let childPid: number | undefined;
      try {
        childPid = await new Promise<number>((resolvePid, reject) => {
          let out = "";
          const timer = setTimeout(
            () => reject(new Error(`host never leashed; stderr: ${stderr.trim()}`)),
            LEASH_CEILING_MS,
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

        const pid = childPid;
        assert.ok(!processGone(pid), "the leashed child starts out alive");
        // TerminateProcess: the host runs no exit hooks, exactly like Stop-Process on the app.
        host.kill("SIGKILL");
        await eventually(() => processGone(pid));
      } finally {
        // A live host holds the runner's event loop open, so it has to die on every path out
        // of here — including the one where it never leashed and the await above threw. That
        // gap is why a failure here used to hang the run instead of reporting.
        if (childPid !== undefined && !processGone(childPid)) {
          spawn("taskkill", ["/pid", String(childPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        }
        // Kill the tree, not just the host: when the host never reported a pid there is
        // nothing for the branch above to target, and the child it had already spawned is
        // unleashed by definition. SIGKILL alone would leave exactly the orphan this file
        // exists to rule out.
        if (host.pid !== undefined) {
          spawn("taskkill", ["/pid", String(host.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        }
        host.kill("SIGKILL");
      }
    },
  );

  it("states its reason when the child does not exist", { skip: !onWindows, timeout: 60_000 }, async () => {
    // Near the top of the pid space and even — valid form, never a live process in practice.
    const result = await leashChildToParent(0x7ffffffc);
    assert.equal(result.ok, false);
    // The failing call and its Win32 code, not a serialization marker: a reason nobody can
    // read is the same as no reason at all.
    assert.match(result.reason ?? "", /OpenProcess\(child\) failed \(Win32 error \d+\)/);
    assert.doesNotMatch(result.reason ?? "", /CLIXML/);
  });

  it("declines off Windows rather than pretending", { skip: onWindows }, async () => {
    const result = await leashChildToParent(1234);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Windows/);
  });
});

describe("job leash failure reasons", () => {
  // Shapes captured from powershell.exe itself, not invented: PowerShell frames stderr as
  // CLIXML while it is serializing its own streams, and the sentence is never on line one.
  it("reads the helper's own line out of the CLIXML framing around it", () => {
    // Verbatim shape of a real failing helper run: the preamble, then the helper's plain
    // text, then a payload carrying only a progress record. Reporting line one here is the
    // bug in issue 234 — it surfaced as "helper exited on timeout: #< CLIXML".
    const framed =
      "#< CLIXML\r\nOpenProcess(child) failed (Win32 error 87)\r\n" +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
      '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record">' +
      "<AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC>" +
      "<T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>";
    assert.equal(statedFailure(framed), "OpenProcess(child) failed (Win32 error 87)");
  });

  it("reads the message out of a serialized ErrorRecord", () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj>' +
      '<Obj S="Error" RefId="1"><TN RefId="1"><T>System.Management.Automation.ErrorRecord</T><T>System.Object</T></TN>' +
      "<ToString>OpenProcess(child) failed (Win32 error 87)</ToString>" +
      '<MS><B N="writeErrorStream">true</B></MS></Obj></Objs>';
    // The progress record comes first in the payload and is not the error.
    assert.equal(statedFailure(clixml), "OpenProcess(child) failed (Win32 error 87)");
  });

  it("decodes the escapes CLIXML wraps a message in", () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="Error" RefId="0"><TN RefId="0"><T>System.Management.Automation.ErrorRecord</T></TN>' +
      "<ToString>AssignProcessToJobObject failed &lt;access denied&gt;_x000D__x000A_    + CategoryInfo : NotSpecified</ToString>" +
      "</Obj></Objs>";
    assert.equal(statedFailure(clixml), "AssignProcessToJobObject failed <access denied>");
  });

  it("does not report the CLIXML marker as the reason when the payload is truncated", () => {
    // Exactly what a killed helper leaves behind, and exactly what used to reach the log.
    const reason = statedFailure("#< CLIXML\r\n");
    assert.doesNotMatch(reason, /^#< CLIXML/);
    assert.match(reason, /did not survive/);
  });

  it("takes the message, not the banner, from plain stderr", () => {
    assert.equal(
      statedFailure("some preamble\r\nCreateJobObject failed (Win32 error 5)\r\n"),
      "CreateJobObject failed (Win32 error 5)",
    );
  });

  it("says nothing when there was nothing on stderr", () => {
    assert.equal(statedFailure("   \r\n  "), "");
  });
});
