// One running copy per profile, and the installer's shortcuts. Split out of main.js.
const fs = require('fs');
const path = require('path');

// Lumen.exe is Electron's unmodified binary (scripts/build.js), so its own icon is Electron's: every
// place Windows shows Lumen's icon has to be pointed at an .ico instead. The installed copy's
// icon.ico (scripts/install-windows.ps1) or, in the setup installer's copy, the app's own.
function appIcon() {
  const installed = path.join(path.dirname(process.execPath), 'icon.ico');
  return fs.existsSync(installed) ? installed : path.join(__dirname, '..', 'assets', 'icon.ico');
}

const shortcutDirs = (app) => [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];

// `Lumen.exe --install-shortcuts` (run by scripts/install-windows.ps1) writes Desktop and
// Start menu shortcuts carrying the app ID and icon, then exits.
function installShortcuts(app, shell, appId) {
  const exe = process.execPath;
  const options = { target: exe, cwd: path.dirname(exe), icon: appIcon(), iconIndex: 0, appUserModelId: appId, description: 'Lumen, the AI browser' };
  for (const dir of shortcutDirs(app)) {
    shell.writeShortcutLink(path.join(dir, 'Lumen.lnk'), 'create', options);
    fs.rmSync(path.join(dir, 'Claude Browser.lnk'), { force: true }); // the shortcut from before the rename
  }
}

// The setup installer's shortcuts take their icon from Lumen.exe (Electron's): point any shortcut
// to this exe that still does at Lumen's icon. Runs at startup; a no-op once they're right.
function fixShortcutIcons(app, shell) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = path.resolve(process.execPath).toLowerCase();
  for (const dir of shortcutDirs(app)) {
    for (const file of [path.join(dir, 'Lumen.lnk'), path.join(dir, 'Lumen', 'Lumen.lnk')]) {
      try {
        if (!fs.existsSync(file)) continue;
        const link = shell.readShortcutLink(file);
        if (path.resolve(link.target || '').toLowerCase() !== exe || /\.ico$/i.test(link.icon || '')) continue;
        shell.writeShortcutLink(file, 'update', { icon: appIcon(), iconIndex: 0 });
      } catch {} // someone else's shortcut, or one we can't read: leave it
    }
  }
}

// If the lock is held but no main process for this app is alive, it belongs to child processes
// of an instance that crashed or was killed. Stop those orphans and try again.
function reclaimProfileLock() {
  if (process.platform !== 'win32') return false;
  const exe = process.execPath.replace(/'/g, "''");
  const script = [
    `$exe = '${exe}'`,
    '$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe -and $_.ProcessId -ne ' + process.pid + ' })',
    "$main = @($procs | Where-Object { $_.CommandLine -notmatch '--type=' })",
    'if ($main.Count -gt 0) { exit 3 }',
    "$procs | Where-Object { $_.CommandLine -match '--type=' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    'exit 0',
  ].join('; ');
  try {
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false; // a live instance exists (exit 3) or cleanup failed
  }
}

const pipePath = (app) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\lumen-${require('crypto').createHash('sha1').update(app.getPath('userData')).digest('hex').slice(0, 12)}`
  : path.join(app.getPath('userData'), 'instance.sock'));

// Is a live instance listening on this profile's pipe? (It focuses itself when we connect.)
function pingRunningInstance(app) {
  if (process.platform !== 'win32') return false;
  const { execFileSync } = require('child_process');
  try {
    // A tiny synchronous probe: exit 0 if the pipe accepts a connection within 250 ms.
    execFileSync(process.execPath, ['-e', `const s=require('net').connect(${JSON.stringify(pipePath(app))});s.on('connect',()=>{s.end('focus');process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),250)`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 2000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// A second copy pings the pipe; `focus` brings this window forward.
function listenForSecondInstances(app, focus) {
  if (process.platform !== 'win32') return;
  require('net').createServer((socket) => {
    socket.on('data', focus);
    socket.on('error', () => {});
  }).on('error', () => {}).listen(pipePath(app));
}

function acquireInstanceLock(app) {
  if (app.requestSingleInstanceLock()) return true;
  if (require('../test-mode').isTest() && !process.env.CLAUDE_BROWSER_PROFILE) return false;
  if (pingRunningInstance(app)) return false; // a live instance answered and brought itself forward
  if (!reclaimProfileLock()) return false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (app.requestSingleInstanceLock()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return false;
}

module.exports = { appIcon, installShortcuts, fixShortcutIcons, acquireInstanceLock, listenForSecondInstances };
