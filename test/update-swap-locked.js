// An update must install while another program has a Lumen.exe running from the install folder (plain Node, temp
// folders only, nothing real is swapped, no Electron is started).
// The real case: an AI assistant set up with "Let other apps use Lumen" (Claude Code, Codex, ...) runs
//   <install>\Lumen.exe <install>\resources\app\mcp.js   with ELECTRON_RUN_AS_NODE=1
// for as long as it is open, and Windows won't rename a folder that holds a running exe, so the whole-folder swap
// failed with "files were in use" and the old version came back, every time. This runs the real path with real
// processes: a fake bridge (a copy of node.exe named Lumen.exe) keeps the temp install busy, a fake "Lumen" (another
// copy) calls zip-update.launchSwap and exits, and the detached helper (a copy of the exe running swap-helper.js)
// must swap the install, start the new exe and leave the bridge alone.
// (A copy of node.exe in the install does not block the rename on every Windows; a real Electron exe in Node mode does,
// which is what the bridge is, so the bridge here is a copy of the electron.exe this checkout ships. The precondition check
// below proves the lock is real before the swap is judged.)
// LUMEN_SRC=<checkout> runs the same scenario against another checkout's features/ (to show an older build failing).
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return Boolean(await fn()); };
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const SRC = process.env.LUMEN_SRC ? path.resolve(process.env.LUMEN_SRC) : path.join(__dirname, '..');
const W = (...p) => path.join(...p);

async function scenario(label, { bridge }) {
  const root = fs.mkdtempSync(W(os.tmpdir(), 'lumen-swaplocked-'));
  const apps = W(root, 'Programs');
  const inst = W(apps, 'Lumen');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(W(apps, rel)), { recursive: true }); fs.writeFileSync(W(apps, rel), text); };
  const exeName = 'Lumen.exe';
  // the installed copy and the unpacked update, each with a runnable exe (a copy of node.exe)
  for (const dir of ['Lumen', 'Lumen.update/files']) {
    fs.mkdirSync(W(apps, dir, 'resources', 'app'), { recursive: true });
    fs.copyFileSync(process.execPath, W(apps, dir, exeName));
  }
  put('Lumen/version', 'old'); put('Lumen/resources/app/mcp.js', 'setInterval(() => {}, 1000);'); put('Lumen/Uninstall Lumen.exe', 'u');
  put('Lumen.update/files/version', 'new'); put('Lumen.update/files/resources/app/mcp.js', 'setInterval(() => {}, 1000); // new'); put('Lumen.update/files/Uninstall Lumen.exe', 'u');
  put('Lumen.update/files/resources/app/new-file.js', 'only in the new version');
  fs.writeFileSync(W(apps, 'Lumen.update', 'staged.json'), JSON.stringify({ version: '9.9.9', sha512: 'x', root: 'files' }));

  // a relaunched Lumen (the new exe started with no script) leaves a mark, through NODE_OPTIONS
  const mark = W(root, 'started.txt');
  const marker = W(root, 'marker.js');
  fs.writeFileSync(marker, `if (!process.argv[1]) require('fs').writeFileSync(${JSON.stringify(mark)}, process.execPath + '\\n' + require('fs').readFileSync(${JSON.stringify(W(inst, 'version'))}, 'utf8'));`);
  fs.mkdirSync(W(root, 'tmp'));
  // (the helper copy goes into TEMP, and prepareHelper clears older ones there: this run's own TEMP, never the real one)
  const env = { ...process.env, TEMP: W(root, 'tmp'), TMP: W(root, 'tmp'), NODE_OPTIONS: `--require ${marker.replace(/\\/g, '/')}` };

  let bridgeProc = null;
  if (bridge) {
    // (electron.exe and the files it needs beside it, in a folder of the install)
    const dist = path.dirname(require('electron'));
    fs.mkdirSync(W(inst, 'bridge'));
    for (const f of fs.readdirSync(dist, { withFileTypes: true })) if (f.isFile() && !/^LICENSE/.test(f.name)) fs.copyFileSync(W(dist, f.name), W(inst, 'bridge', f.name));
    const bridgeExe = W(inst, 'bridge', 'electron.exe');
    bridgeProc = spawn(bridgeExe, [W(inst, 'resources', 'app', 'mcp.js')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: root }); // (Electron's Node mode refuses NODE_OPTIONS)
    await sleep(2000);
  }
  let wholeFolderRenameBlocked = null;
  if (bridge) {
    try { fs.renameSync(inst, W(apps, 'probe')); fs.renameSync(W(apps, 'probe'), inst); wholeFolderRenameBlocked = false; } catch { wholeFolderRenameBlocked = true; }
  }

  // the "Lumen" that is quitting: starts the swap exactly as updates.js applyOnQuit does, then exits
  const errFile = W(root, 'update-error.txt');
  const app = W(root, 'app.js');
  fs.writeFileSync(app, `
    const Z = require(${JSON.stringify(W(SRC, 'src', 'features', 'zip-update.js'))});
    const paths = Z.swapPaths(process.execPath);
    const staged = Z.readStaged(process.execPath, process.platform, () => null);
    Z.launchSwap({ staged: staged.staged, execPath: process.execPath, errFile: ${JSON.stringify(errFile)}, relaunch: true });
  `);
  const quitter = spawn(W(inst, exeName), [app], { stdio: 'ignore', windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: root });
  await new Promise((r) => quitter.on('exit', r));
  const done = await waitFor(() => fs.existsSync(mark) || fs.existsSync(errFile) || fs.existsSync(W(inst, 'version')) && fs.readFileSync(W(inst, 'version'), 'utf8') === 'new', 30e3);
  await waitFor(() => fs.existsSync(mark) || fs.existsSync(errFile), 8e3);
  const ver = () => { try { return fs.readFileSync(W(inst, 'version'), 'utf8'); } catch { return null; } };
  const out = {
    done, version: ver(), relaunched: fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : null,
    err: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').trim() : null,
    newFile: fs.existsSync(W(inst, 'resources', 'app', 'new-file.js')),
    uninstaller: fs.existsSync(W(inst, 'Uninstall Lumen.exe')),
    bridgeAlive: bridgeProc ? alive(bridgeProc.pid) : null,
    wholeFolderRenameBlocked,
    stagingGone: !fs.existsSync(W(apps, 'Lumen.update')),
    siblings: fs.readdirSync(apps),
  };
  if (bridgeProc) { try { process.kill(bridgeProc.pid); } catch {} await sleep(500); }
  await sleep(1500); // (the helper deletes the old install after starting the new one)
  out.siblingsAfter = fs.readdirSync(apps);
  // (the old install holds the bridge's exe, which can't be deleted while it ran: the next start of Lumen clears it)
  await require(W(SRC, 'src', 'features', 'zip-update.js')).clearOld?.(W(inst, exeName));
  out.siblingsCleared = fs.readdirSync(apps);
  rm(root);
  console.log(`  [${label}] ${JSON.stringify(out)}`);
  return out;
}

(async () => {
  const quiet = await scenario('nothing running from the install', { bridge: false });
  check('no bridge: the install is swapped and the new exe is started', quiet.version === 'new' && quiet.relaunched?.endsWith('new') && !quiet.err, JSON.stringify(quiet));

  const busy = await scenario('a bridge runs Lumen.exe from the install', { bridge: true });
  check('precondition: renaming the install folder is refused while a bridge runs from it (what broke every update)', busy.wholeFolderRenameBlocked === true, JSON.stringify(busy));
  check('bridge running: no error file, the old version is not kept', busy.err === null && busy.version === 'new', JSON.stringify(busy));
  check('bridge running: the new exe is started after the swap', Boolean(busy.relaunched) && busy.relaunched.endsWith('new'), JSON.stringify(busy));
  check('bridge running: new files are in place, the uninstaller came along', busy.newFile && busy.uninstaller, JSON.stringify(busy));
  check('bridge running: the bridge itself is left running', busy.bridgeAlive === true, JSON.stringify(busy));
  check('bridge running: the old install is cleared by the next start, once the bridge has ended', busy.siblingsCleared.join() === 'Lumen', JSON.stringify(busy));

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})();
