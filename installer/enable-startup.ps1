param(
  [string]$TaskName = "Twitch Live Discord Bot"
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$launcherPath = Join-Path $projectRoot "Start-BotDashboard-Startup.ps1"

if (-not (Test-Path $launcherPath)) {
  throw "Startup launcher was not found: $launcherPath"
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""

$action = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument $arguments `
  -WorkingDirectory $projectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Starts the Twitch Live Discord Bot dashboard when $currentUser logs in." `
  -Force | Out-Null

Write-Host "Startup task installed: $TaskName" -ForegroundColor Green
Write-Host "User: $currentUser"
Write-Host "Launcher: $launcherPath"
Write-Host "Log file: $(Join-Path $projectRoot "logs\startup.log")"
