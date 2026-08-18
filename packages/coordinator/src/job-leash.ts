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

// The kernel32 surface is emitted in-process with Reflection.Emit rather than declared with
// Add-Type. Add-Type compiles C# at runtime: it spawns csc.exe and cvtres.exe, writes a temp
// assembly and waits for the AV scanner to clear it before loading. That is ~1s on a warm
// machine but unbounded on a loaded one, and it is what used to exhaust the helper's budget
// and drop the leash. Emitting the same P/Invoke signatures spawns no process and touches no
// disk, so the cost is PowerShell's own startup and nothing else.
//
// Constants: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JobObjectExtendedLimitInformation
// = 9, PROCESS_SET_QUOTA|PROCESS_TERMINATE = 0x0101, PROCESS_DUP_HANDLE = 0x0040,
// DUPLICATE_SAME_ACCESS = 2.
const HELPER_SOURCE = `
$ErrorActionPreference = 'Stop'
try {
  $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    (New-Object Reflection.AssemblyName('ArkeLeash')),
    [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $type = $asm.DefineDynamicModule('ArkeLeashModule', $false).DefineType('ArkeLeash', 'Public, Class')
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
  $setLastError = [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')
  foreach ($sig in @(
    @('CreateJobObjectW',         [IntPtr], @([IntPtr], [string])),
    @('SetInformationJobObject',  [bool],   @([IntPtr], [int], [IntPtr], [uint32])),
    @('AssignProcessToJobObject', [bool],   @([IntPtr], [IntPtr])),
    @('OpenProcess',              [IntPtr], @([uint32], [bool], [int])),
    @('DuplicateHandle',          [bool],   @([IntPtr], [IntPtr], [IntPtr], [IntPtr], [uint32], [bool], [uint32])),
    @('GetCurrentProcess',        [IntPtr], @())
  )) {
    $m = $type.DefineMethod($sig[0], 'Public, Static, PinvokeImpl', $sig[1], $sig[2])
    $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder(
      $ctor, @('kernel32.dll'), [Reflection.FieldInfo[]]@($setLastError), @($true))))
  }
  $k = $type.CreateType()
  # Heartbeat: everything above is machine-speed work with no I/O, so a timeout that arrives
  # before this marker means PowerShell never got going, not that the leash itself is wedged.
  [Console]::Out.WriteLine('ready')

  $job = $k::CreateJobObjectW([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }

  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit and 112 on 32-bit; LimitFlags
  # sits at offset 16 on both, behind the two LARGE_INTEGER time limits. Writing the field
  # into zeroed unmanaged memory avoids emitting the struct layout as well as the calls.
  $size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($info, 16, 0x2000)
  if (-not $k::SetInformationJobObject($job, 9, $info, [uint32]$size)) { throw "SetInformationJobObject failed at $size bytes (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }

  $child = $k::OpenProcess(0x0101, $false, [int]$env:ARKE_LEASH_CHILD_PID)
  if ($child -eq [IntPtr]::Zero) { throw "OpenProcess(child) failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  if (-not $k::AssignProcessToJobObject($job, $child)) { throw "AssignProcessToJobObject failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }

  $owner = $k::OpenProcess(0x0040, $false, [int]$env:ARKE_LEASH_OWNER_PID)
  if ($owner -eq [IntPtr]::Zero) { throw "OpenProcess(owner) failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  $dup = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
  if (-not $k::DuplicateHandle($k::GetCurrentProcess(), $job, $owner, $dup, 0, $false, 2)) { throw "DuplicateHandle failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }

  [Console]::Out.WriteLine('leashed')
} catch {
  # Written straight to the stream, not through Write-Error: PowerShell serializes its own
  # error stream as CLIXML when stderr is a pipe, which buries the sentence behind a
  # "#< CLIXML" preamble that reads as the failure reason.
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

// The helper never varies, so its -EncodedCommand form (UTF-16LE base64, per PowerShell's
// contract) is computed once. PIDs travel as env vars, keeping the command constant.
const HELPER_ENCODED = Buffer.from(HELPER_SOURCE, "utf16le").toString("base64");

/**
 * How long the helper gets before it is treated as wedged. Generous on purpose: the work is
 * milliseconds, so the whole budget is slack for a machine under load, and the cost of
 * calling it too early is an orphaned process tree. Override for a pathological machine.
 */
const DEFAULT_HELPER_BUDGET_MS = 45_000;

function helperBudgetMs(): number {
  const override = Number(process.env["ARKE_LEASH_TIMEOUT_MS"]);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_HELPER_BUDGET_MS;
}

function powershellPath(): string {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function decodeClixml(fragment: string): string {
  return fragment
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Reduce the helper's stderr to the one sentence worth reporting. Our own failures arrive as
 * plain text — the helper writes them to the stream directly for exactly that reason — but
 * PowerShell still answers for itself in CLIXML when it is the thing that failed, and there
 * the sentence is buried in the payload behind a `#< CLIXML` preamble.
 *
 * Exported for the test that pins the CLIXML shapes; not part of the package's API.
 */
export function statedFailure(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  // PowerShell frames stderr as CLIXML whenever it is serializing its own streams, and it
  // does so here even though the helper writes plain text: the `#< CLIXML` preamble and an
  // <Objs> payload (often carrying nothing but a progress record) arrive *around* the
  // helper's line rather than instead of it. Strip the framing and see what text is left —
  // reading the first line instead is what used to report the marker as the reason.
  const spoken = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "#< CLIXML" && !line.startsWith("<Objs"));
  if (spoken.length > 0) return spoken[spoken.length - 1] ?? "";
  // Only framing left, so the sentence — if PowerShell is the thing that failed — is inside
  // the payload. An ErrorRecord serializes as <Obj S="Error">…<ToString>message</ToString>;
  // a bare string on the error stream takes the flatter <S S="Error">message</S>.
  const record = /<Obj\b[^>]*\sS="Error"[^>]*>[\s\S]*?<ToString>([\s\S]*?)<\/ToString>/.exec(text);
  const bare = /<S\b[^>]*\sS="Error"[^>]*>([\s\S]*?)<\/S>/.exec(text);
  const message = record?.[1] ?? bare?.[1];
  if (message === undefined) {
    // A killed helper leaves the preamble and a truncated payload. The XML is not a reason,
    // so say what is actually known rather than quoting a marker.
    return "PowerShell reported an error that did not survive its CLIXML encoding";
  }
  const line = decodeClixml(message)
    .split(/\r?\n/)
    .find((candidate) => candidate.trim() !== "");
  return line?.trim() ?? "";
}

export interface LeashResult {
  ok: boolean;
  /** Stated cause on failure — surfaced once by the supervisor, never thrown. */
  reason?: string;
}

interface Attempt {
  readonly result: LeashResult;
  /** True when the failure describes the machine (wedged, unspawnable) rather than the child. */
  readonly retryable: boolean;
}

function runHelper(childPid: number, ownerPid: number): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
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
      resolve({ result: { ok: false, reason: String(err) }, retryable: true });
      return;
    }
    let out = "";
    let errOut = "";
    helper.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    helper.stderr?.on("data", (chunk: Buffer) => (errOut += chunk.toString()));
    const budgetMs = helperBudgetMs();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        helper.kill();
      } catch {
        /* already gone */
      }
    }, budgetMs);
    helper.once("error", (err) => {
      clearTimeout(timer);
      resolve({ result: { ok: false, reason: String(err) }, retryable: true });
    });
    helper.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.includes("leashed")) {
        resolve({ result: { ok: true }, retryable: false });
        return;
      }
      if (timedOut) {
        // The heartbeat says which half ran out of time, so a slow machine and a wedged
        // PowerShell stop looking alike.
        const stage = out.includes("ready")
          ? "while binding the job object"
          : "before PowerShell finished starting";
        resolve({
          result: { ok: false, reason: `helper timed out after ${Math.round(budgetMs / 1000)}s ${stage}` },
          retryable: true,
        });
        return;
      }
      const detail = statedFailure(errOut);
      resolve({
        result: { ok: false, reason: `helper exited ${code ?? "without a code"}${detail ? `: ${detail}` : ""}` },
        retryable: false,
      });
    });
  });
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
  const first = await runHelper(childPid, ownerPid);
  if (first.result.ok || !first.retryable) return first.result;
  // A helper that was starved of CPU says nothing about whether the leash can be taken, and
  // the price of accepting its answer is an orphan that outlives a force-kill. One more try.
  // If the first attempt was killed after it had already bound the child, the retry adds a
  // second job object over the same process: Windows nests jobs, both carry kill-on-close,
  // and both handles die with the owner, so the duplicate costs a handle and changes nothing.
  const second = await runHelper(childPid, ownerPid);
  if (second.result.ok) return { ok: true };
  return {
    ok: false,
    reason: `${second.result.reason ?? "unknown"} (retried; first attempt: ${first.result.reason ?? "unknown"})`,
  };
}
