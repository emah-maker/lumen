// ---------- updates: new versions from the GitHub Releases of emah-maker/lumen ----------
// One mechanism for every copy that can write to its own install location: download this
// platform's release zip in the app ("Downloading vX…"), check its sha512 against the entry that
// latest.yml / latest-mac.yml lists for it, unpack it next to the install, then "Restart to update"
// swaps the folders (features/zip-update.js: Windows runs a byte-identical copy of the signed
// Lumen.exe in Node mode, so Smart App Control has no new script or binary to block; macOS uses a
// small shell script). Builds aren't code-signed, so that hash is the only check: an update is as
// trustworthy as the GitHub account and release it came from.
//
// Which zip:   Windows Lumen-X-win-x64.zip; macOS Lumen-X-mac-arm64.zip or -x64.zip (Rosetta counts
//              as arm64). Installed with the setup, from a zip or a hand-copied folder: all the same.
// Can't swap:  a per-machine install (Program Files), a Mac app in a folder this user can't write, a
//              Windows portable exe (a single exe unpacks to a temp folder, so there is no install
//              to replace), or Linux. They show "Lumen vX is available" with a Download button (the
//              zip, the Mac dmg, or the releases page). Lumen never runs an installer.
// electron-updater is only the release checker now: it reads latest*.yml and reports the version;
// it downloads and installs nothing.
// Never in test mode (unless a test asks for it), a development run, or the `--mcp` bridge.
// main.js hooks in with createUpdates(...).start(); the IPC is settings:updates-* (privileged).
const fs = require('fs');
const path = require('path');

const OWNER = 'emah-maker';
const REPO = 'lumen';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const FIRST_CHECK_MS = 30e3; // after startup, once the window and tabs have settled
const CHECK_EVERY_MS = 4 * 3600e3;

// Why this run must not look for updates, or null. `override` is a test's explicit opt-in
// (LUMEN_UPDATES_TEST), honoured only in test mode, which itself exists only unpackaged.
function disabledReason({ packaged, test, mcp, override }) {
  if (mcp) return 'mcp';
  if (test) return override ? null : 'test';
  if (!packaged) return 'dev';
  return null;
}

// How this copy was installed: 'nsis' | 'portable' | 'zip' | 'mac' | 'other'. The NSIS setup
// leaves its uninstaller next to Lumen.exe; the zip and a hand-copied folder don't.
function installKind({ platform, execPath, env = {}, exists = fs.existsSync, productName = 'Lumen' }) {
  if (platform === 'darwin') return 'mac';
  if (platform !== 'win32') return 'other';
  if (env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  return exists(path.join(path.dirname(execPath), `Uninstall ${productName}.exe`)) ? 'nsis' : 'zip';
}

// 'stage' when this copy can swap itself in place (an install kind with a zip to fetch, in a
// location this user can write to), else 'manual'. `replaceable` is a function so the write probe
// only runs for the kinds that could use it.
function updateMode({ kind, replaceable }) {
  return ['nsis', 'zip', 'mac'].includes(kind) && replaceable() ? 'stage' : 'manual';
}

// Is version `a` newer than `b`? "1.2.3" style, an optional "v", and a pre-release ("-beta.1")
// sorts before its release.
function isNewer(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v || '').trim().replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // 1.0.0 > 1.0.0-beta
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

// { name, url } for a release file. Names follow package.json's artifactName; a matching entry in
// the release's update info (a relative name or a full https URL) wins over the constructed URL.
function assetFor(name, version, files = []) {
  const listed = files.map((f) => String(f?.url || '')).find((u) => u === name || u.endsWith(`/${name}`));
  const url = listed && /^https:\/\//.test(listed) ? listed : `${RELEASES_URL}/download/v${version}/${name}`;
  return { name, url };
}

const macArch = (arch) => (arch === 'arm64' ? 'arm64' : 'x64');

// The zip a copy swaps itself to, or null.
function stageAsset({ kind, version, arch, files }) {
  if (kind === 'mac') return assetFor(`Lumen-${version}-mac-${macArch(arch)}.zip`, version, files);
  if (kind === 'nsis' || kind === 'zip') return assetFor(`Lumen-${version}-win-x64.zip`, version, files);
  return null;
}

// The file a copy that can't swap itself should download: { name, url }, or null for the releases
// page (a per-machine installed copy has no file to drop in, only the setup program, which Lumen
// never fetches or runs).
function manualAsset({ kind, version, arch, files }) {
  if (kind === 'mac') return assetFor(`Lumen-${version}-mac-${macArch(arch)}.dmg`, version, files);
  if (kind === 'zip' || kind === 'portable') return assetFor(`Lumen-${version}-win-x64.zip`, version, files);
  return null;
}

// deps: { app, ipcMain, session, ui, readSettings, writeSettings, prefs, beforeInstall, test }
function createUpdates(deps) {
  const { app } = deps;
  const reason = disabledReason({
    packaged: app.isPackaged,
    test: deps.test,
    mcp: process.argv.includes('--mcp'),
    override: Boolean(process.env.LUMEN_UPDATES_TEST),
  });
  const zipMod = () => (testStager || require('./zip-update'));
  let testStager = null;
  let testQuit = null;
  let kind = installKind({ platform: process.platform, execPath: process.execPath, env: process.env });
  // Only probe the install folder (it creates and removes a small file) when updates are on.
  // (Test mode never does: it runs from the source tree, and tests pick a mode with setKind.)
  let mode = reason || deps.test ? 'manual' : updateMode({ kind, replaceable: () => zipMod().canReplace(process.execPath) });
  // An x64 build running under Rosetta on Apple silicon should move to the arm64 build.
  const arch = process.platform === 'darwin' && app.runningUnderARM64Translation ? 'arm64' : process.arch;
  let updater = null;
  const state = {
    status: reason ? 'disabled' : 'idle', // idle | checking | up-to-date | available | downloading | downloaded | error | disabled
    version: null, // the newer version, once one is found
    progress: 0,
    error: '',
    lastChecked: deps.readSettings().updatesCheckedAt || 0,
  };
  let info = null; // the updater's info for `version`
  let dismissed = null; // the version whose toolbar prompt was closed (this session only)
  let timer = null;
  let staged = null; // an update unpacked and waiting for the restart
  let cleaning = null; // the old staging folder being deleted at start
  let swapStarted = false; // a swap helper is already running (Restart to update, then the quit): one is enough
  let blockedVersion = null; // the version the last swap failed on: not retried on quit (that would loop)
  const errFile = () => path.join(app.getPath('userData'), 'update-error.txt');

  const autoDownload = () => deps.prefs().autoDownloadUpdates !== false;
  const canSelfUpdate = () => mode === 'stage';
  const snapshot = () => ({
    ...state,
    current: app.getVersion(),
    kind,
    canSelfUpdate: canSelfUpdate(),
    autoDownload: autoDownload(),
    disabled: reason,
    dismissed: Boolean(state.version) && dismissed === state.version,
    asset: state.version && !canSelfUpdate() ? manualAsset({ kind, version: state.version, arch, files: info?.files }) : null,
    releasesUrl: RELEASES_URL,
  });
  const publish = () => deps.ui()?.send('updates:state', snapshot());
  const setState = (patch) => { Object.assign(state, patch); publish(); };
  const short = (err) => String(err?.message || err).split('\n')[0].slice(0, 200);

  function getUpdater() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO }); // pinned, not inferred
    updater.logger = null;
    updater.disableWebInstaller = true;
    return lookOnly(updater);
  }
  // It only looks: the zip in startStage() is what gets downloaded and installed.
  function lookOnly(u) {
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    return u;
  }

  // Download, verify and unpack this platform's zip; the restart then swaps it in.
  function startStage() {
    const asset = stageAsset({ kind, version: state.version, arch, files: info?.files });
    if (!asset || state.status === 'downloading') return;
    setState({ status: 'downloading', progress: 0, error: '' });
    const run = () => zipMod().stage({ net: require('electron').net, asset, version: state.version, files: info?.files, execPath: process.execPath, onProgress: (progress) => setState({ progress }) });
    (cleaning ? cleaning.then(run) : run()) // not while an old staging folder is still being deleted
      .then((s) => { staged = s; setState({ status: 'downloaded', progress: 100 }); })
      .catch((err) => setState({ status: 'error', error: short(err) }));
  }

  function wire(u) {
    u.on('update-available', (i) => {
      info = i;
      setState({ status: 'available', version: i.version, error: '' });
      if (canSelfUpdate() && autoDownload()) startStage();
    });
    u.on('update-not-available', () => setState({ status: 'up-to-date', error: '' }));
    u.on('error', (err) => setState({ status: 'error', error: short(err) }));
  }

  async function check() {
    if (reason) return snapshot();
    if (['checking', 'downloading', 'downloaded'].includes(state.status)) return snapshot();
    const u = getUpdater();
    setState({ status: 'checking', error: '' });
    try {
      const result = await u.checkForUpdates();
      if (!result) setState({ status: 'idle' }); // the updater is inactive (unpackaged)
      else if (result.updateInfo && !isNewer(result.updateInfo.version, app.getVersion()) && state.status === 'checking') setState({ status: 'up-to-date' });
    } catch (err) {
      if (state.status === 'checking') setState({ status: 'error', error: short(err) });
    }
    state.lastChecked = Date.now();
    deps.writeSettings({ ...deps.readSettings(), updatesCheckedAt: state.lastChecked });
    publish();
    return snapshot();
  }

  // The prompt's one button: restart into a downloaded update, download one (automatic downloads
  // off, or a retry), or fetch the right file for a copy that can't swap itself.
  async function apply() {
    if (reason || !state.version) return snapshot();
    if (canSelfUpdate()) {
      if (state.status === 'downloaded' && staged) {
        deps.beforeInstall?.(); // the session and chat are saved before the swap
        if (!swapStarted) {
          swapStarted = true;
          zipMod().launchSwap({ staged, execPath: process.execPath, errFile: errFile() });
        }
        (testQuit || (() => app.quit()))();
      } else if (state.status === 'available' || state.status === 'error') {
        startStage();
      }
      return snapshot();
    }
    const asset = manualAsset({ kind, version: state.version, arch, files: info?.files });
    if (asset) deps.session.defaultSession.downloadURL(asset.url); // shows in Lumen's Downloads
    else require('electron').shell.openExternal(RELEASES_URL);
    dismissed = state.version; // the toolbar prompt has done its job
    publish();
    return snapshot();
  }

  // The user quit with an update downloaded: install it now, but don't start Lumen again. Called from
  // main.js once quitting is under way (will-quit); the detached helper waits for this process to exit.
  function applyOnQuit() {
    if (reason || swapStarted || !canSelfUpdate() || state.status !== 'downloaded' || !staged) return false;
    if (state.version && state.version === blockedVersion) return false;
    swapStarted = true;
    try {
      zipMod().launchSwap({ staged, execPath: process.execPath, errFile: errFile(), relaunch: false });
      return true;
    } catch {
      swapStarted = false;
      return false;
    }
  }

  // A complete staged update from an earlier run that was never applied: pick it up again instead of
  // downloading it twice. Only for a version newer than this one; anything else is deleted.
  function restoreStaged(lastSwapFailed) {
    const zip = zipMod();
    const stagingDir = zip.swapPaths(process.execPath).staging;
    const found = zip.readStaged?.(process.execPath);
    const marked = found?.version || zip.readMarker?.(process.execPath)?.version;
    if (lastSwapFailed && marked) blockedVersion = marked;
    if (found && !lastSwapFailed && isNewer(found.version, app.getVersion())) {
      staged = found.staged;
      Object.assign(state, { status: 'downloaded', version: found.version, progress: 100, error: '' });
      // the copy of the exe that runs the swap: ready before the user needs it
      if (!staged.helper) setTimeout(() => { try { if (staged && !swapStarted) staged.helper = zip.prepareHelper(process.execPath); } catch {} }, 5000).unref?.();
      return;
    }
    const done = fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {}).then(() => { if (cleaning === done) cleaning = null; });
    cleaning = done;
  }

  function start() {
    const handle = (channel, fn) => deps.ipcMain.handle(channel, (_event, ...args) => fn(...args));
    handle('settings:updates-state', snapshot);
    handle('settings:updates-check', check);
    handle('settings:updates-apply', apply);
    handle('settings:updates-dismiss', () => { dismissed = state.version; publish(); return snapshot(); });
    if (reason) return;
    // The last swap couldn't replace the files: the old version is what's running.
    let lastSwapFailed = false;
    try {
      const msg = fs.readFileSync(errFile(), 'utf8').trim();
      fs.rmSync(errFile(), { force: true });
      if (msg) state.error = msg.slice(0, 200), state.status = 'error', lastSwapFailed = true;
    } catch {}
    // An update that was unpacked but never applied leaves a big folder next to the install: use it
    // if it is complete and newer, else clear it.
    if (canSelfUpdate()) restoreStaged(lastSwapFailed);
    wire(getUpdater());
    timer = setTimeout(function tick() {
      check();
      timer = setTimeout(tick, CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
  }

  // Tests (test/updates.js) swap in a stand-in updater and stager and pretend to be a given kind of install.
  const testHooks = deps.test ? {
    useUpdater: (u) => { clearTimeout(timer); updater = lookOnly(u); wire(u); },
    useStager: (z) => { testStager = z; },
    stubQuit: (fn) => { testQuit = fn; },
    setKind: (k, replaceable = true) => { kind = k; mode = updateMode({ kind: k, replaceable: () => replaceable }); publish(); },
    restore: (lastSwapFailed) => restoreStaged(lastSwapFailed),
    reset: () => { Object.assign(state, { status: 'idle', version: null, progress: 0, error: '' }); info = null; staged = null; dismissed = null; swapStarted = false; blockedVersion = null; publish(); },
  } : undefined;

  return { start, check, apply, applyOnQuit, state: snapshot, testHooks };
}

module.exports = { createUpdates, disabledReason, installKind, updateMode, isNewer, stageAsset, manualAsset, RELEASES_URL };
