param([int]$Port = 9075)
$ErrorActionPreference = 'Stop'
$voiceLabWeb = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$null = Invoke-WebRequest "http://127.0.0.1:$Port/" -WebSession $voiceLabWeb
$null = Invoke-RestMethod "http://127.0.0.1:$Port/api/shutdown" -Method Post -WebSession $voiceLabWeb
Write-Host 'Voice lab is draining its sessions and stopping.'
