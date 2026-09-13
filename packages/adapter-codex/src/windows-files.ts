/**
 * Trusted, inline Windows file broker. The process that performs each operation also owns
 * non-delete-sharing handles for EVERY ancestor, so losing the broker cannot
 * leave an unprotected Node operation running. No model text is interpreted as code.
 * Reflection.Emit avoids Add-Type's compiler children and packaging/runtime dependencies.
 */
export const WINDOWS_FILES_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$pins = @{}
$k = $null
try {
  $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ArkeFiles')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $type = $asm.DefineDynamicModule('ArkeFilesModule', $false).DefineType('ArkeFiles', 'Public, Class')
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
  $fields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
  foreach ($sig in @(
    @('CreateFileW', [IntPtr], @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
    @('GetFileInformationByHandle', [bool], @([IntPtr], [IntPtr])),
    @('GetDriveTypeW', [uint32], @([string])),
    @('CloseHandle', [bool], @([IntPtr])),
    @('NtCreateFile', [int], @([IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [uint32], [uint32], [uint32], [uint32], [IntPtr], [uint32])),
    @('NtQueryDirectoryFile', [int], @([IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [uint32], [int], [byte], [IntPtr], [byte])),
    @('NtSetInformationFile', [int], @([IntPtr], [IntPtr], [IntPtr], [uint32], [int]))
  )) {
    $m = $type.DefineMethod($sig[0], 'Public, Static, PinvokeImpl', $sig[1], $sig[2])
    $dll = if ($sig[0].StartsWith('Nt')) { 'ntdll.dll' } else { 'kernel32.dll' }
    $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor, @($dll), $fields, @($true, [Runtime.InteropServices.CharSet]::Unicode))))
  }
  $k = $type.CreateType()
  function Fail { throw 'Denied by Arke Studio confinement.' }
  function Info([IntPtr]$handle) {
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
    try {
      if (-not $k::GetFileInformationByHandle($handle, $p)) { Fail }
      $attr = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($p, 0)
      $vol = [BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($p, 28)), 0)
      $hi = [BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($p, 44)), 0)
      $lo = [BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($p, 48)), 0)
      if (($attr -band 0x400) -ne 0) { Fail }
      return @{ dev = $vol.ToString(); ino = (([uint64]$hi * 4294967296) + $lo).ToString(); directory = (($attr -band 16) -ne 0); links = [Runtime.InteropServices.Marshal]::ReadInt32($p, 40) }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
  }
  function OpenRelative([IntPtr]$parent, [string]$name, [uint32]$desired, [uint32]$share, [uint32]$disposition, [uint32]$options, [bool]$missing) {
    # OBJECT_ATTRIBUTES.RootDirectory makes this a single-component, descriptor-relative
    # lookup. Even an in-place reparse change on the pinned directory cannot redirect it.
    $text = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($name)
    $usSize = 2 * [IntPtr]::Size
    $oaSize = 6 * [IntPtr]::Size
    $us = [Runtime.InteropServices.Marshal]::AllocHGlobal($usSize)
    $oa = [Runtime.InteropServices.Marshal]::AllocHGlobal($oaSize)
    $out = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
    $ios = [Runtime.InteropServices.Marshal]::AllocHGlobal(2 * [IntPtr]::Size)
    try {
      for ($i = 0; $i -lt $usSize; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($us, $i, 0) }
      for ($i = 0; $i -lt $oaSize; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($oa, $i, 0) }
      [Runtime.InteropServices.Marshal]::WriteInt16($us, 0, $name.Length * 2)
      [Runtime.InteropServices.Marshal]::WriteInt16($us, 2, ($name.Length + 1) * 2)
      [Runtime.InteropServices.Marshal]::WriteIntPtr($us, [IntPtr]::Size, $text)
      [Runtime.InteropServices.Marshal]::WriteInt32($oa, 0, $oaSize)
      [Runtime.InteropServices.Marshal]::WriteIntPtr($oa, [IntPtr]::Size, $parent)
      [Runtime.InteropServices.Marshal]::WriteIntPtr($oa, 2 * [IntPtr]::Size, $us)
      [Runtime.InteropServices.Marshal]::WriteInt32($oa, 3 * [IntPtr]::Size, 0x1040)
      $status = $k::NtCreateFile($out, $desired, $oa, $ios, [IntPtr]::Zero, 128, $share, $disposition, $options, [IntPtr]::Zero, 0)
      if ($status -lt 0) {
        if ($missing -and $status -eq -1073741772) { return [IntPtr]::Zero }
        Fail
      }
      return [Runtime.InteropServices.Marshal]::ReadIntPtr($out)
    } finally {
      foreach ($p in @($text, $us, $oa, $out, $ios)) { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
    }
  }
  function Pin([string]$path, [bool]$create) {
    if ($pins.ContainsKey($path)) { return $pins[$path].info }
    $volume = [IO.Path]::GetPathRoot($path)
    if ($volume -notmatch '^[a-zA-Z]:\\$') { throw 'Codex confined tools require a local Windows volume.' }
    if ($k::GetDriveTypeW($volume) -notin @(2, 3, 6)) { throw 'Codex confined tools require a local Windows volume.' }
    $current = $volume
    $parts = @('') + @($path.Substring($volume.Length).Split([char]'\', [StringSplitOptions]::RemoveEmptyEntries))
    foreach ($part in $parts) {
      $parent = $current
      if ($part) { $current = [IO.Path]::Combine($current, $part) }
      if ($pins.ContainsKey($current)) { continue }
      if ($pins.Count -ge 256) { throw 'The confined operation reached its directory handle limit.' }
      # LIST_DIRECTORY|READ_ATTRIBUTES|SYNCHRONIZE. Deny delete sharing so neither this
      # directory nor its ancestors can be renamed. Writes remain shareable: atomic
      # rename requires it; all traversal instead uses relative native handles below.
      if (-not $part) { $h = $k::CreateFileW($current, 0x100081, 3, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero) }
      else { $h = OpenRelative $pins[$parent].handle $part 0x100081 3 $(if ($create) { 3 } else { 1 }) 0x00200021 $false }
      if ($h -eq [IntPtr](-1)) { Fail }
      try { $info = Info $h; if (-not $info.directory -or $info.ino -eq '0') { Fail } }
      catch { [void]$k::CloseHandle($h); throw }
      $pins[$current] = @{ handle = $h; info = $info }
    }
    return $pins[$path].info
  }
  function FileHandle([string]$path) {
    $h = OpenRelative $pins[[IO.Path]::GetDirectoryName($path)].handle ([IO.Path]::GetFileName($path)) 2148532224 1 1 0x00200060 $false
    try { $info = Info $h; if ($info.directory -or $info.links -ne 1) { Fail } }
    catch { [void]$k::CloseHandle($h); throw }
    return $h
  }
  function CheckLeaf([string]$path) {
    $h = OpenRelative $pins[[IO.Path]::GetDirectoryName($path)].handle ([IO.Path]::GetFileName($path)) 128 7 1 0x00200040 $true
    if ($h -eq [IntPtr]::Zero) { return }
    try { $info = Info $h; if ($info.directory -or $info.links -ne 1) { Fail } }
    finally { [void]$k::CloseHandle($h) }
  }
  [Console]::Out.WriteLine('{"ready":true}')
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    try {
      $r = ConvertFrom-Json -InputObject $line
      if ($r.op -eq 'close') { break }
      $path = [string]$r.path
      if ($r.op -eq 'pin') { $result = Pin $path ([bool]$r.create) }
      elseif ($r.op -eq 'list') {
        $null = Pin $path $false
        $rows = New-Object 'Collections.Generic.List[object]'
        $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(65536)
        $ios = [Runtime.InteropServices.Marshal]::AllocHGlobal(2 * [IntPtr]::Size)
        try {
          $restart = 1
          while ($rows.Count -lt 3001) {
            $status = $k::NtQueryDirectoryFile($pins[$path].handle, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, $ios, $buffer, 65536, 1, 0, [IntPtr]::Zero, $restart)
            $restart = 0
            if ($status -eq -2147483642) { break }
            if ($status -lt 0) { Fail }
            $offset = 0
            do {
              $entry = [IntPtr]::Add($buffer, $offset)
              $next = [Runtime.InteropServices.Marshal]::ReadInt32($entry, 0)
              $attr = [Runtime.InteropServices.Marshal]::ReadInt32($entry, 56)
              $length = [Runtime.InteropServices.Marshal]::ReadInt32($entry, 60)
              if ($length -lt 0 -or $length -gt 65536 - $offset - 64 -or ($length % 2) -ne 0) { Fail }
              $name = [Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($entry, 64), $length / 2)
              if ($name -ne '.' -and $name -ne '..' -and ($attr -band 0x400) -eq 0) { $rows.Add(@{ name = $name; directory = (($attr -band 16) -ne 0) }) }
              if ($rows.Count -ge 3001 -or $next -eq 0) { break }
              if ($next -lt 64 -or $offset + $next -gt 65472) { Fail }
              $offset += $next
            } while ($true)
          }
        } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer); [Runtime.InteropServices.Marshal]::FreeHGlobal($ios) }
        $result = @{ entries = @($rows.ToArray()) }
      }
      elseif ($r.op -eq 'read') {
        $null = Pin ([IO.Path]::GetDirectoryName($path)) $false
        $h = FileHandle $path
        $safe = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($h, $true)
        $stream = New-Object IO.FileStream($safe, [IO.FileAccess]::Read)
        try {
          if ($stream.Length -gt [int]$r.limit) { throw 'This file exceeds the session read limit.' }
          $memory = New-Object IO.MemoryStream
          try {
            $buffer = New-Object byte[] 65536
            while (($n = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, [int]$r.limit + 1 - [int]$memory.Length))) -gt 0) {
              $memory.Write($buffer, 0, $n)
              if ($memory.Length -gt [int]$r.limit) { throw 'This file exceeds the session read limit.' }
            }
            $result = @{ data = [Convert]::ToBase64String($memory.ToArray()) }
          } finally { $memory.Dispose() }
        } finally { $stream.Dispose(); $safe.Dispose() }
      }
      elseif ($r.op -eq 'write') {
        $parent = [IO.Path]::GetDirectoryName($path)
        $null = Pin $parent $true
        CheckLeaf $path
        $temporary = [IO.Path]::Combine($parent, '.arke-codex-write-' + [Guid]::NewGuid().ToString() + '.tmp')
        $h = [IntPtr]::Zero
        $safe = $null
        $committed = $false
        try {
          $data = [Convert]::FromBase64String([string]$r.data)
          if ($data.Length -gt 16777216) { throw 'The proposed file exceeds 16 MB.' }
          $h = OpenRelative $pins[$parent].handle ([IO.Path]::GetFileName($temporary)) 0x40110000 0 2 0x00200060 $false
          if ($h -eq [IntPtr](-1)) { Fail }
          $safe = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($h, $true)
          $stream = New-Object IO.FileStream($safe, [IO.FileAccess]::Write)
          try {
            $stream.Write($data, 0, $data.Length); $stream.Flush()
            CheckLeaf $path
            $name = [Text.Encoding]::Unicode.GetBytes([IO.Path]::GetFileName($path))
            $rootOffset = [IntPtr]::Size
            $lengthOffset = $rootOffset + [IntPtr]::Size
            $nameOffset = $lengthOffset + 4
            $size = $nameOffset + $name.Length + 2
            $info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
            $ioStatus = [Runtime.InteropServices.Marshal]::AllocHGlobal(2 * [IntPtr]::Size)
            try {
              for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
              [Runtime.InteropServices.Marshal]::WriteByte($info, 0, 1)
              [Runtime.InteropServices.Marshal]::WriteIntPtr($info, $rootOffset, $pins[$parent].handle)
              [Runtime.InteropServices.Marshal]::WriteInt32($info, $lengthOffset, $name.Length)
              [Runtime.InteropServices.Marshal]::Copy($name, 0, [IntPtr]::Add($info, $nameOffset), $name.Length)
              $status = $k::NtSetInformationFile($h, $ioStatus, $info, [uint32]$size, 10)
              if ($status -lt 0) { Fail }
              $committed = $true
            } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info); [Runtime.InteropServices.Marshal]::FreeHGlobal($ioStatus) }
          } finally {
            if (-not $committed) {
              $delete = [Runtime.InteropServices.Marshal]::AllocHGlobal(1)
              $ios = [Runtime.InteropServices.Marshal]::AllocHGlobal(2 * [IntPtr]::Size)
              try { [Runtime.InteropServices.Marshal]::WriteByte($delete, 0, 1); [void]$k::NtSetInformationFile($h, $ios, $delete, 1, 13) }
              finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($delete); [Runtime.InteropServices.Marshal]::FreeHGlobal($ios) }
            }
            $stream.Dispose(); $safe.Dispose()
          }
          $result = @{}
        } finally { if ($h -ne [IntPtr]::Zero -and -not $safe) { [void]$k::CloseHandle($h) } }
      }
      else { Fail }
      [Console]::Out.WriteLine((@{ result = $result } | ConvertTo-Json -Depth 6 -Compress))
    } catch {
      $message = if ($_.Exception.Message -match 'session read limit|proposed file exceeds|local Windows volume|directory handle limit') { $_.Exception.Message } else { 'Denied by Arke Studio confinement.' }
      [Console]::Out.WriteLine((@{ error = $message } | ConvertTo-Json -Compress))
    }
  }
} finally {
  if ($k) { foreach ($value in $pins.Values) { [void]$k::CloseHandle($value.handle) } }
}
`;
