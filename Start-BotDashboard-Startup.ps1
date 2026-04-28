$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$logDir = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDir "startup.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $projectRoot

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}

"[$(Get-Date -Format o)] Starting Twitch Live Discord Bot from $projectRoot" | Add-Content -Path $logPath

try {
  $commandLine = "`"$($npmCommand.Source)`" start 2>&1"
  & cmd.exe /d /s /c $commandLine | Tee-Object -FilePath $logPath -Append
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode) {
    $exitCode = 0
  }

  "[$(Get-Date -Format o)] Bot exited with code $exitCode" | Add-Content -Path $logPath
  exit $exitCode
} catch {
  "[$(Get-Date -Format o)] Startup failed: $($_.Exception.Message)" | Add-Content -Path $logPath
  exit 1
}
