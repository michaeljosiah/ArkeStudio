import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

// Independent adversary process: mutate reparse metadata on an already-open empty
// directory. This intentionally does not share the production broker's pin/traversal code.
const source = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('ReparseTest'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $asm.DefineDynamicModule('ReparseTest', $false).DefineType('ReparseTest', 'Public, Class')
$ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$fields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
foreach ($sig in @(
  @('CreateFileW', [IntPtr], @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
  @('DeviceIoControl', [bool], @([IntPtr], [uint32], [IntPtr], [uint32], [IntPtr], [uint32], [IntPtr], [IntPtr])),
  @('CloseHandle', [bool], @([IntPtr]))
)) {
  $m = $type.DefineMethod($sig[0], 'Public, Static, PinvokeImpl', $sig[1], $sig[2])
  $m.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($ctor, @('kernel32.dll'), $fields, @([Runtime.InteropServices.CharSet]::Unicode)))
}
$k = $type.CreateType()
$h = $k::CreateFileW($env:ARKE_TEST_DIRECTORY, 0x40000000, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { throw 'Adversary could not open the pinned directory for reparse mutation.' }
$sub = [Text.Encoding]::Unicode.GetBytes('\??\' + $env:ARKE_TEST_TARGET)
$print = [Text.Encoding]::Unicode.GetBytes($env:ARKE_TEST_TARGET)
$deleting = $env:ARKE_TEST_DELETE -eq '1'
$size = if ($deleting) { 8 } else { 20 + $sub.Length + $print.Length }
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
$written = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
try {
  for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buffer, $i, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 0, -1610612733)
  if (-not $deleting) {
    [Runtime.InteropServices.Marshal]::WriteInt16($buffer, 4, $size - 8)
    [Runtime.InteropServices.Marshal]::WriteInt16($buffer, 10, $sub.Length)
    [Runtime.InteropServices.Marshal]::WriteInt16($buffer, 12, $sub.Length + 2)
    [Runtime.InteropServices.Marshal]::WriteInt16($buffer, 14, $print.Length)
    [Runtime.InteropServices.Marshal]::Copy($sub, 0, [IntPtr]::Add($buffer, 16), $sub.Length)
    [Runtime.InteropServices.Marshal]::Copy($print, 0, [IntPtr]::Add($buffer, 18 + $sub.Length), $print.Length)
  }
  $control = if ($deleting) { 0x900AC } else { 0x900A4 }
  if (-not $k::DeviceIoControl($h, $control, $buffer, [uint32]$size, [IntPtr]::Zero, 0, $written, [IntPtr]::Zero)) { throw 'Adversarial reparse mutation failed.' }
  [Console]::Out.WriteLine('changed')
} finally { [void]$k::CloseHandle($h); [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer); [Runtime.InteropServices.Marshal]::FreeHGlobal($written) }
`;

export async function mutateJunction(directory: string, target: string, remove = false): Promise<void> {
  const { stdout } = await promisify(execFile)(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
      env: { SystemRoot: process.env["SystemRoot"], ARKE_TEST_DIRECTORY: directory, ARKE_TEST_TARGET: target, ARKE_TEST_DELETE: remove ? "1" : "0" },
    });
  if (stdout.trim() !== "changed") throw new Error("The adversarial reparse helper did not complete.");
}
