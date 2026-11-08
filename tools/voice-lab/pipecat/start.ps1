param(
  [string]$State = (Join-Path $env:LOCALAPPDATA 'ArkeVoiceLab/pipecat'),
  [int]$Port = 9075,
  [string]$Model = 'github-copilot/claude-haiku-4.5',
  [switch]$Background
)
$ErrorActionPreference = 'Stop'
$voiceLabState = [IO.Path]::GetFullPath($State)
$voiceLabPage = Join-Path $PSScriptRoot 'web'
$voiceLabPreviousEnvironment = $env:UV_PROJECT_ENVIRONMENT
try {
  $env:UV_PROJECT_ENVIRONMENT = Join-Path $voiceLabState 'pipecat-venv'
  python -m uv sync --project $PSScriptRoot --python 3.11 --locked
  if ($LASTEXITCODE -ne 0) { throw 'Python dependency setup failed.' }
  npm.cmd ci --prefix $voiceLabPage
  if ($LASTEXITCODE -ne 0) { throw 'Page dependency setup failed.' }
  npm.cmd run build --prefix $voiceLabPage
  if ($LASTEXITCODE -ne 0) { throw 'Page build failed.' }
  $voiceLabPython = Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts/python.exe'
  $voiceLabApp = Join-Path $PSScriptRoot 'app.py'
  if ($Background) {
    if ($Model -notmatch '^[\w./:+-]+$') { throw 'Use a provider/model identifier without quotes or spaces.' }
    $voiceLabArguments = '-u "{0}" --state "{1}" --port {2} --model "{3}"' -f $voiceLabApp, $voiceLabState, $Port, $Model
    $voiceLabProcess = Start-Process -FilePath $voiceLabPython -ArgumentList $voiceLabArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $voiceLabState 'server-out.log') -RedirectStandardError (Join-Path $voiceLabState 'server-error.log')
    Write-Host "Voice lab starting at http://127.0.0.1:$Port (PID $($voiceLabProcess.Id)). Use stop.ps1 to drain and stop it."
  } else {
    & $voiceLabPython -u $voiceLabApp --state $voiceLabState --port $Port --model $Model
  }
} finally {
  $env:UV_PROJECT_ENVIRONMENT = $voiceLabPreviousEnvironment
}
