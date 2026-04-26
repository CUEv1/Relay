$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $projectRoot "dist"
$buildDir = Join-Path $distDir "installer-build"
$payloadRoot = Join-Path $buildDir "RelayBot"
$payloadZip = Join-Path $buildDir "payload.zip"
$sedPath = Join-Path $buildDir "relay-installer.sed"
$exePath = Join-Path $distDir "RelayInstaller-v1.1.exe"

function Copy-ProjectItem {
  param([string]$RelativePath)

  $source = Join-Path $projectRoot $RelativePath
  $destination = Join-Path $payloadRoot $RelativePath
  $destinationParent = Split-Path $destination -Parent
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  Copy-Item -Path $source -Destination $destination -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path $buildDir) {
  Remove-Item -LiteralPath $buildDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

Copy-ProjectItem ".env.example"
Copy-ProjectItem ".gitignore"
Copy-ProjectItem "README.md"
Copy-ProjectItem "getToken.js"
Copy-ProjectItem "package-lock.json"
Copy-ProjectItem "package.json"
Copy-ProjectItem "public"
Copy-ProjectItem "src"
Copy-ProjectItem "installer\INSTALL.md"
Copy-ProjectItem "installer\install.ps1"

Compress-Archive -Path $payloadRoot -DestinationPath $payloadZip -Force
Copy-Item -Path (Join-Path $PSScriptRoot "bootstrap.ps1") -Destination (Join-Path $buildDir "bootstrap.ps1") -Force

@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$exePath
FriendlyName=Relay Bot Dashboard Installer
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1
UserQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1
SourceFiles=SourceFiles
[Strings]
FILE0=bootstrap.ps1
FILE1=payload.zip
[SourceFiles]
SourceFiles0=$buildDir
[SourceFiles0]
%FILE0%=
%FILE1%=
"@ | Set-Content -Path $sedPath -Encoding ASCII

& "$env:WINDIR\System32\iexpress.exe" /N /Q $sedPath

for ($attempt = 0; $attempt -lt 20 -and -not (Test-Path $exePath); $attempt++) {
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $exePath)) {
  throw "IExpress did not create $exePath"
}

Get-Item $exePath
