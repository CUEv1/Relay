# Windows Installer

Run this from PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\installer\install.ps1
```

The installer:

- Checks for Node.js 18 or newer.
- Runs `npm install`.
- Creates `.env` from `.env.example` if `.env` does not exist.
- Creates launcher scripts:
  - `Start-BotDashboard.ps1`
  - `Start Bot Dashboard.bat`
- Runs `npm run check`.

After installing, edit `.env`, then start the bot:

```powershell
.\Start-BotDashboard.ps1
```

To start the bot automatically when the current Windows user logs in:

```powershell
.\installer\enable-startup.ps1
```

To remove the startup task:

```powershell
.\installer\disable-startup.ps1
```

Dashboard URL:

```text
http://127.0.0.1:3000
```

## Build Release EXE

From the project root:

```powershell
.\installer\build-exe.ps1
```

This creates:

```text
dist\RelayInstaller-v<package-version>.exe
```
