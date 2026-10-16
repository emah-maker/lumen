// Lumen must not sit in its install folder (plain Node, temp folders only, no Electron).
// Windows keeps every process's current directory open. The Start-menu shortcut starts Lumen with "Start in" = the install folder, so a
// program Lumen starts (Teams from an msteams: link, an opened download, an AI CLI) inherited it, and the update's folder rename failed for
// as long as that program ran (days). Checked here:
//  - leaveInstallDir moves out of the install folder (and only then), on every platform layout;
//  - main.js does it before anything that could start a program;
//  - the spawn helper never lets a child keep a cwd inside the install, and the few direct spawns pass a cwd;
//  - a real child started from a process that sits in a temp "install" does not have it as its cwd;
//  - an update that failed because the install is in use names the programs it found.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const SRC = path.join(__dirname, '..', 'src');
const U = require('../src/ai/cli-utils');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

(async () => {
  // ---- 1. leaveInstallDir ----
  const winExe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\Lumen.exe';
  const winInstall = path.win32.dirname(winExe);
  const run = (cwd, o = {}) => { const moves = []; const to = U.leaveInstallDir({ cwd: () => cwd, chdir: (d) => moves.push(d), execPath: winExe, platform: 'win32', home: () => 'C:\\Users\\u', ...o }); return { to, moves }; };
  let r = run(winInstall);
  check('start-up chdir: a cwd that is the install folder moves to the home folder', r.to === 'C:\\Users\\u' && r.moves.length === 1, JSON.stringify(r));
  r = run(path.win32.join(winInstall, 'resources', 'app'));
  check('start-up chdir: a cwd inside the install folder (a subfolder) moves too', r.moves.length === 1);
  r = run(winInstall.toUpperCase() + '\\');
  check('start-up chdir: case and a trailing slash do not hide the install folder (Windows)', r.moves.length === 1);
  r = run('C:\\Users\\u\\Documents');
  check('start-up chdir: a cwd outside the install folder is left alone', r.moves.length === 0 && r.to === '');
  r = run('C:\\Users\\u\\AppData\\Local\\Programs\\Lumen-other');
  check('start-up chdir: a sibling folder that only shares the name prefix is not the install', r.moves.length === 0);
  r = run(winInstall, { userData: 'C:\\Users\\u\\AppData\\Roaming\\Lumen' });
  check('start-up chdir: userData is preferred when given', r.to === 'C:\\Users\\u\\AppData\\Roaming\\Lumen');
  r = run(winInstall, { userData: path.win32.join(winInstall, 'data') });
  check('start-up chdir: a target inside the install is never chosen (falls to home)', r.to === 'C:\\Users\\u');
  const wrong = []; const t = U.leaveInstallDir({ cwd: () => winInstall, chdir: (d) => { wrong.push(d); if (wrong.length === 1) throw new Error('EPERM'); }, execPath: winExe, platform: 'win32', home: () => 'C:\\Users\\u', userData: 'C:\\gone' });
  check('start-up chdir: a target that cannot be entered falls through to the next', wrong.length === 2 && t === 'C:\\Users\\u', JSON.stringify(wrong));
  const gone = U.leaveInstallDir({ cwd: () => { throw new Error('ENOENT'); }, chdir: () => {}, execPath: winExe, platform: 'win32', home: () => 'C:\\Users\\u' });
  check('start-up chdir: a deleted cwd (process.cwd() throws) is replaced too', gone === 'C:\\Users\\u');
  const mac = '/Applications/Lumen.app/Contents/MacOS/Lumen';
  const macMoves = [];
  U.leaveInstallDir({ cwd: () => '/Applications/Lumen.app/Contents/Resources', chdir: (d) => macMoves.push(d), execPath: mac, platform: 'darwin', home: () => '/Users/u' });
  check('start-up chdir: macOS, a cwd inside the .app bundle (not just the MacOS folder) moves', macMoves.length === 1 && macMoves[0] === '/Users/u', JSON.stringify(macMoves));
  const macStay = [];
  U.leaveInstallDir({ cwd: () => '/Applications', chdir: (d) => macStay.push(d), execPath: mac, platform: 'darwin', home: () => '/Users/u' });
  check('start-up chdir: macOS, /Applications itself is not the bundle', macStay.length === 0);
  const linuxMoves = [];
  U.leaveInstallDir({ cwd: () => '/opt/Lumen', chdir: (d) => linuxMoves.push(d), execPath: '/opt/Lumen/lumen', platform: 'linux', home: () => '/home/u' });
  check('start-up chdir: Linux, the install folder is the exe\'s folder', linuxMoves.length === 1);
  check('an unpackaged run (Electron\'s own exe) does not treat the checkout as the install', !U.insideInstall('C:\\Users\\u\\lumen', 'C:\\x\\node_modules\\electron\\dist\\electron.exe', 'win32'));

  // ---- 2. main.js does it first ----
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const at = main.indexOf('leaveInstallDir()');
  const firstUse = Math.min(...['profile-guard\')', 'automation/launcher', 'features/ai-agents', 'features/instance', "require('./ai/agent')"].map((s) => { const i = main.indexOf(s); return i < 0 ? Infinity : i; }));
  check('main.js leaves the install folder before the profile guard, the launcher, the instance lock or anything else', at > 0 && at < firstUse, `${at} < ${firstUse}`);
  check('main.js adds no new module for it (it uses ai/cli-utils.js, which it loads anyway)', /require\('\.\/ai\/cli-utils'\)\.leaveInstallDir\(\)/.test(main));

  // ---- 3. the spawn helper (each layout read with its own platform's path rules, whatever the host) ----
  const home = os.homedir();
  const layouts = [
    ['win32', 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\Lumen.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen', 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\resources', 'C:\\Users\\u\\Documents'],
    ['linux', '/opt/Lumen/lumen', '/opt/Lumen', '/opt/Lumen/resources', '/home/u/work'],
    ['darwin', '/Applications/Lumen.app/Contents/MacOS/Lumen', '/Applications/Lumen.app/Contents/MacOS', '/Applications/Lumen.app/Contents/Resources', '/Users/u/work'],
  ];
  for (const [platform, execPath, installDir, inside, elsewhere] of layouts) {
    const H = (opts, cwd) => U.hiddenOptions(opts, { execPath, platform, cwd });
    check(`spawn helper (${platform}): no cwd given while in the install folder -> the home folder`, H({}, installDir).cwd === home, H({}, installDir).cwd);
    check(`spawn helper (${platform}): a cwd given inside the install folder -> the home folder`, H({ cwd: inside }, elsewhere).cwd === home, H({ cwd: inside }, elsewhere).cwd);
    check(`spawn helper (${platform}): no cwd given from somewhere else -> still inherits (nothing is changed for a development run)`, H({}, elsewhere).cwd === undefined);
    check(`spawn helper (${platform}): a cwd elsewhere is kept as given`, H({ cwd: elsewhere }, installDir).cwd === elsewhere);
    check(`spawn helper (${platform}): the install folder itself as cwd -> the home folder`, H({ cwd: installDir }, elsewhere).cwd === home);
  }
  const hs = U.hiddenOptions({}, { execPath: layouts[0][1], platform: 'win32', cwd: layouts[0][2] });
  check('spawn helper: it still hides the window, uses no shell and never inherits stdio', hs.windowsHide === true && hs.shell === false && hs.stdio === 'pipe');

  // ---- 4. the direct spawns (outside the helper) pass a cwd ----
  const code = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const callsOf = (text, re) => { const out = []; let m; while ((m = re.exec(text))) { let depth = 0; let i = m.index + m[0].length - 1; const s = i; for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; } out.push(text.slice(s, i + 1)); } return out; };
  for (const f of ['features/swap-helper.js', 'automation/launcher.js', 'automation/mcp.js']) {
    const text = code(f);
    const calls = callsOf(text, /\bspawn\(/g).filter((c) => /process\.execPath|exe|launch\.command/.test(c) && /\{/.test(c));
    check(`${f}: every spawn passes an explicit cwd outside the install`, calls.length > 0 && calls.every((c) => /\bcwd\s*:\s*require\('os'\)\.homedir\(\)/.test(c)), JSON.stringify(calls.map((c) => c.slice(0, 90))));
  }
  const zip = code('features/zip-update.js');
  check('zip-update: the swap helper runs with its own temp folder as cwd', /cwd:\s*h\.dir/.test(zip));
  check('swap helper: the relaunched Lumen starts in the home folder, never the helper\'s temp folder or the install', /cwd:\s*require\('os'\)\.homedir\(\)/.test(code('features/swap-helper.js')));

  // ---- 5. a real child of a process that sits in a (temp) install folder ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cwd-'));
  try {
    const install = path.join(tmp, 'Lumen');
    fs.mkdirSync(install);
    const exe = path.join(install, path.basename(process.execPath));
    fs.copyFileSync(process.execPath, exe); // "Lumen.exe"
    const probe = path.join(tmp, 'probe.js');
    fs.writeFileSync(probe, `const U = require(${JSON.stringify(path.join(SRC, 'ai', 'cli-utils.js'))});
const mode = process.argv[2];
if (mode === 'chdir') { U.leaveInstallDir(); }
const kid = mode === 'raw' ? require('child_process').spawnSync : U.spawnSync;
const r = kid(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { encoding: 'utf8' });
process.stdout.write(JSON.stringify({ own: process.cwd(), kid: String(r.stdout || '') }));
`);
    const go = (mode) => { const o = spawnSync(exe, [probe, mode], { cwd: install, encoding: 'utf8', windowsHide: true, env: { ...process.env } }); try { return JSON.parse(o.stdout); } catch { return { err: `${o.stdout} ${o.stderr} ${o.error}` }; } };
    const real = (d) => { try { return fs.realpathSync.native(d); } catch { return path.resolve(d); } }; // macOS: the temp folder is /var/…, which processes report as /private/var/…
    const inInstall = (d) => d && (same(real(d), real(install)) || real(d).toLowerCase().startsWith(real(install).toLowerCase() + path.sep));
    const chdirRun = go('chdir');
    check('real process in a temp install: leaveInstallDir moves it, and a plain child_process child inherits the new cwd', chdirRun.own && !inInstall(chdirRun.own) && !inInstall(chdirRun.kid), JSON.stringify(chdirRun));
    const helperRun = go('helper');
    check('real process in a temp install: a child started through the spawn helper is not in the install even with no chdir', helperRun.kid && !inInstall(helperRun.kid) && inInstall(helperRun.own), JSON.stringify(helperRun));
    const rawRun = go('raw');
    check('(control) without either, a plain child inherits the install folder as its cwd, which is the bug', inInstall(rawRun.kid), JSON.stringify(rawRun));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* left in this run's own temp */ } }

  // ---- 6. an update that found the install in use names who holds it (the running Lumen does this after the swap helper failed) ----
  const UP = require('../src/features/updates');
  const found = [{ pid: 11, exe: 'C:\\Program Files\\WindowsApps\\MSTeams\\ms-teams.exe' }, { pid: 12, exe: 'D:\\tools\\mytool.exe' }, { pid: 13, exe: 'C:\\Lumen\\Lumen.exe' }, { pid: 99, exe: 'C:\\x\\claude.exe' }];
  const want = 'files were in use (close Microsoft Teams and mytool.exe and try again)';
  check('blockedMessage: a known app is named ("close Microsoft Teams and try again"), an unknown one by its exe; Lumen\'s own copy and our own pid are left out', UP.blockedMessage(found, { self: [99] }) === want, UP.blockedMessage(found, { self: [99] }));
  check('blockedMessage: one known app', UP.blockedMessage([{ pid: 1, exe: 'C:\\a\\ms-teams.exe' }]) === 'files were in use (close Microsoft Teams and try again)');
  check('blockedMessage: nothing found, or only Lumen.exe, gives null (the helper\'s general message stands)', UP.blockedMessage([]) === null && UP.blockedMessage([{ pid: 1, exe: 'C:\\L\\Lumen.exe' }]) === null);
  const ps = [];
  const parsed = await UP.holders('C:\\i', { platform: 'win32', exec: async (file, args, env) => { ps.push({ file, args, env }); return '12\tC:\\i\\ms-teams.exe\r\nnoise\r\n\r\n7\tC:\\i\\x\\y.exe\r\n'; } });
  check('holders: reads the process list (pid and exe) for the folder and skips junk', JSON.stringify(parsed) === JSON.stringify([{ pid: 12, exe: 'C:\\i\\ms-teams.exe' }, { pid: 7, exe: 'C:\\i\\x\\y.exe' }]) && ps[0].env.LUMEN_SWAP_DIR === 'C:\\i', JSON.stringify(ps));
  check('holders: reads no other process\'s memory (only Win32_Process.ExecutablePath)', /Win32_Process/.test(ps[0].args.join(' ')) && !/ReadProcessMemory|OpenProcess|Handle|\.Modules|Get-Process/.test(ps[0].args.join(' ')));
  check('holders: a failing probe is "can\'t tell", not an error; other platforms skip it', (await UP.holders('C:\\i', { platform: 'win32', exec: async () => { throw new Error('no powershell'); } })).length === 0 && (await UP.holders('/x', { platform: 'darwin' })).length === 0);
  // start(): the error the swap helper left is shown at once and refined to name the holder
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cwd-upd-'));
  try {
    fs.writeFileSync(path.join(ud, 'update-error.txt'), 'files were in use (close any other program that runs Lumen, then try again)\n');
    let asked = null;
    process.env.LUMEN_UPDATES_TEST = '1'; // (the module's own switch for a test copy: updates are not disabled)
    const u = UP.createUpdates({ app: { isPackaged: false, getVersion: () => '1.0.0', getPath: () => ud, quit() {}, moveToApplicationsFolder() {} }, ipcMain: { handle() {} }, session: {}, ui: () => null, readSettings: () => ({}), writeSettings() {}, prefs: () => ({}), beforeInstall() {}, test: true, platform: 'win32', holders: async (dir) => { asked = dir; return [{ pid: 5, exe: 'C:\\x\\ms-teams.exe' }]; } });
    u.testHooks.useUpdater(Object.assign(new (require('events'))(), { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) }));
    u.testHooks.stubIo({ exists: () => false, running: async () => false, version: async () => null, versionSync: () => null, home: () => os.homedir(), canWrite: () => false, mkdir() {} });
    u.start();
    const first = u.state().error;
    await new Promise((r) => setTimeout(r, 200));
    check('update start-up: a "files were in use" error from the swap helper is first shown as is, then names the program found in this install folder', /^files were in use/.test(first) && u.state().error === 'files were in use (close Microsoft Teams and try again)' && asked === path.dirname(process.execPath) && !fs.existsSync(path.join(ud, 'update-error.txt')), JSON.stringify({ first, now: u.state().error, asked, status: u.state().status }));
  } finally { delete process.env.LUMEN_UPDATES_TEST; try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* left in this run's own temp */ } }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
