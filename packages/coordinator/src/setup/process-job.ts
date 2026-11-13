import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { leashOwnedCommandToParent, leashStorageReaderToParent } from "../job-leash.js";

export interface SetupProcessJob {
  bind(pid: number, signal: AbortSignal): Promise<void>;
  active(pid: number, signal: AbortSignal): Promise<number>;
  terminate(pid: number, signal: AbortSignal): Promise<void>;
}
// Private job names are capabilities passed only to fixed native code. Query basic accounting
// is 48 bytes; ActiveProcesses is the DWORD at offset 40. No command/path/log enters this port.
// https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
const JOB_CONTROL = String.raw`
$ErrorActionPreference = 'Stop'
[void][Console]::In.ReadLine()
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ArkeCommandJob')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $asm.DefineDynamicModule('ArkeCommandJobModule', $false).DefineType('ArkeCommandJob', 'Public, Class')
$ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$fields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
foreach ($sig in @(
  @('OpenJobObjectW', [IntPtr], @([uint32], [bool], [string])),
  @('QueryInformationJobObject', [bool], @([IntPtr], [int], [IntPtr], [uint32], [IntPtr])),
  @('TerminateJobObject', [bool], @([IntPtr], [uint32])),
  @('CloseHandle', [bool], @([IntPtr]))
)) {
  $m = $type.DefineMethod($sig[0], 'Public, Static, PinvokeImpl', $sig[1], $sig[2])
  $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor, @('kernel32.dll'), $fields, @($true, [Runtime.InteropServices.CharSet]::Unicode))))
}
$k = $type.CreateType(); $job = [IntPtr]::Zero; $info = [IntPtr]::Zero
try {
  $access = if ($env:ARKE_COMMAND_OPERATION -eq 'terminate') { 12 } else { 4 }
  $job = $k::OpenJobObjectW($access, $false, $env:ARKE_COMMAND_JOB)
  if ($job -eq [IntPtr]::Zero) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($env:ARKE_COMMAND_OPERATION -eq 'inspect' -and $code -eq 2) { [Console]::Out.WriteLine('missing'); return }
    throw 'job unavailable'
  }
  if ($env:ARKE_COMMAND_OPERATION -eq 'terminate' -and -not $k::TerminateJobObject($job, 1)) { throw 'termination unavailable' }
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
  if (-not $k::QueryInformationJobObject($job, 1, $info, 48, [IntPtr]::Zero)) { throw 'query unavailable' }
  [Console]::Out.WriteLine([Runtime.InteropServices.Marshal]::ReadInt32($info, 40))
} finally {
  if ($info -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
  if ($job -ne [IntPtr]::Zero) { [void]$k::CloseHandle($job) }
}
`;
const encoded = Buffer.from(JOB_CONTROL, "utf16le").toString("base64");
async function collect(command: string, args: readonly string[], signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  let leashed: Promise<unknown> = Promise.resolve(); const closed = new AbortController();
  const result = new Promise<string>((resolve, reject) => {
    let failed = false, output = "";
    const child = execFile(command, [...args], { signal, timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8", ...(env ? { env } : {}) },
      (error, stdout) => { failed = error !== null; output = stdout; });
    child.stdin?.on("error", () => {});
    if (process.platform === "win32") leashed = (async () => {
      const leash = child.pid ? await leashStorageReaderToParent(child.pid, process.pid, AbortSignal.any([signal, closed.signal])) : { ok: false };
      if (leash.ok && !signal.aborted && live(child)) child.stdin?.end("\n"); else child.kill("SIGKILL");
    })().catch(() => { child.kill("SIGKILL"); });
    child.once("close", () => { closed.abort(); failed ? reject(new Error("Setup process ownership could not be measured.")) : resolve(output); });
  });
  try { return await result; } finally { await leashed; }
}
const live = (child: { exitCode: number | null; signalCode: NodeJS.Signals | null }) => child.exitCode === null && child.signalCode === null;

async function windowsJob(name: string, operation: "query" | "terminate" | "inspect", signal: AbortSignal): Promise<number | null> {
  if (!/^(Local|Global)\\ArkeOwnedCommand-[a-f0-9]{64}$/.test(name)) throw new Error("Invalid native command identity.");
  const output = (await collect(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], signal,
    { ...process.env, ARKE_COMMAND_JOB: name, ARKE_COMMAND_OPERATION: operation })).trim();
  if (operation === "inspect" && output === "missing") return null;
  const count = Number(output);
  if (!/^\d+$/.test(output) || !Number.isSafeInteger(count) || count < 0) throw new Error("Setup process ownership is unavailable.");
  return count;
}

/** Read only: never create a missing job or terminate a process. Global identity is required
 * so a different Windows login session cannot misread a live session-local job as absent.
 * Windows destroys a job only after its handles close and associated processes terminate:
 * https://learn.microsoft.com/windows/win32/procthread/job-objects#managing-job-objects */
export async function inspectOwnedCommandJob(name: string, signal: AbortSignal): Promise<number | null> {
  if (process.platform !== "win32" || !/^Global\\ArkeOwnedCommand-[a-f0-9]{64}$/.test(name)) throw new Error("Native command reconciliation is unavailable.");
  return windowsJob(name, "inspect", signal);
}

/** The anchor stays alive while an ordinary POSIX helper can run. On Windows, the private
 * kernel job remains a stable identity even if that anchor unexpectedly exits. */
export class NativeSetupProcessJob implements SetupProcessJob {
  readonly identity: string;
  constructor(scope: "local" | "global" = "local") {
    this.identity = `${scope === "global" ? "Global" : "Local"}\\ArkeOwnedCommand-${randomBytes(32).toString("hex")}`;
  }
  async bind(pid: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (process.platform === "win32") {
      if (!(await leashOwnedCommandToParent(pid, this.identity, signal)).ok) throw new Error("Setup could not establish native process ownership.");
    }
  }
  private async windows(operation: "query" | "terminate", signal: AbortSignal): Promise<number> {
    const count = await windowsJob(this.identity, operation, signal);
    if (count === null) throw new Error("Setup process ownership is unavailable.");
    return count;
  }
  async active(pid: number, signal: AbortSignal): Promise<number> {
    if (process.platform === "win32") return this.windows("query", signal);
    const output = await collect("/bin/ps", ["-e", "-o", "pid=,pgid=,stat="], signal);
    const rows = output.trim().split(/\r?\n/).filter(Boolean);
    let count = 0;
    for (const row of rows) {
      const fields = row.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!fields) throw new Error("Setup process ownership is unavailable.");
      // Zombies have already exited and hold no executable process/file descriptors.
      if (Number(fields[2]) === pid && !fields[3]!.startsWith("Z")) count++;
    }
    return count;
  }
  async terminate(pid: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (process.platform === "win32") { await this.windows("terminate", signal); return; }
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Setup process exit could not be confirmed."); }
  }
}
