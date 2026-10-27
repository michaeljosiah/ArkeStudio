import { execFile } from "node:child_process";
import { join, win32 } from "node:path";
import { leashStorageReaderToParent } from "../job-leash.js";
import { isSupervisedProcessOrigin, type SupervisedProcessOrigin } from "../supervisor.js";

export interface LoopbackConnection { readonly clientPort: number; readonly serverPort: number }

// Inspect the reverse ESTABLISHED tuple, not a listener followed by a fresh connection.
// Node retains the original Windows process handle until its exit callback sets exitCode/
// signalCode. The supervisor's original ChildProcess fence therefore excludes PID reuse.
// Keep this port Windows-only: POSIX child reaping has a different lifetime contract.
// https://learn.microsoft.com/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable
// https://learn.microsoft.com/windows/win32/api/tcpmib/ns-tcpmib-mib_tcprow_owner_pid
const PROGRAM = String.raw`
$ErrorActionPreference='Stop'; $WarningPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$data=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ArkeConnectionOrigin')),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$type=$asm.DefineDynamicModule('ArkeConnectionOriginModule',$false).DefineType('ArkeConnectionOrigin','Public, Class')
$ctor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$fields=[Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),[Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
foreach($sig in @(
 @('OpenProcess',[IntPtr],@([uint32],[bool],[uint32]),'kernel32.dll'),
 @('QueryFullProcessImageNameW',[bool],@([IntPtr],[uint32],[Text.StringBuilder],[uint32].MakeByRefType()),'kernel32.dll'),
 @('WaitForSingleObject',[uint32],@([IntPtr],[uint32]),'kernel32.dll'),
 @('CloseHandle',[bool],@([IntPtr]),'kernel32.dll'),
 @('GetExtendedTcpTable',[uint32],@([IntPtr],[uint32].MakeByRefType(),[bool],[uint32],[int],[uint32]),'iphlpapi.dll')
)) {
 $m=$type.DefineMethod($sig[0],'Public, Static, PinvokeImpl',$sig[1],$sig[2])
 $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor,@($sig[3]),$fields,@($true,[Runtime.InteropServices.CharSet]::Unicode))))
}
$k=$type.CreateType(); $handle=[IntPtr]::Zero; $verified=$false
try {
 $handle=$k::OpenProcess(0x101000,$false,[uint32]$data.pid)
 if($handle -eq [IntPtr]::Zero -or $k::WaitForSingleObject($handle,0) -ne 258){throw 'process'}
 $name=New-Object Text.StringBuilder(32768); [uint32]$nameLength=32768
 if(-not $k::QueryFullProcessImageNameW($handle,0,$name,[ref]$nameLength) -or $nameLength -eq 0 -or $nameLength -ge 32768){throw 'image'}
 if($name.ToString() -ine [string]$data.executable){throw 'image'}
 [uint32]$size=0
 if($k::GetExtendedTcpTable([IntPtr]::Zero,[ref]$size,$false,2,5,0) -ne 122){throw 'table'}
 for($attempt=0;$attempt -lt 2;$attempt++) {
  if($size -lt 4 -or $size -gt 4194304){throw 'bound'}
  $capacity=$size; $ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal([int]$capacity)
  try {
   $result=$k::GetExtendedTcpTable($ptr,[ref]$size,$false,2,5,0)
   if($result -eq 122){continue}; if($result -ne 0 -or $size -gt $capacity){throw 'table'}
   $count=[Runtime.InteropServices.Marshal]::ReadInt32($ptr,0)
   if($count -lt 0 -or ([long]$count*24+4) -gt $capacity){throw 'bound'}
   $matches=0; $owned=$false
   for($i=0;$i -lt $count;$i++) {
    $row=[IntPtr]::Add($ptr,4+$i*24)
    if([Runtime.InteropServices.Marshal]::ReadInt32($row,0) -ne 5 -or
       [Runtime.InteropServices.Marshal]::ReadInt32($row,4) -ne 16777343 -or
       [Runtime.InteropServices.Marshal]::ReadInt32($row,12) -ne 16777343){continue}
    $local=[Runtime.InteropServices.Marshal]::ReadInt32($row,8); $remote=[Runtime.InteropServices.Marshal]::ReadInt32($row,16)
    $local=(($local -band 255) -shl 8) -bor (($local -shr 8) -band 255)
    $remote=(($remote -band 255) -shl 8) -bor (($remote -shr 8) -band 255)
    if($local -eq [int]$data.serverPort -and $remote -eq [int]$data.clientPort) {
     $matches++; $owned=[Runtime.InteropServices.Marshal]::ReadInt32($row,20) -eq [int]$data.pid
    }
   }
   if($matches -ne 1 -or -not $owned -or $k::WaitForSingleObject($handle,0) -ne 258){throw 'owner'}
   $verified=$true; break
  } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}
 }
} finally {if($handle -ne [IntPtr]::Zero -and -not $k::CloseHandle($handle)){throw 'close'}}
if(-not $verified){throw 'unavailable'}
[Console]::Write('verified')
`;
const ENCODED = Buffer.from(PROGRAM, "utf16le").toString("base64");
const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/** Resolves only after its exact native helper and leash work close. Callers that abandon
 * observation must retain this task. This proves neither binary integrity nor GPU cleanup. */
export async function windowsConnectionOrigin(origin: SupervisedProcessOrigin, connection: LoopbackConnection, signal: AbortSignal): Promise<boolean> {
  const { clientPort, serverPort } = connection;
  if (process.platform !== "win32" || signal.aborted || !isSupervisedProcessOrigin(origin) || !origin.current() ||
    !validPort(clientPort) || serverPort !== origin.port || !validPort(serverPort) ||
    !Number.isSafeInteger(origin.pid) || origin.pid < 1 || !/^[a-z]:[\\/].*\.exe$/i.test(origin.executable) || ENCODED.length > 28_000) return false;
  const input = JSON.stringify({ pid: origin.pid, executable: win32.normalize(origin.executable), clientPort, serverPort });
  if (Buffer.byteLength(input) > 8192) return false;
  const closed = new AbortController(); let leashed: Promise<unknown> = Promise.resolve();
  try {
    const answer = await new Promise<boolean>(resolve => {
      let failed = false, output = "";
      const child = execFile(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED],
        { windowsHide: true, timeout: 12_000, maxBuffer: 4096, signal, encoding: "utf8" },
        (error, stdout) => { failed = !!error; output = stdout; });
      child.stdin?.on("error", () => {});
      leashed = (async () => {
        const leash = child.pid ? await leashStorageReaderToParent(child.pid, process.pid, AbortSignal.any([signal, closed.signal])) : { ok: false };
        if (leash.ok && !signal.aborted && origin.current() && child.exitCode === null && child.signalCode === null) child.stdin?.end(input);
        else child.kill("SIGKILL");
      })().catch(() => { child.kill("SIGKILL"); });
      child.once("close", () => { closed.abort(); resolve(!failed && output === "verified"); });
    });
    return answer && !signal.aborted && origin.current();
  } catch { return false; }
  finally { await leashed; }
}
