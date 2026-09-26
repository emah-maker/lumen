# Installs the built app for the current user on the local drive: copies the build to
# %LOCALAPPDATA%\Programs\Lumen and adds Desktop + Start menu shortcuts.
# Run after `npm run dist` (which builds into %LOCALAPPDATA%\Lumen\build, off OneDrive). Uninstall: delete that folder and the two shortcuts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$buildDir = if ($env:LUMEN_BUILD_DIR) { $env:LUMEN_BUILD_DIR } else { Join-Path $env:LOCALAPPDATA 'Lumen\build' }
$source = Join-Path $buildDir 'win-unpacked'
$target = Join-Path $env:LOCALAPPDATA 'Programs\Lumen'
if (-not (Test-Path (Join-Path $source 'Lumen.exe'))) { throw "Build first: npm run dist (looked in $source)" }

Get-Process -Name 'Lumen', 'Claude Browser' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item -Recurse $source $target
Copy-Item (Join-Path $root 'assets\icon.ico') (Join-Path $target 'icon.ico')

# The pre-rename install ("Claude Browser") is replaced by this one.
$old = Join-Path $env:LOCALAPPDATA 'Programs\Claude Browser'
if (Test-Path $old) { Remove-Item -Recurse -Force $old }

# The app writes its own shortcuts so they carry its taskbar identity (AppUserModelID) and icon.
Start-Process -FilePath (Join-Path $target 'Lumen.exe') -ArgumentList '--install-shortcuts' -Wait
Write-Host "Installed to $target"
