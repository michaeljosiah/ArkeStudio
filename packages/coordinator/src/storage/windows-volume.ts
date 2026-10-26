import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { win32, join } from "node:path";
import { z } from "zod";
import { leashChildToParent } from "../job-leash.js";
import type { StorageProbeResult } from "./monitor.js";

const rootSchema = z.object({ rootId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), path: z.string().min(1).max(32767).refine(win32.isAbsolute) }).strict();
type Root = z.infer<typeof rootSchema>;
const rowSchema = z.object({ rootId: rootSchema.shape.rootId, state: z.enum(["measured", "unavailable", "unsupported"]), error: z.number().int(),
  canonical: z.string().max(32767).optional(), fileId: z.string().max(64).optional(), availableBytes: z.number().int().nonnegative().safe().optional(),
  measuredAt: z.number().int().nonnegative().safe().optional() }).strict();

/** Reflection.Emit shares the no-compiler/no-temporary-assembly boundary of job-leash.ts.
 * Inputs travel only through stdin. This constant program cannot evaluate a supplied path.
 * GetFinalPathNameByHandleW resolves junctions and returns the volume GUID; FILE_ID_INFO binds
 * the registered root's 128-bit identity. GetDiskFreeSpaceExW reports caller-available bytes.
 * https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
 * https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw */
const QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$roots = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ArkeStorage')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $asm.DefineDynamicModule('ArkeStorageModule', $false).DefineType('ArkeStorage', 'Public, Class')
$ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$fields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
foreach ($sig in @(
  @('CreateFileW', [IntPtr], @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
  @('GetFinalPathNameByHandleW', [uint32], @([IntPtr], [Text.StringBuilder], [uint32], [uint32])),
  @('GetFileInformationByHandleEx', [bool], @([IntPtr], [int], [IntPtr], [uint32])),
  @('GetDiskFreeSpaceExW', [bool], @([string], [uint64].MakeByRefType(), [uint64].MakeByRefType(), [uint64].MakeByRefType())),
  @('CloseHandle', [bool], @([IntPtr]))
)) {
  $m = $type.DefineMethod($sig[0], 'Public, Static, PinvokeImpl', $sig[1], $sig[2])
  $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor, @('kernel32.dll'), $fields, @($true, [Runtime.InteropServices.CharSet]::Unicode))))
}
$k = $type.CreateType()
$rows = @(foreach ($root in $roots) {
  $handle = [IntPtr]::Zero; $info = [IntPtr]::Zero; $again = [IntPtr]::Zero; $againInfo = [IntPtr]::Zero
  try {
    $handle = $k::CreateFileW([string]$root.path, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($handle -eq [IntPtr](-1)) { throw 'open' }
    $name = New-Object Text.StringBuilder(32768)
    $length = $k::GetFinalPathNameByHandleW($handle, $name, 32768, 1)
    if ($length -eq 0 -or $length -ge 32768) { throw 'identity' }
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    if (-not $k::GetFileInformationByHandleEx($handle, 18, $info, 24)) { throw 'identity' }
    $id = New-Object byte[] 24
    [Runtime.InteropServices.Marshal]::Copy($info, $id, 0, 24)
    [uint64]$available = 0; [uint64]$total = 0; [uint64]$free = 0
    $measuredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not $k::GetDiskFreeSpaceExW($name.ToString(), [ref]$available, [ref]$total, [ref]$free)) { throw 'capacity' }
    # Reopen the registered path so a junction retarget or directory replacement is detected too.
    $again = $k::CreateFileW([string]$root.path, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($again -eq [IntPtr](-1)) { throw 'changed' }
    $againInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    if (-not $k::GetFileInformationByHandleEx($again, 18, $againInfo, 24)) { throw 'changed' }
    $againId = New-Object byte[] 24
    [Runtime.InteropServices.Marshal]::Copy($againInfo, $againId, 0, 24)
    if ([Convert]::ToBase64String($againId) -cne [Convert]::ToBase64String($id)) { throw 'changed' }
    $after = New-Object Text.StringBuilder(32768)
    if ($k::GetFinalPathNameByHandleW($again, $after, 32768, 1) -eq 0 -or $after.ToString() -cne $name.ToString()) { throw 'changed' }
    [pscustomobject]@{rootId=$root.rootId;state='measured';error=0;canonical=$name.ToString();fileId=[Convert]::ToBase64String($id);availableBytes=$available;measuredAt=$measuredAt}
  } catch {
    $code = if ($_.Exception.Message -eq 'changed') { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    $state = if ($_.Exception.Message -eq 'identity') { 'unsupported' } else { 'unavailable' }
    [pscustomobject]@{rootId=$root.rootId;state=$state;error=$code}
  } finally {
    if ($info -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
    if ($againInfo -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($againInfo) }
    if ($again -ne [IntPtr]::Zero -and $again -ne [IntPtr](-1)) { [void]$k::CloseHandle($again) }
    if ($handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr](-1)) { [void]$k::CloseHandle($handle) }
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
`;
const ENCODED = Buffer.from(QUERY, "utf16le").toString("base64");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = (state: "unavailable" | "unsupported" = "unavailable", cancelled = false): StorageProbeResult => ({
  state, source: "windows-volume-api", capacity: null, limitations: [cancelled ? "cancelled" : state === "unsupported" ? "unsupported-filesystem" : "probe-failed"],
});

export async function queryWindowsStorageVolumes(roots: readonly Root[], signal: AbortSignal): Promise<string> {
  const input = JSON.stringify(roots);
  if (Buffer.byteLength(input) > 128 * 1024) throw new Error("Storage probe input exceeds its bound.");
  let leashed: Promise<unknown> = Promise.resolve();
  const result = new Promise<string>((resolve, reject) => {
    let failure: Error | null = null, output = "";
    const child = execFile(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED],
      { windowsHide: true, timeout: 14_000, maxBuffer: 128 * 1024, signal, encoding: "utf8" },
      (error, stdout) => { failure = error; output = stdout; });
    child.stdin?.on("error", () => {});
    // The query waits on stdin until kernel lifetime ownership is established. Reflection.Emit
    // starts no compiler helpers, and the close event confirms this one owned reader has exited.
    leashed = (async () => {
      const leash = child.pid ? await leashChildToParent(child.pid) : { ok: false };
      if (leash.ok && !signal.aborted && child.exitCode === null && child.signalCode === null) child.stdin?.end(input);
      else child.kill("SIGKILL");
    })().catch(() => { child.kill("SIGKILL"); });
    child.once("close", () => failure ? reject(new Error("Native storage measurement unavailable.", { cause: failure })) : resolve(output));
  });
  try { return await result; } finally { await leashed; }
}

/** Windows host port: only registered handles, one coalesced native read, no paths in public facts. */
export class WindowsVolumeProbe {
  private roots: Root[] = [];
  private version = 0;
  private cache: { at: number; rows: Map<string, StorageProbeResult> } | null = null;
  private pending: { work: Promise<Map<string, StorageProbeResult>>; control: AbortController; users: Set<symbol>; done: boolean } | null = null;
  private active = new Map<AbortController, Promise<unknown>>();
  private stopped = false;
  constructor(private readonly deps: { platform?: string; now?: () => number; query?: (roots: readonly Root[], signal: AbortSignal) => Promise<string> } = {}) {}
  setRoots(roots: readonly Root[]): void {
    const parsed = z.array(rootSchema).max(128).parse(roots);
    if (new Set(parsed.map(root => root.rootId)).size !== parsed.length) throw new Error("Repeated storage root.");
    if (this.stopped || JSON.stringify(parsed) === JSON.stringify(this.roots)) return;
    this.roots = parsed; this.version++; this.cache = null; this.pending = null;
    for (const control of this.active.keys()) control.abort();
  }
  async probe(rootId: string, signal: AbortSignal, after = -Infinity): Promise<StorageProbeResult> {
    if (this.stopped || signal.aborted) return unavailable("unavailable", true);
    if ((this.deps.platform ?? process.platform) !== "win32") return unavailable("unsupported");
    if (!this.roots.some(root => root.rootId === rootId)) return unavailable();
    const now = (this.deps.now ?? Date.now)();
    const cached = this.cache?.rows.get(rootId);
    if (this.cache && now >= this.cache.at && now - this.cache.at < 1_000 && (cached?.capacity ? cached.capacity.measuredAt > after : this.cache.at > after)) return structuredClone(cached ?? unavailable());
    const user = Symbol();
    if (!this.pending) {
      const version = this.version, roots = this.roots, control = new AbortController();
      const entry = { work: null! as Promise<Map<string, StorageProbeResult>>, control, users: new Set([user]), done: false };
      const work = (async () => {
        const mapped = new Map<string, StorageProbeResult>();
        try {
          const rows = z.array(rowSchema).max(128).parse(JSON.parse(await (this.deps.query ?? queryWindowsStorageVolumes)(roots, control.signal)));
          if (new Set(rows.map(row => row.rootId)).size !== rows.length) throw new Error("Repeated native storage result.");
          if (rows.some(row => !roots.some(root => root.rootId === row.rootId))) throw new Error("Unexpected native storage result.");
          for (const row of rows) {
            const guid = row.canonical?.match(/^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\/i)?.[0];
            if (row.state === "measured" && guid && row.fileId && row.availableBytes !== undefined && row.measuredAt !== undefined) {
              mapped.set(row.rootId, { state: "measured", source: "windows-volume-api", limitations: ["total-unavailable"], capacity: {
                volumeId: hash(guid.toLowerCase()), mappingRevision: hash(row.canonical!.toLowerCase() + "\0" + row.fileId),
                measuredAt: row.measuredAt, availableBytes: row.availableBytes,
                // GetDiskFreeSpaceEx's total can be quota-limited; physical volume size is unknown.
                totalBytes: null,
              } });
            } else mapped.set(row.rootId, row.error === 5 ? { ...unavailable(), limitations: ["permission-denied"] } : unavailable(row.state === "unsupported" ? "unsupported" : "unavailable"));
          }
        } catch { mapped.clear(); /* A rejected response grants no partial measurement. */ }
        if (this.stopped || control.signal.aborted || this.version !== version || entry.users.size === 0) return new Map<string, StorageProbeResult>();
        this.cache = { at: (this.deps.now ?? Date.now)(), rows: mapped }; return mapped;
      })();
      entry.work = work; this.pending = entry;
      this.active.set(control, work);
      void work.finally(() => { entry.done = true; this.active.delete(control); if (this.pending === entry) this.pending = null; });
    } else this.pending.users.add(user);
    const entry = this.pending;
    const release = () => {
      entry.users.delete(user);
      if (entry.users.size === 0 && !entry.done) { entry.control.abort(); if (this.pending === entry) this.pending = null; }
    };
    let abandon!: () => void;
    const cancelled = new Promise<null>(resolve => { abandon = () => { release(); resolve(null); }; signal.addEventListener("abort", abandon, { once: true }); });
    if (signal.aborted) abandon();
    try {
      const rows = await Promise.race([entry.work, cancelled]);
      const result = rows?.get(rootId);
      if (this.stopped || signal.aborted) return unavailable("unavailable", true);
      return result?.capacity && result.capacity.measuredAt <= after ? unavailable() : structuredClone(result ?? unavailable());
    } finally { signal.removeEventListener("abort", abandon); release(); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const control of this.active.keys()) control.abort();
    await Promise.allSettled(this.active.values());
    this.cache = null;
  }
}
