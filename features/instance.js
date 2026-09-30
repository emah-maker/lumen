// One running copy per profile, and the installer's shortcuts. Split out of main.js.
const fs = require('fs');
const path = require('path');

// Lumen.exe is Electron's unmodified binary (scripts/build.js), so its own icon is Electron's: every
// place Windows shows Lumen's icon has to be pointed at an .ico instead. The app's own assets/icon.ico
// first: every build and every update ships it at the same place. The icon.ico that
// scripts/install-windows.ps1 puts next to the exe is not in the release zip, so an update's swap
// deleted it and left the shortcuts pointing at nothing (Windows then shows the exe's, Electron's).
function appIcon() {
  const own = path.join(__dirname, '..', 'assets', 'icon.ico');
  const installed = path.join(path.dirname(process.execPath), 'icon.ico');
  return fs.existsSync(own) || !fs.existsSync(installed) ? own : installed;
}

// Explorer's "Open with", Default apps and the like name a program by its exe's description, which for
// Electron's binary is "Electron". Windows takes a FriendlyAppName from the registry over it (per user,
// no admin), and caches the description it read in MuiCache: set both to Lumen. Runs at startup,
// in the background.
function fixAppName(app) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = process.execPath;
  const values = [
    [`HKCU\\Software\\Classes\\Applications\\${path.basename(exe)}`, 'FriendlyAppName'],
    ['HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache', `${exe}.FriendlyAppName`],
  ];
  const { execFile } = require('child_process');
  for (const [key, name] of values) execFile('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', 'Lumen', '/f'], { windowsHide: true, timeout: 8000 }, () => {});
}

// Per-user paths (what `--install-shortcuts` writes to) plus the all-users equivalents: a
// perMachine NSIS install (e.g. into Program Files) puts its shortcuts in the machine-wide
// Desktop/Start Menu instead, which the per-user-only paths never reached — leaving a shortcut
// stuck on Lumen.exe's own icon (Electron's) forever. Dirs this process can't see or write to
// (missing env var, no permission) are silently skipped by their callers.
const shortcutDirs = (app) => [
  app.getPath('desktop'),
  path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  // Pinned to the taskbar: Windows keeps its own copy of the shortcut here, and draws the pinned
  // button from it (not from the running window), so a stale icon here is the one on the taskbar.
  path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ...(process.env.PUBLIC ? [path.join(process.env.PUBLIC, 'Desktop')] : []),
  ...(process.env.ProgramData ? [path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')] : []),
];

// `Lumen.exe --install-shortcuts` (run by scripts/install-windows.ps1) writes Desktop and
// Start menu shortcuts carrying the app ID and icon, then exits.
function installShortcuts(app, shell, appId) {
  const exe = process.execPath;
  const options = { target: exe, cwd: path.dirname(exe), icon: appIcon(), iconIndex: 0, appUserModelId: appId, description: 'Lumen, the AI browser' };
  for (const dir of shortcutDirs(app).filter((d) => !/User Pinned/i.test(d))) { // pinning is the user's choice
    shell.writeShortcutLink(path.join(dir, 'Lumen.lnk'), 'create', options);
    fs.rmSync(path.join(dir, 'Claude Browser.lnk'), { force: true }); // the shortcut from before the rename
  }
}

// The .lnk files in a folder and in its direct subfolders (Start menu groups such as Programs\Lumen).
function shortcutsIn(dir) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && /\.lnk$/i.test(entry.name)) found.push(file);
    else if (entry.isDirectory()) {
      try {
        for (const sub of fs.readdirSync(file, { withFileTypes: true })) {
          if (sub.isFile() && /\.lnk$/i.test(sub.name)) found.push(path.join(file, sub.name));
        }
      } catch {}
    }
  }
  return found;
}

// Shortcuts to Lumen.exe show its own icon (Electron's) unless they name another one: the setup
// installer's do, and so can one made by hand or left from an old install under another name
// (a stray Electron.lnk with Lumen's app ID put Electron's icon on the taskbar). Point every
// shortcut to this exe on the Desktop or in the Start menu at Lumen's icon. Runs at startup; a
// no-op once they're right. A shortcut naming an .ico that no longer exists (an update removed it)
// counts as wrong too.
function fixShortcutIcons(app, shell, exists = fs.existsSync) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = path.resolve(process.execPath).toLowerCase();
  for (const dir of shortcutDirs(app)) {
    for (const file of shortcutsIn(dir)) {
      try {
        const link = shell.readShortcutLink(file);
        const icon = String(link.icon || '').replace(/,\s*-?\d+$/, '');
        if (path.resolve(link.target || '').toLowerCase() !== exe || (/\.ico$/i.test(icon) && exists(icon))) continue;
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

module.exports = { appIcon, fixAppName, installShortcuts, fixShortcutIcons, acquireInstanceLock, listenForSecondInstances };
