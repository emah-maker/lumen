// One running copy per profile, and the installer's shortcuts. Split out of main.js.
const fs = require('fs');
const path = require('path');

// Lumen.exe is Electron's unmodified binary (scripts/build/build.js), so its own icon is Electron's: every
// place Windows shows Lumen's icon has to be pointed at an .ico instead. The app's own assets/icon.ico
// first: every build and every update ships it at the same place. The icon.ico that
// scripts/build/install-windows.ps1 puts next to the exe is not in the release zip, so an update's swap
// deleted it and left the shortcuts pointing at nothing (Windows then shows the exe's, Electron's).
// The installed Lumen, not the stock electron binary with app.isPackaged made true (test/e2e/hardening.js does that to check a
// packaged run ignores test switches): only the real exe may write the user's registry, shortcuts and taskbar entries.
const isInstalledExe = () => !/^electron(\.exe)?$/i.test(path.basename(process.execPath));

function appIcon() {
  const own = path.join(__dirname, '..', 'assets', 'icon.ico');
  const installed = path.join(path.dirname(process.execPath), 'icon.ico');
  return fs.existsSync(own) || !fs.existsSync(installed) ? own : installed;
}

// Explorer's "Open with", Default apps and the like name a program by its exe's description, which for
// Electron's binary is "Electron". Windows takes a FriendlyAppName from the registry over it (per user,
// no admin), and caches the description it read in MuiCache: set both to Lumen. Runs at startup,
// in the background.
// Notifications are named and drawn from the app ID's own registry entry (AppUserModelId\<id>: DisplayName, IconUri) when
// there is one; without it Windows fell back to the exe's description, so a finished chat's notification said "Electron".
function fixAppName(app, appId = 'com.lumen.browser') {
  if (process.platform !== 'win32' || !app.isPackaged || !isInstalledExe()) return;
  const values = appNameValues(process.execPath, appId, appIcon());
  const { execFile } = require('../ai/cli-utils');
  for (const [key, name, data] of values) execFile('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true, timeout: 8000 }, () => {});
}
// [key, value name, data] for fixAppName: pure, for the tests.
function appNameValues(exe, appId, icon) {
  return [
    [`HKCU\\Software\\Classes\\Applications\\${path.basename(exe)}`, 'FriendlyAppName', 'Lumen'],
    ['HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache', `${exe}.FriendlyAppName`, 'Lumen'],
    [`HKCU\\Software\\Classes\\AppUserModelId\\${appId}`, 'DisplayName', 'Lumen'],
    [`HKCU\\Software\\Classes\\AppUserModelId\\${appId}`, 'IconUri', icon],
  ];
}

// File types Lumen is associated with (package.json build.fileAssociations names, test/units/assoc-icons-units.js keeps them
// in step) and the ProgID setup.js registers. The installer writes each one's DefaultIcon as Lumen.exe,0, which
// is Electron's atom: the exe is deliberately left untouched (Smart App Control), so Explorer showed that atom on every
// PDF, HTML and SVG file Lumen opens. Point each at the shipped .ico instead.
const ASSOCIATION_PROG_IDS = ['HTML Document', 'PDF Document', 'SVG Image', 'Email Message', 'LumenHTML'];

// `reg query <key> /ve` output -> the default value's data, or null.
const regDefault = (out) => { const m = /\((?:Default)\)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m.exec(String(out || '')) || /<NO NAME>\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m.exec(String(out || '')); return m ? m[1] : null; };

// Rewrites DefaultIcon of every ProgID whose open command runs this exe (never someone else's: Chrome's PDF
// handler keeps its own) when it is not already `icon`. Resolves to the ProgIDs it changed. `run(args)` is `reg`
// with the output (null on failure), injectable for tests.
async function fixAssociationIcons(exe, icon, run) {
  const changed = [];
  const classes = 'HKCU\\Software\\Classes\\';
  for (const id of ASSOCIATION_PROG_IDS) {
    const command = regDefault(await run(['query', `${classes}${id}\\shell\\open\\command`, '/ve']));
    if (!command || !command.toLowerCase().includes(path.win32.resolve(exe).toLowerCase())) continue;
    const key = `${classes}${id}\\DefaultIcon`;
    if (regDefault(await run(['query', key, '/ve'])) === icon) continue;
    if ((await run(['add', key, '/ve', '/t', 'REG_SZ', '/d', icon, '/f'])) !== null) changed.push(id);
  }
  return changed;
}

// Tell Explorer to redraw file icons (SHChangeNotify(SHCNE_ASSOCCHANGED)); without it the old icon stays until the
// icon cache is rebuilt. Called only after fixAssociationIcons changed something, so once per update.
function notifyAssociationsChanged(execFile = require('../ai/cli-utils').execFile) {
  const script = "Add-Type -Namespace Lumen -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'; [Lumen.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, () => {});
}

// Startup, installed exe only (never dev or test electron.exe, #450): background, silent on any failure.
function fixAssociationIconsAtStartup(app) {
  if (process.platform !== 'win32' || !app.isPackaged || !isInstalledExe()) return Promise.resolve([]);
  const { execFile } = require('../ai/cli-utils');
  const run = (args) => new Promise((resolve) => execFile('reg.exe', args, { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : String(out))));
  return fixAssociationIcons(process.execPath, appIcon(), run)
    .then((changed) => { if (changed.length) notifyAssociationsChanged(); return changed; })
    .catch(() => []);
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

// `Lumen.exe --install-shortcuts` (run by scripts/build/install-windows.ps1) writes Desktop and
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
function fixShortcutIcons(app, shell, exists = fs.existsSync, appId = null) {
  if (process.platform !== 'win32' || !app.isPackaged || !isInstalledExe()) return;
  const exe = path.resolve(process.execPath).toLowerCase();
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs').toLowerCase();
  const ownLumenLnk = (f) => { try { return exists(f) && path.resolve(shell.readShortcutLink(f).target || '').toLowerCase() === exe; } catch { return false; } }; // (this install's own Lumen.lnk, not another copy's)
  for (const dir of shortcutDirs(app)) {
    for (const file of shortcutsIn(dir)) {
      try {
        const link = shell.readShortcutLink(file);
        if (path.resolve(link.target || '').toLowerCase() !== exe) continue;
        // A Start menu "Electron.lnk" to this exe (left by an old build) next to this install's Lumen.lnk is removed, not repaired: with Lumen's app ID it named
        // Lumen "Electron" in Start and search (Windows picks one shortcut's name per app ID). Only in the user's own Start menu, never a pin or the desktop.
        if (path.basename(file).toLowerCase() === 'electron.lnk' && path.dirname(file).toLowerCase() === startMenu && ownLumenLnk(path.join(path.dirname(file), 'Lumen.lnk'))) { fs.rmSync(file, { force: true }); continue; }
        const icon = String(link.icon || '').replace(/,s*-?d+$/, '');
        const fix = {};
        if (!(/.ico$/i.test(icon) && exists(icon))) Object.assign(fix, { icon: appIcon(), iconIndex: 0 });
        if (appId && link.appUserModelId !== appId) fix.appUserModelId = appId; // see ensureStartMenuShortcut
        if (Object.keys(fix).length) shell.writeShortcutLink(file, 'update', fix);
      } catch {} // someone else's shortcut, or one we can't read: leave it
    }
  }
}

// A toast is named and drawn from the Start menu shortcut that carries the same AppUserModelID as the process
// (app.setAppUserModelId). Lumen.exe is Electron's unmodified binary, so with no such shortcut Windows falls back to
// the exe's own description, "Electron" (and Electron's icon). The installer's shortcut can lack the ID (an older
// install, an updated-in-place or unzipped copy, a shortcut remade by hand), so at startup the Start menu's own
// Lumen.lnk is made, or given the ID if it is missing it. A shortcut to some other Lumen.exe is left alone.
function ensureStartMenuShortcut(app, shell, appId) {
  if (process.platform !== 'win32' || !app.isPackaged || !isInstalledExe()) return false;
  const exe = process.execPath;
  const file = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Lumen.lnk');
  const want = { target: exe, cwd: path.dirname(exe), icon: appIcon(), iconIndex: 0, appUserModelId: appId, description: 'Lumen, the AI browser' };
  try {
    let link = null;
    try { link = fs.existsSync(file) ? shell.readShortcutLink(file) : null; } catch { return false; }
    if (!link) { shell.writeShortcutLink(file, 'create', want); return true; }
    if (path.resolve(link.target || '').toLowerCase() !== path.resolve(exe).toLowerCase()) return false;
    if (link.appUserModelId === appId) return false;
    shell.writeShortcutLink(file, 'update', { appUserModelId: appId });
    return true;
  } catch { return false; }
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
    require('../ai/cli-utils').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false; // a live instance exists (exit 3) or cleanup failed
  }
}

const pipePath = (app) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\lumen-${require('crypto').createHash('sha1').update(app.getPath('userData')).digest('hex').slice(0, 12)}`
  : path.join(app.getPath('userData'), 'instance.sock'));

// Is a live instance listening on this profile's pipe? Asks it to focus itself and waits for its answer:
// 'live' (it focused: nothing more to do), 'quitting' (it answered that it is shutting down: wait for it, then take over)
// 'busy' (connected, no answer yet: a busy instance, one from before the answer existed, or one whose main thread is stuck
// while it quits) or 'none' (nothing listens).
const PING_EXIT = { 0: 'live', 2: 'quitting', 3: 'busy' };
const pingResult = (code) => PING_EXIT[code] || 'none';
function pingRunningInstance(app) {
  if (process.platform !== 'win32') return 'none';
  const { spawnSync } = require('../ai/cli-utils');
  // A tiny synchronous probe. The timers are generous: under CPU load a live instance can take a second to answer, and a ping
  // that gave up early used to read as "nobody there".
  const probe = `const s=require('net').connect(${JSON.stringify(pipePath(app))});let t;
s.on('connect',()=>{s.write('focus');t=setTimeout(()=>process.exit(3),1500)});
s.on('data',(d)=>process.exit(/^bye/.test(String(d))?2:0));
s.on('error',()=>process.exit(1));setTimeout(()=>{if(!t)process.exit(1)},1500)`;
  const run = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 6000, windowsHide: true });
  return run.error ? 'none' : pingResult(run.status);
}

// A second copy pings the pipe; `focus` brings this window forward and the copy gets "ok". An instance that is quitting answers
// "bye" instead, so the newcomer waits for it rather than leaving (isQuitting). The pipe of an instance that has just exited can
// still be held for a moment while the next one starts: keep trying to listen on it for `retryMs`.
function listenForSecondInstances(app, focus, { isQuitting = () => false, retryMs = 10000 } = {}) {
  if (process.platform !== 'win32') return null;
  const giveUp = Date.now() + retryMs;
  const server = require('net').createServer((socket) => {
    let answered = false;
    socket.on('data', () => {
      if (answered) return;
      answered = true;
      if (isQuitting()) { socket.end('bye'); return; }
      try { focus(); } catch {}
      socket.end('ok');
    });
    socket.on('error', () => {});
  });
  const listen = () => server.listen(pipePath(app));
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && Date.now() < giveUp) setTimeout(listen, 200).unref?.();
  });
  listen();
  return server;
}

// What a second launch does while the profile's lock is taken. Pure (the callbacks do the work) so the tests can drive it:
//   'acquired'   the lock is ours (the holder is gone or finished quitting): start up
//   'handed-off' a live instance answered and brought its window forward (or took the ping and never answered): this one can leave
//   'timeout'    nothing live answers and the lock is still held after budgetMs: the caller must say so, not vanish
// A holder that is quitting, or that only its leftover child processes keep alive (reclaim stops those), is waited for.
function takeOverLock({ tryLock, ping, reclaim, wait, now = Date.now, budgetMs = 15000, stepMs = 200, reclaimEveryMs = 2000 }) {
  const deadline = now() + budgetMs;
  let lastReclaim = -Infinity;
  let lastAnswer = null;
  for (;;) {
    if (tryLock()) return 'acquired';
    const answer = ping();
    if (answer === 'live') return 'handed-off';
    lastAnswer = answer;
    if (answer === 'none' && now() - lastReclaim >= reclaimEveryMs) { lastReclaim = now(); reclaim(); } // (no instance answers: leftovers of a dead one may hold the lock)
    if (tryLock()) return 'acquired';
    if (now() >= deadline) return lastAnswer === 'busy' ? 'handed-off' : 'timeout'; // (a silent instance that holds on got our ping: it is running, just slow)
    wait(stepMs);
  }
}

function acquireInstanceLock(app) {
  if (app.requestSingleInstanceLock()) return true;
  if (require('../test-mode').isTest() && !process.env.CLAUDE_BROWSER_PROFILE) return false;
  if (require('./taskbar-tasks').wantsCloseAiTabs(process.argv)) return false; // the taskbar's command: the running instance got it through 'second-instance'; the ping below would bring its window forward
  const outcome = takeOverLock({
    tryLock: () => app.requestSingleInstanceLock(),
    ping: () => pingRunningInstance(app),
    reclaim: reclaimProfileLock,
    wait: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  });
  if (outcome === 'timeout') tellStuck();
  return outcome === 'acquired';
}

// Never leave without a word: the other Lumen did not answer and did not let go.
function tellStuck() {
  const message = 'Lumen is still closing from the last time you used it. Wait a few seconds and open it again; if this keeps happening, end Lumen in Task Manager.';
  console.error('[lumen] ' + message);
  if (require('../test-mode').isTest()) return;
  try { require('electron').dialog.showErrorBox('Lumen did not start', message); } catch {}
}

module.exports = { isInstalledExe, appIcon, ASSOCIATION_PROG_IDS, fixAssociationIcons, fixAssociationIconsAtStartup, notifyAssociationsChanged, regDefault, fixAppName, appNameValues, installShortcuts, fixShortcutIcons, ensureStartMenuShortcut, acquireInstanceLock, listenForSecondInstances, takeOverLock, pingResult };
