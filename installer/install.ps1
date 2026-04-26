param(
  [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

Write-Step "Checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js was not found. Install Node.js 18 or newer from https://nodejs.org, then run this installer again."
}

$nodeVersionText = (& node --version).Trim()
$nodeMajor = [int]($nodeVersionText.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 18) {
  throw "Node.js $nodeVersionText is installed, but this bot requires Node.js 18 or newer."
}
Write-Host "Node.js $nodeVersionText found."

Write-Step "Checking npm"
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  throw "npm was not found. Reinstall Node.js with npm included, then run this installer again."
}

if (-not $SkipDependencyInstall) {
  Write-Step "Installing dependencies"
  & npm install
}

Write-Step "Preparing environment file"
$envPath = Join-Path $projectRoot ".env"
$envExamplePath = Join-Path $projectRoot ".env.example"
if (-not (Test-Path $envPath)) {
  Copy-Item -Path $envExamplePath -Destination $envPath
  Write-Host ".env created from .env.example."
} else {
  Write-Host ".env already exists; leaving it unchanged."
}

Write-Step "Writing launcher scripts"
$startBat = Join-Path $projectRoot "Start Bot Dashboard.bat"
$startPs1 = Join-Path $projectRoot "Start-BotDashboard.ps1"

@"
@echo off
cd /d "%~dp0"
npm start
pause
"@ | Set-Content -Path $startBat -Encoding ASCII

@"
`$ErrorActionPreference = "Stop"
Set-Location `$PSScriptRoot
npm start
"@ | Set-Content -Path $startPs1 -Encoding ASCII

Write-Step "Running syntax check"
& npm run check

Write-Host ""
Write-Host "Install complete." -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "1. Edit .env and add your DISCORD_TOKEN, TWITCH_ACCESS_TOKEN, DASHBOARD_PASSWORD, and SESSION_SECRET."
Write-Host "2. Start the bot with: .\Start-BotDashboard.ps1"
Write-Host "3. Open: http://127.0.0.1:3000"
