$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

$installDir = Join-Path $env:LOCALAPPDATA "RelayBot"
$payloadZip = Join-Path $PSScriptRoot "payload.zip"
$unpackDir = Join-Path $env:TEMP ("RelayBotPayload-" + [guid]::NewGuid().ToString("N"))

if (-not (Test-Path $payloadZip)) {
  throw "Installer payload was not found next to the bootstrap script."
}

Write-Step "Checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js was not found. Install Node.js 18 or newer from https://nodejs.org, then run this installer again."
}

$nodeVersionText = (& node --version).Trim()
$nodeMajor = [int]($nodeVersionText.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 18) {
  throw "Node.js $nodeVersionText is installed, but Relay requires Node.js 18 or newer."
}

Write-Step "Installing Relay Bot Dashboard"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $unpackDir | Out-Null
Expand-Archive -Path $payloadZip -DestinationPath $unpackDir -Force

$payloadRoot = Join-Path $unpackDir "RelayBot"
if (-not (Test-Path $payloadRoot)) {
  throw "Installer payload is invalid."
}

Copy-Item -Path (Join-Path $payloadRoot "*") -Destination $installDir -Recurse -Force

Write-Step "Preparing environment"
$envPath = Join-Path $installDir ".env"
$envExamplePath = Join-Path $installDir ".env.example"
if (-not (Test-Path $envPath)) {
  Copy-Item -Path $envExamplePath -Destination $envPath
  Write-Host ".env created. Edit it before starting the bot."
} else {
  Write-Host ".env already exists; preserving it."
}

Write-Step "Installing dependencies"
Set-Location $installDir
& npm install

Write-Step "Creating launchers"
$startPs1 = Join-Path $installDir "Start-RelayBot.ps1"
$startBat = Join-Path $installDir "Start Relay Bot.bat"

@"
`$ErrorActionPreference = "Stop"
Set-Location `$PSScriptRoot
npm start
"@ | Set-Content -Path $startPs1 -Encoding ASCII

@"
@echo off
cd /d "%~dp0"
npm start
pause
"@ | Set-Content -Path $startBat -Encoding ASCII

$desktop = [Environment]::GetFolderPath("Desktop")
if ($desktop) {
  $shortcutPath = Join-Path $desktop "Relay Bot Dashboard.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $startBat
  $shortcut.WorkingDirectory = $installDir
  $shortcut.Save()
}

Write-Step "Running syntax check"
& npm run check

Remove-Item -LiteralPath $unpackDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Relay Bot Dashboard installed to: $installDir" -ForegroundColor Green
Write-Host "Edit this file before starting: $envPath"
Write-Host "Start with: $startBat"
Write-Host "Dashboard URL: http://127.0.0.1:3000"
Read-Host "Press Enter to close"
