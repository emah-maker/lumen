# Installs the built app for the current user: copies dist\win-unpacked to
# %LOCALAPPDATA%\Programs\Claude Browser and adds Desktop + Start menu shortcuts.
# Run after `npm run dist`. Uninstall: delete that folder and the two shortcuts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'dist\win-unpacked'
$target = Join-Path $env:LOCALAPPDATA 'Programs\Claude Browser'
if (-not (Test-Path (Join-Path $source 'Claude Browser.exe'))) { throw "Build first: npm run dist" }

Get-Process -Name 'Claude Browser' -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item -Recurse $source $target
Copy-Item (Join-Path $root 'assets\icon.ico') (Join-Path $target 'icon.ico')

# The app writes its own shortcuts so they carry its taskbar identity (AppUserModelID) and icon.
Start-Process -FilePath (Join-Path $target 'Claude Browser.exe') -ArgumentList '--install-shortcuts' -Wait
Write-Host "Installed to $target"
