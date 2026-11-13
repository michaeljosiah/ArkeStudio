import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, win32 } from "node:path";
import { z } from "zod";
import { leashStorageReaderToParent } from "../job-leash.js";

const EXECUTION_TIMEOUT_MS = 14_000;
const STARTUP_TIMEOUT_MS = 30_000;
/** Includes up to thirty seconds for lifetime binding and original durable admission. */
export const WINDOWS_CACHE_OPERATION_TIMEOUT_MS = STARTUP_TIMEOUT_MS + EXECUTION_TIMEOUT_MS;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.number().int().nonnegative().safe();
export const WindowsCacheProofSchema = z.object({ rootIdentity: hash, fileIdentity: hash, contentHash: hash,
  nodeRootIdentity: hash, nodeFileIdentity: hash, modifiedNs: z.string().regex(/^\d+$/),
  bytes: amount.max(12 * 1024 * 1024), allocatedBytes: amount, writeTicks: z.string().regex(/^\d+$/), observedAt: amount }).strict();
export type WindowsCacheProof = z.infer<typeof WindowsCacheProofSchema>;
const reason = z.enum(["missing", "busy", "permission", "identity", "unsupported", "changed", "links", "native", "cancelled"]);
export type WindowsCacheFileResult = { key: string; state: "measured" | "removed"; proof: WindowsCacheProof } |
  { key: string; state: "absent"; rootIdentity: string; nodeRootIdentity: string; observedAt: number } |
  { key: string; state: "refused" | "unknown"; reason: z.infer<typeof reason> };
const legacy = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), created: z.string().regex(/^\d+$/) }).strict();
const nativeProof = WindowsCacheProofSchema.omit({ nodeRootIdentity: true, nodeFileIdentity: true, modifiedNs: true }).extend({
  rootDos: z.string().max(32767), rootNode: legacy, fileNode: legacy,
}).strict();
const absentProof = z.object({ key: hash, state: z.literal("absent"), rootIdentity: hash,
  rootDos: z.string().max(32767), rootNode: legacy, observedAt: amount }).strict();
const rowSchema = z.discriminatedUnion("state", [
  z.object({ key: hash, state: z.literal("measured"), proof: nativeProof }).strict(),
  z.object({ key: hash, state: z.literal("removed"), proof: nativeProof }).strict(),
  absentProof,
  z.object({ key: hash, state: z.literal("refused"), reason }).strict(),
  z.object({ key: hash, state: z.literal("unknown"), reason }).strict(),
]);
const inputSchema = z.object({ root: z.string().min(1).max(32767).refine(path => win32.isAbsolute(path) && win32.parse(path).root.length > 1),
  items: z.array(z.object({ key: hash, expected: WindowsCacheProofSchema.optional() }).strict()).min(1).max(8),
  mode: z.enum(["inspect", "remove", "reconcile"]),
}).strict().refine(input => new Set(input.items.map(row => row.key)).size === input.items.length &&
  (input.mode === "inspect" || (input.items.length === 1 && input.items[0]!.expected !== undefined)));
type Input = z.infer<typeof inputSchema>;

/** Fixed native program, no compiler or generated assembly file. All input is bounded stdin.
 * Exclusive handles reject conflicting I/O; metadata-only holds can leave deletion pending.
 * Reparse points and hard links refuse.
 * Disposition uses that exact handle; the later pathname probe only verifies its effect.
 * https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle */
const PROGRAM = String.raw`
$ErrorActionPreference='Stop'; $WarningPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$inputData=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ArkeCacheFile')),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$type=$asm.DefineDynamicModule('ArkeCacheFileModule',$false).DefineType('ArkeCacheFile','Public, Class')
$ctor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$fields=[Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),[Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
foreach($sig in @(
 @('CreateFileW',[IntPtr],@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])),
 @('GetFinalPathNameByHandleW',[uint32],@([IntPtr],[Text.StringBuilder],[uint32],[uint32])),
 @('GetFileInformationByHandleEx',[bool],@([IntPtr],[int],[IntPtr],[uint32])),
 @('GetFileInformationByHandle',[bool],@([IntPtr],[IntPtr])),
 @('SetFileInformationByHandle',[bool],@([IntPtr],[int],[IntPtr],[uint32])),
 @('CloseHandle',[bool],@([IntPtr]))
)) {
 $m=$type.DefineMethod($sig[0],'Public, Static, PinvokeImpl',$sig[1],$sig[2])
 $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor,@('kernel32.dll'),$fields,@($true,[Runtime.InteropServices.CharSet]::Unicode))))
}
$k=$type.CreateType()
function info($handle,$kind,$length) {
 $ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal($length)
 try {
  if(-not $k::GetFileInformationByHandleEx($handle,$kind,$ptr,$length)){throw 'identity'}
  $bytes=New-Object byte[] $length; [Runtime.InteropServices.Marshal]::Copy($ptr,$bytes,0,$length); return ,$bytes
 } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}
}
function canonical($handle,$flags) {
 $name=New-Object Text.StringBuilder(32768); $length=$k::GetFinalPathNameByHandleW($handle,$name,32768,$flags)
 if($length -eq 0 -or $length -ge 32768){throw 'identity'}; return $name.ToString()
}
function digest($text) {
 $sha=[Security.Cryptography.SHA256]::Create()
 try {return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}
 finally {$sha.Dispose()}
}
function nodeInfo($handle) {
 $ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
 try {
  if(-not $k::GetFileInformationByHandle($handle,$ptr)){throw 'identity'}
  $bytes=New-Object byte[] 52; [Runtime.InteropServices.Marshal]::Copy($ptr,$bytes,0,52)
  $ino=([uint64][BitConverter]::ToUInt32($bytes,44)*[uint64]4294967296)+[uint64][BitConverter]::ToUInt32($bytes,48)
  return @{dev=([BitConverter]::ToUInt32($bytes,28)).ToString();ino=$ino.ToString();created=([BitConverter]::ToInt64($bytes,4)).ToString()}
 } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}
}
$rows=@(foreach($item in $inputData.items) {
 $root=[IntPtr]::Zero; $file=[IntPtr]::Zero; $stream=$null; $attempted=$false; $why='identity'; $answer=$null
 try {
  if([string]$item.key -cnotmatch '^[a-f0-9]{64}$'){throw 'key'}
  $root=$k::CreateFileW([string]$inputData.root,0,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
  if($root -eq [IntPtr](-1)){throw 'root'}
  $rootBasic=info $root 0 40; $attrs=[BitConverter]::ToUInt32($rootBasic,32)
  if(($attrs -band 0x400) -ne 0 -or ($attrs -band 0x10) -eq 0){throw 'root'}
  $rootName=canonical $root 1
  $why='unsupported'; if($rootName -notmatch '^\\\\\?\\Volume\{[a-fA-F0-9-]{36}\}\\'){throw 'volume'}
  $why='identity'; $rootId=digest ($rootName.ToLowerInvariant()+[char]0+[Convert]::ToBase64String((info $root 18 24)))
  if($inputData.mode -eq 'reconcile' -and $rootId -cne [string]$item.expected.rootIdentity){throw 'changed-root'}
  $access=[uint32]2147483648; if($inputData.mode -eq 'remove'){$access=$access -bor [uint32]65536}
  $filePath=([string]$inputData.root).TrimEnd('\')+'\'+[string]$item.key+'.wav'
  $file=$k::CreateFileW($filePath,$access,0,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero)
  if($file -eq [IntPtr](-1)) {
   $err=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
   if($inputData.mode -eq 'reconcile' -and $err -eq 2) {
    if((canonical $root 1) -cne $rootName){throw 'changed-root'}
    $answer=@{key=[string]$item.key;state='absent';rootIdentity=$rootId;rootDos=(canonical $root 0);rootNode=(nodeInfo $root);observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    throw 'verified-absence'
   }
   $why=if($err -eq 2 -or $err -eq 3){'missing'}elseif($err -eq 32 -or $err -eq 33){'busy'}elseif($err -eq 5){'permission'}else{'native'}
   throw 'open'
  }
  $why='identity'; $name=canonical $file 1; $wanted=$rootName.TrimEnd('\')+'\'+[string]$item.key+'.wav'
  if(-not $name.Equals($wanted,[StringComparison]::OrdinalIgnoreCase)){throw 'containment'}
  $basic=info $file 0 40; $standard=info $file 1 24
  if(([BitConverter]::ToUInt32($basic,32) -band 0x410) -ne 0 -or $standard[20] -ne 0 -or $standard[21] -ne 0){throw 'file'}
  $why='links'; if([BitConverter]::ToUInt32($standard,16) -ne 1){throw 'links'}
  $why='identity'; $size=[BitConverter]::ToInt64($standard,8); $allocation=[BitConverter]::ToInt64($standard,0)
  if($size -lt 0 -or $size -gt 12582912 -or $allocation -lt 0 -or $allocation -gt 9007199254740991){throw 'size'}
  $fileId=digest ([Convert]::ToBase64String((info $file 18 24)))
  $stream=New-Object IO.FileStream($file,[IO.FileAccess]::Read,$false,65536,$false)
  $sha=[Security.Cryptography.SHA256]::Create()
  try {$content=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
  finally {$sha.Dispose();$stream.Dispose();$stream=$null}
  $proof=@{rootIdentity=$rootId;fileIdentity=$fileId;contentHash=$content;bytes=$size;allocatedBytes=$allocation;
   writeTicks=([BitConverter]::ToInt64($basic,16)).ToString();observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
   rootDos=(canonical $root 0);rootNode=(nodeInfo $root);fileNode=(nodeInfo $file)}
  $why='changed'
  if((canonical $root 1) -cne $rootName -or (canonical $file 1) -cne $name -or
   (digest ($rootName.ToLowerInvariant()+[char]0+[Convert]::ToBase64String((info $root 18 24)))) -cne $rootId -or
   (digest ([Convert]::ToBase64String((info $file 18 24)))) -cne $fileId){throw 'changed'}
  if($inputData.mode -eq 'remove') {
   if($null -eq $item.expected){throw 'approval'}
   foreach($field in @('rootIdentity','fileIdentity','contentHash','bytes','allocatedBytes','writeTicks')) {
    if([string]$proof[$field] -cne [string]$item.expected.$field){throw 'changed'}
   }
   $ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal(1)
   try {
    [Runtime.InteropServices.Marshal]::WriteByte($ptr,1);$attempted=$true;$why='native'
    if(-not $k::SetFileInformationByHandle($file,4,$ptr,1)){throw 'disposition'}
   } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}
  }
  $answer=@{key=[string]$item.key;state=$(if($inputData.mode -eq 'remove'){'removed'}else{'measured'});proof=$proof}
 } catch {if($null -eq $answer){$answer=@{key=[string]$item.key;state=$(if($attempted){'unknown'}else{'refused'});reason=$why}}}
 finally {
  if($null -ne $stream){$stream.Dispose()}
  if($file -ne [IntPtr]::Zero -and $file -ne [IntPtr](-1)) {
   if(-not $k::CloseHandle($file)){$answer=@{key=[string]$item.key;state='unknown';reason='native'}}
  }
  if($answer.state -eq 'removed') {
   $check=[IntPtr]::Zero
   try {
    if((canonical $root 1) -cne $rootName){throw 'root-changed'}
    $check=$k::CreateFileW($filePath,0,7,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero)
    if($check -eq [IntPtr](-1)) {
     $err=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
     if($err -ne 2 -and $err -ne 3){throw 'pending-or-unavailable'}
    } elseif((digest ([Convert]::ToBase64String((info $check 18 24)))) -ceq $fileId){throw 'still-present'}
   } catch {$answer=@{key=[string]$item.key;state='unknown';reason='native'}}
   finally {
    if($check -ne [IntPtr]::Zero -and $check -ne [IntPtr](-1)) {
     if(-not $k::CloseHandle($check)){$answer=@{key=[string]$item.key;state='unknown';reason='native'}}
    }
   }
  }
  if($root -ne [IntPtr]::Zero -and $root -ne [IntPtr](-1)) {
   if(-not $k::CloseHandle($root)){$answer=@{key=[string]$item.key;state='unknown';reason='native'}}
  }
 }
 [pscustomobject]$answer
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress
`;
const ENCODED = Buffer.from(PROGRAM, "utf16le").toString("base64");

async function run(input: Input, signal: AbortSignal, admitWorker?: (pid: number) => Promise<boolean>): Promise<string> {
  if (ENCODED.length > 28_000) throw new Error("Native cache program exceeds its command bound.");
  const text = JSON.stringify(input); if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Native cache input exceeds its bound.");
  const closed = new AbortController(); let leashed: Promise<unknown> = Promise.resolve();
  const work = new Promise<string>((resolve, reject) => {
    let failure: Error | null = null, output = "", executionTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = performance.now();
    const child = execFile(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED],
      { windowsHide: true, timeout: WINDOWS_CACHE_OPERATION_TIMEOUT_MS, maxBuffer: 64 * 1024, signal, encoding: "utf8" },
      (error, stdout) => { failure = error; output = stdout; });
    child.stdin?.on("error", () => {});
    const startupTimer = setTimeout(() => child.kill("SIGKILL"), STARTUP_TIMEOUT_MS);
    leashed = (async () => {
      const leash = child.pid ? await leashStorageReaderToParent(child.pid, process.pid, AbortSignal.any([signal, closed.signal])) : { ok: false };
      const admitted = leash.ok && !signal.aborted && child.pid !== undefined &&
        (input.mode !== "remove" || !admitWorker || await admitWorker(child.pid));
      if (admitted && performance.now() - startedAt < STARTUP_TIMEOUT_MS && !signal.aborted && child.exitCode === null && child.signalCode === null) {
        // Waiting for the original grant cannot spend the native execution allowance. No
        // input reaches the worker before admission, and the overall deadline still bounds
        // startup/admission. Cancellation retains the original task until its close settles.
        clearTimeout(startupTimer); executionTimer = setTimeout(() => child.kill("SIGKILL"), EXECUTION_TIMEOUT_MS);
        child.stdin?.end(text);
      }
      else child.kill("SIGKILL");
    })().catch(() => { child.kill("SIGKILL"); });
    child.once("close", () => { clearTimeout(startupTimer); clearTimeout(executionTimer); closed.abort(); if (failure) reject(new Error("Native cache operation outcome unavailable.")); else resolve(output); });
  });
  try { return await work; } finally { await leashed; }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const unixNs = (ticks: string) => ((BigInt(ticks) - 116444736000000000n) * 100n).toString();
function proof(raw: z.infer<typeof nativeProof>): WindowsCacheProof {
  const { rootDos, rootNode, fileNode, ...facts } = raw;
  const dos = rootDos.replace(/^\\\\\?\\/, "").toLowerCase();
  return WindowsCacheProofSchema.parse({ ...facts,
    nodeRootIdentity: digest(JSON.stringify([dos, rootNode.dev, rootNode.ino, unixNs(rootNode.created)])),
    nodeFileIdentity: digest(JSON.stringify([fileNode.dev, fileNode.ino, unixNs(fileNode.created)])), modifiedNs: unixNs(raw.writeTicks) });
}

/** Host-only native primitive. It proves file identity, not producer ownership or permission.
 * Callers must supply producer receipts, lease fences, durable intent and approved plans. */
export async function windowsCacheFiles(input: Input, signal: AbortSignal, admitWorker?: (pid: number) => Promise<boolean>): Promise<WindowsCacheFileResult[]> {
  const parsed = inputSchema.parse(input);
  if (process.platform !== "win32") return parsed.items.map(item => ({ key: item.key, state: "refused", reason: "unsupported" }));
  if (signal.aborted) return parsed.items.map(item => ({ key: item.key, state: "refused", reason: "cancelled" }));
  try {
    const rows = z.array(rowSchema).max(8).parse(JSON.parse(await run(parsed, signal, admitWorker)));
    if (rows.length !== parsed.items.length || new Set(rows.map(row => row.key)).size !== rows.length ||
      rows.some(row => !parsed.items.some(item => item.key === row.key) ||
        row.state === "removed" && parsed.mode !== "remove" || row.state === "measured" && parsed.mode === "remove" || row.state === "absent" && parsed.mode !== "reconcile")) throw new Error("Incomplete native cache result.");
    return rows.map(row => row.state === "measured" || row.state === "removed" ? { key: row.key, state: row.state, proof: proof(row.proof) }
      : row.state === "absent" ? { key: row.key, state: row.state, rootIdentity: row.rootIdentity, observedAt: row.observedAt,
        nodeRootIdentity: digest(JSON.stringify([row.rootDos.replace(/^\\\\\?\\/, "").toLowerCase(), row.rootNode.dev, row.rootNode.ino, unixNs(row.rootNode.created)])) } : row);
  } catch {
    return parsed.items.map(item => ({ key: item.key, state: input.mode === "remove" ? "unknown" : "refused", reason: "native" }));
  }
}
