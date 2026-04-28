param(
  [string]$TaskName = "Twitch Live Discord Bot"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Startup task is not installed: $TaskName"
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Startup task removed: $TaskName" -ForegroundColor Green
