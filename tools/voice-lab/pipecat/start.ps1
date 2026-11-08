param(
  [string]$State = (Join-Path $env:LOCALAPPDATA 'ArkeVoiceLab/pipecat'),
  [int]$Port = 9075,
  [string]$Model = 'github-copilot/claude-haiku-4.5'
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
  & (Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts/python.exe') -u (Join-Path $PSScriptRoot 'app.py') --state $voiceLabState --port $Port --model $Model
} finally {
  $env:UV_PROJECT_ENVIRONMENT = $voiceLabPreviousEnvironment
}
