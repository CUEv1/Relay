# Release Checklist

Every commit that is released to GitHub must include a fresh Windows installer asset.

1. Update `package.json` and `package-lock.json` to the release version.
2. Run verification:

   ```powershell
   npm run check
   npm audit --omit=dev
   ```

3. Build the installer after all source changes are committed or staged:

   ```powershell
   .\installer\build-exe.ps1
   ```

4. Confirm the generated file matches the package version:

   ```text
   dist\RelayInstaller-v<package-version>.exe
   ```

5. Attach that `.exe` to the GitHub release assets. For example:

   ```powershell
   gh release upload v1.4.0 .\dist\RelayInstaller-v1.4.0.exe --repo CUEv1/Relay --clobber
   ```

Do not publish a release without rebuilding and uploading the installer asset.
