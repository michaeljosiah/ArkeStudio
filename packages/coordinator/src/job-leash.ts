import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * Windows child-lifetime leash (SPEC-001 R-5: never leave an orphan).
 *
 * Graceful stops already taskkill the child tree, but a force-killed parent (Stop-Process,
 * SIGKILL, a dev-server restart) runs no exit hooks, and supervised children were left
 * accumulating. The kernel closes a dead process's handles no matter how it died, so the fix
 * is to make child lifetime a handle the parent holds: a Job Object with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE whose only handle lives in the parent process.
 *
 * A short-lived PowerShell helper (inline source, no script file to ship, no native module
 * to rebuild) creates the job, assigns the child to it, duplicates the job handle into the
 * parent, and exits. From then on the parent's death — any death — closes the handle, and
 * the kernel kills the child and every descendant it spawned. The helper is best-effort:
 * when it cannot run (PowerShell blocked, child already gone) the ledger sweep at next
 * startup is the fallback.
 */

// All Win32 work happens in one Add-Type static method so PowerShell itself only marshals
// two integers. Constants: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000,
// JobObjectExtendedLimitInformation = 9, PROCESS_SET_QUOTA|PROCESS_TERMINATE = 0x0101,
// PROCESS_DUP_HANDLE = 0x0040, DUPLICATE_SAME_ACCESS = 2.
const HELPER_SOURCE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ArkeLeash {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static void Fail(string what) { throw new Exception(what + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")"); }
  public static void Bind(int ownerPid, int childPid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) Fail("CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) Fail("SetInformationJobObject");
    IntPtr child = OpenProcess(0x0101, false, childPid);
    if (child == IntPtr.Zero) Fail("OpenProcess(child)");
    if (!AssignProcessToJobObject(job, child)) Fail("AssignProcessToJobObject");
    IntPtr owner = OpenProcess(0x0040, false, ownerPid);
    if (owner == IntPtr.Zero) Fail("OpenProcess(owner)");
    IntPtr dup;
    if (!DuplicateHandle(GetCurrentProcess(), job, owner, out dup, 0, false, 2)) Fail("DuplicateHandle");
  }
}
'@
[ArkeLeash]::Bind([int]$env:ARKE_LEASH_OWNER_PID, [int]$env:ARKE_LEASH_CHILD_PID)
Write-Output 'leashed'
`;

// The helper never varies, so its -EncodedCommand form (UTF-16LE base64, per PowerShell's
// contract) is computed once. PIDs travel as env vars, keeping the command constant.
const HELPER_ENCODED = Buffer.from(HELPER_SOURCE, "utf16le").toString("base64");

function powershellPath(): string {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export interface LeashResult {
  ok: boolean;
  /** Stated cause on failure — surfaced once by the supervisor, never thrown. */
  reason?: string;
}

/**
 * Tie `childPid`'s lifetime (and its descendants') to `ownerPid` — kernel-enforced, so it
 * holds even when the owner is force-killed. Windows only; elsewhere resolves `ok: false`.
 */
export async function leashChildToParent(
  childPid: number,
  ownerPid: number = process.pid,
): Promise<LeashResult> {
  if (process.platform !== "win32") {
    return { ok: false, reason: "job objects are Windows-only" };
  }
  return new Promise<LeashResult>((resolve) => {
    let helper: ChildProcess;
    try {
      helper = spawn(
        powershellPath(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", HELPER_ENCODED],
        {
          env: {
            ...process.env,
            ARKE_LEASH_OWNER_PID: String(ownerPid),
            ARKE_LEASH_CHILD_PID: String(childPid),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (err) {
      resolve({ ok: false, reason: String(err) });
      return;
    }
    let out = "";
    let errOut = "";
    helper.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    helper.stderr?.on("data", (chunk: Buffer) => (errOut += chunk.toString()));
    // Add-Type compiles on first use (~1s); anything past 20s means PowerShell is wedged.
    const timer = setTimeout(() => {
      try {
        helper.kill();
      } catch {
        /* already gone */
      }
    }, 20_000);
    helper.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: String(err) });
    });
    helper.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.includes("leashed")) {
        resolve({ ok: true });
      } else {
        const detail = errOut.trim().split(/\r?\n/, 1)[0] ?? "";
        resolve({ ok: false, reason: `helper exited ${code ?? "on timeout"}${detail ? `: ${detail}` : ""}` });
      }
    });
  });
}
