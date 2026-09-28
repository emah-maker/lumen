// ---------- updates: new versions from the GitHub Releases of emah-maker/lumen ----------
// electron-updater reads latest.yml / latest-mac.yml from the newest release and checks the
// download's sha512 against it. Builds aren't code-signed, so that hash is the only check: an
// update is as trustworthy as the GitHub account and release it came from.
//
// What each copy of Lumen can do:
//   Windows, installed with the NSIS setup  downloads in the background, then "Restart to update";
//                                           if that's ignored, it installs when Lumen quits
//   Windows zip / portable copy             "Lumen vX is available": downloads the zip
//   macOS                                   the same, with the dmg for this Mac (Squirrel.Mac
//                                           can't apply updates to an unsigned app)
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
const canAutoInstall = (kind) => kind === 'nsis';

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

// The file a copy that can't update itself should download: { name, url }, or null for the
// releases page. Names follow package.json's artifactName; a matching entry in the release's
// update info (a relative name or a full URL) wins over the constructed download URL.
function manualAsset({ kind, version, arch, files = [] }) {
  let name = null;
  if (kind === 'mac') name = `Lumen-${version}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  else if (kind === 'zip' || kind === 'portable') name = `Lumen-${version}-win-x64.zip`;
  if (!name) return null;
  const listed = files.map((f) => String(f?.url || '')).find((u) => u === name || u.endsWith(`/${name}`));
  const url = listed && /^https:\/\//.test(listed) ? listed : `${RELEASES_URL}/download/v${version}/${name}`;
  return { name, url };
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
  let kind = installKind({ platform: process.platform, execPath: process.execPath, env: process.env });
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

  const autoDownload = () => deps.prefs().autoDownloadUpdates !== false;
  const snapshot = () => ({
    ...state,
    current: app.getVersion(),
    kind,
    canAutoInstall: canAutoInstall(kind),
    autoDownload: autoDownload(),
    disabled: reason,
    dismissed: Boolean(state.version) && dismissed === state.version,
    asset: state.version && !canAutoInstall(kind) ? manualAsset({ kind, version: state.version, arch, files: info?.files }) : null,
    releasesUrl: RELEASES_URL,
  });
  const publish = () => deps.ui()?.send('updates:state', snapshot());
  const setState = (patch) => { Object.assign(state, patch); publish(); };

  function getUpdater() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO }); // pinned, not inferred
    updater.logger = null;
    updater.disableWebInstaller = true;
    return updater;
  }

  function wire(u) {
    u.on('update-available', (i) => {
      info = i;
      setState({ status: 'available', version: i.version, error: '' });
    });
    u.on('update-not-available', () => setState({ status: 'up-to-date', error: '' }));
    u.on('download-progress', (p) => setState({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    u.on('update-downloaded', (i) => { info = i; setState({ status: 'downloaded', version: i.version, progress: 100 }); });
    u.on('error', (err) => setState({ status: 'error', error: String(err?.message || err).split('\n')[0].slice(0, 200) }));
  }

  async function check() {
    if (reason) return snapshot();
    if (['checking', 'downloading', 'downloaded'].includes(state.status)) return snapshot();
    const u = getUpdater();
    // Only an NSIS install downloads (and installs) anything itself; the rest just ask.
    u.autoDownload = canAutoInstall(kind) && autoDownload();
    u.autoInstallOnAppQuit = canAutoInstall(kind);
    setState({ status: 'checking', error: '' });
    try {
      const result = await u.checkForUpdates();
      if (!result) setState({ status: 'idle' }); // the updater is inactive (unpackaged)
      else if (result.updateInfo && !isNewer(result.updateInfo.version, app.getVersion()) && state.status === 'checking') setState({ status: 'up-to-date' });
    } catch (err) {
      if (state.status === 'checking') setState({ status: 'error', error: String(err?.message || err).split('\n')[0].slice(0, 200) });
    }
    state.lastChecked = Date.now();
    deps.writeSettings({ ...deps.readSettings(), updatesCheckedAt: state.lastChecked });
    publish();
    return snapshot();
  }

  // The prompt's one button: restart into a downloaded update, download one (NSIS with automatic
  // downloads off), or fetch the right file for a copy that can't update itself.
  async function apply() {
    if (reason || !state.version) return snapshot();
    if (canAutoInstall(kind)) {
      if (state.status === 'downloaded') {
        deps.beforeInstall?.(); // the session and chat are saved before the installer takes over
        getUpdater().quitAndInstall(true, true); // silent, then start the new version
      } else if (state.status === 'available' || state.status === 'error') {
        setState({ status: 'downloading', progress: 0, error: '' });
        getUpdater().downloadUpdate().catch(() => {}); // failures arrive as 'error'
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

  function start() {
    const handle = (channel, fn) => deps.ipcMain.handle(channel, (_event, ...args) => fn(...args));
    handle('settings:updates-state', snapshot);
    handle('settings:updates-check', check);
    handle('settings:updates-apply', apply);
    handle('settings:updates-dismiss', () => { dismissed = state.version; publish(); return snapshot(); });
    if (reason) return;
    wire(getUpdater());
    timer = setTimeout(function tick() {
      check();
      timer = setTimeout(tick, CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
  }

  // Tests (test/updates.js) swap in a stand-in updater and pretend to be a given kind of install.
  const testHooks = deps.test ? {
    useUpdater: (u) => { clearTimeout(timer); updater = u; wire(u); },
    setKind: (k) => { kind = k; publish(); },
    reset: () => { Object.assign(state, { status: 'idle', version: null, progress: 0, error: '' }); info = null; dismissed = null; publish(); },
  } : undefined;

  return { start, check, apply, state: snapshot, testHooks };
}

module.exports = { createUpdates, disabledReason, installKind, canAutoInstall, isNewer, manualAsset, RELEASES_URL };
