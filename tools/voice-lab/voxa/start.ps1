param(
  [string]$VoxaSource = 'C:/Users/mjosi/source/repos/Voxa',
  [string]$Python = 'D:/ArkeVoiceLab/pipecat-venv/Scripts/python.exe',
  [string]$Model = 'github-copilot/claude-haiku-4.5',
  [int]$Port = 9076,
  [switch]$Background
)
$ErrorActionPreference = 'Stop'
$voiceLabBuild = Join-Path $PSScriptRoot '.build'
$voiceLabShared = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../pipecat'))
$voiceLabState = Join-Path $voiceLabBuild 'run'
$env:DOTNET_CLI_HOME = Join-Path $voiceLabBuild 'dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
& $Python (Join-Path $PSScriptRoot 'prepare_source.py') $VoxaSource (Join-Path $voiceLabBuild 'voxa-source')
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare Voxa source snapshot.' }
dotnet build (Join-Path $PSScriptRoot 'VoiceLab.csproj') -m:1 -p:BuildInParallel=false "-p:VoxaSource=$voiceLabBuild/voxa-source" "-p:VoiceLabBuildRoot=$voiceLabBuild" "-p:DirectoryBuildPropsPath=$PSScriptRoot/isolated.props" --source (Join-Path $env:USERPROFILE '.nuget/packages') --packages (Join-Path $voiceLabBuild 'packages') -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'Voxa host build failed. This offline build requires the source checkout and its cached NuGet packages.' }
$voiceLabWeb = Join-Path $voiceLabShared 'web'
npm.cmd run build --prefix $voiceLabWeb
if ($LASTEXITCODE -ne 0) { throw 'Shared page build failed.' }
node (Join-Path $voiceLabWeb 'node_modules/esbuild/bin/esbuild') (Join-Path $VoxaSource 'clients/voxa-client/src/index.ts') --bundle --format=esm "--outfile=$voiceLabWeb/dist/assets/voxa-client.js"
if ($LASTEXITCODE -ne 0) { throw 'Voxa browser client build failed.' }
$voiceLabDll = Join-Path $voiceLabBuild 'bin/VoiceLab/Release/net10.0/VoiceLab.dll'
$voiceLabApp = Join-Path $voiceLabShared 'app.py'
New-Item -ItemType Directory -Force $voiceLabState | Out-Null
if ($Background) {
  if ($Model -notmatch '^[\w./:+-]+$') { throw 'Use a provider/model identifier without spaces or quotes.' }
  $voiceLabArguments = '-u "{0}" --engine voxa --voxa-dll "{1}" --state "{2}" --port {3} --model "{4}"' -f $voiceLabApp, $voiceLabDll, $voiceLabState, $Port, $Model
  $voiceLabProcess = Start-Process -FilePath $Python -ArgumentList $voiceLabArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $voiceLabState 'server-out.log') -RedirectStandardError (Join-Path $voiceLabState 'server-error.log')
  Write-Host "Voxa voice lab starting at http://127.0.0.1:$Port (PID $($voiceLabProcess.Id))."
} else {
  & $Python -u $voiceLabApp --engine voxa --voxa-dll $voiceLabDll --state $voiceLabState --port $Port --model $Model
}
