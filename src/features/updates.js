// ---------- updates: new versions from the GitHub Releases of emah-maker/lumen ----------
// One mechanism for every copy that can write to its own install location: download this
// platform's release zip in the app ("Downloading vX…"), check its sha512 against the entry that
// latest.yml / latest-mac.yml lists for it, unpack it next to the install, then "Restart to update"
// swaps the folders (features/zip-update.js: Windows runs a byte-identical copy of the signed
// Lumen.exe in Node mode, so Smart App Control has no new script or binary to block; macOS uses a
// small shell script). Builds aren't code-signed, so that hash is the only check: an update is as
// trustworthy as the GitHub account and release it came from.
//
// One click: a found update is downloaded and staged in the background and the toolbar pill and
// Settings both say "Restart to update". One click applies it and relaunches; a click while it is
// still downloading queues it (progress shows, then it applies and relaunches by itself). No second
// dialog, no dmg. clickAction() is that state machine.
//
// Which zip:   Windows Lumen-X-win-x64.zip; macOS Lumen-X-mac-arm64.zip or -x64.zip (Rosetta counts
//              as arm64). Installed with the setup, from a zip or a hand-copied folder: all the same.
// Relocating:  a Mac copy that can't swap itself where it runs (from the dmg, a translocated path, a
//              folder it can't write, or /Applications as a standard user) has its update installed
//              INTO /Applications (or ~/Applications when that isn't writable) by the same click:
//              the zip is staged there and the swap puts the new app in place and opens it. A newer
//              Lumen already there is never overwritten (it is offered instead), nor one that is
//              running. With no update to install, the native "Move to Applications" is used
//              (launch prompt, Settings), and a declined prompt is re-offered once per new version.
// Can't swap:  a per-machine install (Program Files), a Windows portable exe (a single exe unpacks
//              to a temp folder, so there is no install to replace), or Linux. They show "Lumen vX is
//              available" with a Download button (the Setup exe, the zip or the releases page).
//              Lumen never runs an installer.
// electron-updater is only the release checker now: it reads latest*.yml and reports the version;
// it downloads and installs nothing.
// Never in test mode (unless a test asks for it), a development run, or the `--mcp` bridge.
// main.js hooks in with createUpdates(...).start(); the IPC is settings:updates-* (privileged).
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const OWNER = 'emah-maker';
const REPO = 'lumen';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const FIRST_CHECK_MS = 30e3; // after startup, once the window and tabs have settled
const CHECK_EVERY_MS = 4 * 3600e3;
const REOFFER_GAP_MS = 3600e3; // a declined move is not asked again within this
const QUIT_GRACE_MS = 10e3; // after app.quit(): no will-quit by then means the quit was vetoed

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

// Where a Mac copy runs from: { misplaced, why, userApps }. Gatekeeper's App Translocation runs a
// quarantined app from a random read-only mount (/AppTranslocation/), and a copy opened straight
// from the dmg lives on a read-only /Volumes image: neither can swap itself. Those, and any copy
// outside the Applications folders that can't be written, are "misplaced": the update is installed
// into Applications for them (or the native move is offered). A copy in /Applications that just
// isn't writable (standard user) isn't misplaced but has `userApps`: its update goes to
// ~/Applications, where it can update itself without an administrator.
function macPlacement({ execPath, home = '', replaceable = true }) {
  const p = String(execPath || '');
  if (/\/AppTranslocation\//.test(p)) return { misplaced: true, why: 'translocated' };
  if (replaceable) return { misplaced: false, why: null };
  if (p.startsWith('/Volumes/')) return { misplaced: true, why: 'dmg' };
  if (p.startsWith('/Applications/')) return { misplaced: false, why: null, userApps: true };
  const inUserApps = home && p.startsWith(`${home.replace(/\/$/, '')}/Applications/`);
  return inUserApps ? { misplaced: false, why: null } : { misplaced: true, why: 'unwritable' };
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
// page. A per-machine installed copy (nsis, but not writable) gets the Setup exe, which the user
// runs themselves: Lumen downloads it into Downloads and never fetches-and-runs it.
function manualAsset({ kind, version, arch, files }) {
  if (kind === 'mac') return assetFor(`Lumen-${version}-mac-${macArch(arch)}.dmg`, version, files);
  if (kind === 'nsis') return assetFor(`Lumen-Setup-${version}.exe`, version, files);
  if (kind === 'zip' || kind === 'portable') return assetFor(`Lumen-${version}-win-x64.zip`, version, files);
  return null;
}

// ---------- a Lumen already in Applications ----------
const VERSION_RE = /^\d+(\.\d+)*(-[0-9A-Za-z.]+)?$/;
const PLIST_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/;

// CFBundleShortVersionString from an XML Info.plist (a string or Buffer), or null. A binary plist
// ("bplist00…") isn't parsed here: readBundleVersion asks the system to.
function plistVersion(data) {
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  if (s.startsWith('bplist')) return null;
  const m = PLIST_VERSION.exec(s);
  return m && VERSION_RE.test(m[1]) ? m[1] : null;
}

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(String(out))));
});

// The version of the Lumen.app at `bundle`, or null when it can't be read (then the downgrade check
// is skipped, with a warning). XML plist first; a binary one goes through plutil, then `defaults`.
async function readBundleVersion(bundle, { readFile = fs.promises.readFile, exec = run, warn = console.warn } = {}) {
  const plist = path.posix.join(bundle, 'Contents', 'Info.plist');
  let raw;
  try { raw = await readFile(plist); } catch { return null; }
  const v = plistVersion(raw);
  if (v) return v;
  try {
    const j = JSON.parse(await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
    if (VERSION_RE.test(String(j?.CFBundleShortVersionString))) return j.CFBundleShortVersionString;
  } catch {}
  try {
    const out = (await exec('/usr/bin/defaults', ['read', path.posix.join(bundle, 'Contents', 'Info'), 'CFBundleShortVersionString'])).trim();
    if (VERSION_RE.test(out)) return out;
  } catch {}
  warn(`updates: couldn't read the version of ${bundle}; not checking it for a downgrade`);
  return null;
}

// The same, synchronously (will-quit can't wait). `readFile`, `exec` and `platform` are injectable.
function readBundleVersionSync(bundle, { readFile = fs.readFileSync, exec = execFileSync, platform = process.platform } = {}) {
  const plist = path.posix.join(bundle, 'Contents', 'Info.plist');
  let raw;
  try { raw = readFile(plist); } catch { return null; }
  const v = plistVersion(raw);
  if (v) return v;
  if (platform !== 'darwin') return null;
  try { return plistVersion(exec('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plist], { timeout: 3000 })); } catch { return null; }
}

// Installing `incoming` over an existing Lumen of version `existing` would lose nothing only when
// the existing one is older. An unreadable version (null) doesn't block.
const keepExisting = (existing, incoming) => Boolean(existing) && !isNewer(incoming, existing);

// Is some Lumen other than this process running from `bundle`? (pgrep -f on its executable folder.)
async function runningFrom(bundle, { exec = run, pid = process.pid } = {}) {
  try {
    const out = await exec('/usr/bin/pgrep', ['-f', `${bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Contents/MacOS/`]);
    return out.split(/\s+/).filter(Boolean).some((p) => Number(p) !== pid);
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

// Where a relocated install goes: /Applications when this user can write there, else ~/Applications
// (created), else null. The probes are injected.
function pickAppsDir({ home, canWrite, mkdir }) {
  if (canWrite('/Applications')) return '/Applications';
  if (!home) return null;
  const dir = `${home.replace(/\/$/, '')}/Applications`;
  try { mkdir(dir); } catch { return null; }
  return canWrite(dir) ? dir : null;
}

const QUIT_OTHER = 'Lumen is already running from Applications. Quit the other Lumen first, then try again.';

// What the dialog says when a Lumen at least as new is already installed.
function keepMessage(existing, incoming, dir = 'Applications') {
  return isNewer(existing, incoming)
    ? { message: `A newer Lumen (${existing}) is already in ${dir}`, detail: `It wasn't replaced with Lumen ${incoming}. Open the newer copy instead?` }
    : { message: `Lumen ${existing} is already in ${dir}`, detail: 'Open that copy instead?' };
}

// ---------- the one-click state machine ----------
// What the prompt's one button does, from the current state:
//   none            nothing to do (a check is running, already queued, disabled)
//   move            a misplaced Mac copy with no update to install: the native Move to Applications
//   manual          a copy that can't install itself: download the file (dmg, Setup exe, zip)
//   apply           the update is staged: restart into it now
//   queue           still downloading: apply and relaunch the moment it is ready
//   download        (automatic downloads off) just download it; "Restart to update" comes after
//   download-queue  download it, then apply and relaunch by itself
function clickAction({ disabled, canSelfUpdate, relocate, hasVersion, status, queued, staged, autoDownload = true }) {
  if (disabled) return 'none';
  if (!hasVersion) return relocate === 'misplaced' ? 'move' : 'none';
  if (!canSelfUpdate && !relocate) return 'manual';
  if (status === 'downloaded' && staged) return 'apply';
  if (status === 'downloading') return queued ? 'none' : 'queue';
  if (status === 'available' || status === 'error') return relocate || autoDownload ? 'download-queue' : 'download';
  return 'none';
}

// Offer a misplaced copy the move: once at launch (nothing known yet), then at most once per new
// version, never twice within REOFFER_GAP_MS.
function shouldOfferMove({ relocate, version, promptedAt = 0, promptedVersion = '', now = Date.now() }) {
  if (relocate !== 'misplaced') return false;
  if (!version) return !promptedAt;
  return promptedVersion !== version && now - promptedAt >= REOFFER_GAP_MS;
}

// deps: { app, ipcMain, session, ui, readSettings, writeSettings, prefs, beforeInstall, test, t? }
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
  // The outside world, in one place so a test can stand in for it.
  const io = {
    home: () => require('os').homedir(),
    canWrite: (d) => zipMod().canWriteDir(d),
    mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
    exists: (p) => fs.existsSync(p),
    version: (bundle) => readBundleVersion(bundle),
    // XML plist directly; a binary one (darwin) through plutil; else null and the check is skipped
    versionSync: (bundle) => readBundleVersionSync(bundle),
    running: (bundle) => runningFrom(bundle),
    dialog: (o) => require('electron').dialog.showMessageBox(o),
    // The other Lumen can't start while this one holds the single-instance lock, so it is opened a
    // moment after this one quits.
    openApp: (bundle) => { spawn('/bin/sh', ['-c', 'sleep 2; open "$1"', 'sh', bundle], { detached: true, stdio: 'ignore' }).unref(); },
    move: (o) => app.moveToApplicationsFolder(o),
    quit: () => app.quit(),
  };
  let emulateWillQuit = false; // tests stub quit(), so will-quit never comes
  let kind = installKind({ platform: process.platform, execPath: process.execPath, env: process.env });
  // Only probe the install folder (it creates and removes a small file) when updates are on.
  // (Test mode never does: it runs from the source tree, and tests pick a mode with setKind.)
  let mode = reason || deps.test ? 'manual' : updateMode({ kind, replaceable: () => zipMod().canReplace(process.execPath) });
  // A Mac copy running from the dmg, a translocated path or somewhere unwritable: its update is
  // installed into Applications instead (see macPlacement).
  let placement = { misplaced: false, why: null };
  if (kind === 'mac' && !reason && !deps.test) {
    placement = macPlacement({ execPath: process.execPath, home: require('os').homedir(), replaceable: mode === 'stage' });
  }
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
  let swapStarted = false; // a swap helper is already running: one is enough
  let relaunchOnQuit = false; // the user clicked Restart: the swap started at will-quit reopens Lumen
  let queued = false; // clicked while downloading: apply and relaunch as soon as it is ready
  let checkRunning = false; // a check is in flight (the status may stay as it was, see check())
  let checkPromise = null; // that check, so Try again can wait for it instead of doing nothing
  let retrying = false; // Try again's re-check is running: the update it finds is downloaded and applied as a queued click would
  let installFailed = false; // the last swap failed (the marker may or may not name its version)
  let preparing = false; // checking the Applications folder before a relocated download
  let relocateTo = null; // the Lumen.app a relocated update is being installed to
  let moveError = ''; // why a move / relocated install couldn't go ahead (shown until dismissed or retried)
  const errFile = () => path.join(app.getPath('userData'), 'update-error.txt');

  // Main-process strings come from locales/ through deps.t; without it (a test) the English text stands in.
  const EN = {
    'updates.moveDialog.confirm': 'Move and update',
    'updates.moveDialog.later': 'Not now',
    'updates.moveDialog.message': 'Lumen {version} is available',
    'updates.moveDialog.detail': 'Move Lumen to Applications and update it now? Lumen restarts from there.',
  };
  const tr = (key, vars) => (deps.t ? deps.t(key, vars) : EN[key].replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w)));
  const autoDownload = () => deps.prefs().autoDownloadUpdates !== false;
  const canSelfUpdate = () => mode === 'stage';
  // 'misplaced' | 'user' (standard user in /Applications) | null: the copies whose update installs into Applications
  const relocate = () => (kind !== 'mac' ? null : placement.misplaced ? 'misplaced' : placement.userApps ? 'user' : null);
  const snapshot = () => ({
    ...state,
    current: app.getVersion(),
    kind,
    canSelfUpdate: canSelfUpdate(),
    autoDownload: autoDownload(),
    disabled: reason,
    dismissed: Boolean(state.version || installFailed) && dismissed === dismissKey(),
    misplaced: placement.misplaced ? placement.why : null, // why this Mac copy can't update itself where it runs
    relocate: relocate(),
    queued,
    checking: checkRunning, // a check is in flight even when the status underneath stays error/available/downloaded
    installFailed,
    moveError,
    asset: state.version && !canSelfUpdate() && !relocate() ? manualAsset({ kind, version: state.version, arch, files: info?.files }) : null,
    releasesUrl: RELEASES_URL,
  });
  const publish = () => deps.ui()?.send('updates:state', snapshot());
  const setState = (patch) => { if (patch.status && patch.status !== 'error') installFailed = false; Object.assign(state, patch); publish(); };
  const dismissKey = () => state.version || 'install-failed'; // a failed install with no known version still has a pill to close
  const short = (err) => String(err?.message || err).split('\n')[0].slice(0, 200);
  const fail = (msg) => { moveError = msg; queued = false; publish(); return false; };

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

  // Download, verify and unpack this platform's zip; the restart then swaps it in. A relocated
  // update is staged next to the Lumen.app it will become, so the swap never crosses volumes.
  function startStage() {
    const asset = stageAsset({ kind, version: state.version, arch, files: info?.files });
    if (!asset || state.status === 'downloading') return;
    const execPath = relocateTo ? `${relocateTo}/Contents/MacOS/${path.basename(process.execPath)}` : process.execPath;
    setState({ status: 'downloading', progress: 0, error: '' });
    const net = () => { try { return require('electron').net; } catch { return undefined; } };
    const go = () => zipMod().stage({ net: net(), asset, version: state.version, files: info?.files, execPath, onProgress: (progress) => setState({ progress }) });
    (cleaning ? cleaning.then(go) : Promise.resolve().then(go)) // not while an old staging folder is still being deleted
      .then((s) => {
        staged = s;
        setState({ status: 'downloaded', progress: 100 });
        if (queued) applyNow(); // the click that came while it downloaded
      })
      .catch((err) => { queued = false; setState({ status: 'error', error: short(err) }); });
  }

  // Show the native dialog, e.g. to open the newer copy that is already installed.
  async function offerOpen(bundle, existing, incoming) {
    const { message, detail } = keepMessage(existing, incoming, path.posix.dirname(bundle));
    const { response } = await io.dialog({ type: 'question', buttons: ['Open it', 'Cancel'], defaultId: 0, cancelId: 1, message, detail });
    if (response === 0) { deps.beforeInstall?.(); io.openApp(bundle); io.quit(); }
  }

  // A relocated update: pick /Applications or ~/Applications, and check what is already there
  // before anything is downloaded. Sets relocateTo; false when it shouldn't go ahead.
  async function prepareRelocate() {
    preparing = true;
    moveError = '';
    try {
      const dir = pickAppsDir({ home: io.home(), canWrite: io.canWrite, mkdir: io.mkdir });
      if (!dir) return fail('Lumen couldn’t find an Applications folder it can write to.');
      const bundle = `${dir}/Lumen.app`;
      if (io.exists(bundle)) {
        if (await io.running(bundle)) return fail(QUIT_OTHER);
        const existing = await io.version(bundle);
        if (keepExisting(existing, state.version)) { queued = false; publish(); await offerOpen(bundle, existing, state.version); return false; }
      }
      relocateTo = bundle;
      return true;
    } catch (err) {
      return fail(short(err));
    } finally {
      preparing = false;
    }
  }

  function wire(u) {
    u.on('update-available', (i) => {
      info = i;
      // a re-check with an update already staged: only a newer one replaces it
      if (state.status === 'downloaded' && staged && !isNewer(i.version, state.version)) return;
      if (state.status === 'downloaded') staged = null;
      setState({ status: 'available', version: i.version, error: '' });
      if (retrying && (canSelfUpdate() || relocate())) downloadAndQueue().catch(() => {}); // Try again is one click
      else if (canSelfUpdate() && autoDownload()) startStage();
      else if (shouldOfferMove({ relocate: relocate(), version: i.version, ...promptedSettings() })) offerMoveUpdate().catch(() => {});
    });
    u.on('update-not-available', () => { if (!staged) setState({ status: 'up-to-date', version: null, error: '' }); });
    // a failed background re-check doesn't turn a known update into an error
    u.on('error', (err) => { if (!(state.version && ['available', 'downloading', 'downloaded'].includes(state.status))) setState({ status: 'error', error: short(err) }); });
  }

  const promptedSettings = () => { const s = deps.readSettings(); return { promptedAt: s.movePromptedAt || 0, promptedVersion: s.movePromptedVersion || '' }; };

  // A misplaced copy and a new version: ask once for this version, with the update in the question.
  async function offerMoveUpdate() {
    const version = state.version;
    deps.writeSettings({ ...deps.readSettings(), movePromptedAt: Date.now(), movePromptedVersion: version });
    const { response } = await io.dialog({ type: 'question', buttons: [tr('updates.moveDialog.confirm'), tr('updates.moveDialog.later')], defaultId: 0, cancelId: 1, message: tr('updates.moveDialog.message', { version }), detail: tr('updates.moveDialog.detail') });
    if (response === 0 && state.version === version) await apply();
  }

  function check() {
    if (reason) return Promise.resolve(snapshot());
    if (checkRunning || ['checking', 'downloading'].includes(state.status)) return Promise.resolve(snapshot());
    return (checkPromise = runCheck().finally(() => { checkPromise = null; }));
  }
  async function runCheck() {
    const u = getUpdater();
    checkRunning = true;
    publish(); // the renderers show "Checking…" even while the status stays as it was
    // With an update already known the status stays as it is, so "Restart to update" / "Move and
    // update" don't flicker away during a background check; the result only matters if it is newer.
    // Nor after a failed install or check: the pill (and Try again) must survive a re-check that fails too.
    if (!state.version && !installFailed && state.status !== 'error') setState({ status: 'checking', error: '' });
    try {
      const result = await u.checkForUpdates();
      if (!result) { if (state.status === 'checking') setState({ status: 'idle' }); } // the updater is inactive (unpackaged)
      else if (result.updateInfo && !isNewer(result.updateInfo.version, app.getVersion()) && state.status === 'checking') setState({ status: 'up-to-date' });
    } catch (err) {
      // Try again (or a check over a failed install) must say why it failed too; the version and installFailed stay.
      if (state.status === 'checking' || retrying || state.status === 'error' || installFailed) setState({ status: 'error', error: short(err) });
    }
    checkRunning = false;
    state.lastChecked = Date.now();
    deps.writeSettings({ ...deps.readSettings(), updatesCheckedAt: state.lastChecked });
    publish();
    return snapshot();
  }

  // The native "Move to Applications folder?" (for a misplaced copy with no update to install):
  // Electron asks itself, copies the app, relaunches from there and (for a dmg) unmounts it. A
  // newer Lumen already in Applications is not overwritten (it is offered instead), and a running
  // one is reported; a failure is shown (moveError), not swallowed.
  async function moveToApplications() {
    if (!placement.misplaced) return snapshot();
    moveError = '';
    const target = '/Applications/Lumen.app';
    try {
      if (io.exists(target)) {
        const existing = await io.version(target);
        if (keepExisting(existing, app.getVersion())) { await offerOpen(target, existing, app.getVersion()); return snapshot(); }
      }
      deps.beforeInstall?.();
      let running = false;
      io.move({ conflictHandler: (type) => { if (type === 'existsAndRunning') { running = true; return false; } return true; } });
      if (running) moveError = QUIT_OTHER;
    } catch (err) {
      moveError = short(err);
    }
    publish();
    return snapshot();
  }

  // Restart into the staged update. The swap helper starts at will-quit (applyOnQuit), so a quit
  // that is cancelled never leaves a helper waiting to fail; if will-quit hasn't come after a while
  // the request is forgotten, and a later quit just applies the update without reopening.
  function applyNow() {
    queued = false;
    deps.beforeInstall?.(); // the session and chat are saved before the swap
    relaunchOnQuit = true;
    io.quit();
    if (emulateWillQuit) applyOnQuit();
    setTimeout(() => { if (!swapStarted) relaunchOnQuit = false; }, QUIT_GRACE_MS).unref?.();
  }

  // Download (into Applications for a relocating copy) and apply by itself when ready.
  async function downloadAndQueue() {
    queued = true;
    relocateTo = null;
    if (relocate()) { publish(); if (!(await prepareRelocate())) return; }
    startStage();
  }

  async function apply() {
    if (reason || preparing) return snapshot();
    moveError = '';
    // A failed install found again after a restart has no release info (hashes) to download from:
    // look again first; the update-available that follows downloads and applies it (retrying), so
    // Try again stays one click whatever the copy or the automatic-download setting.
    if (state.status === 'error' && (state.version || installFailed) && !info) {
      retrying = true; // also when a background check is already running: its find is downloaded and applied too
      try { return await (checkPromise || check()); } finally { retrying = false; }
    }
    const act = clickAction({ disabled: reason, canSelfUpdate: canSelfUpdate(), relocate: relocate(), hasVersion: Boolean(state.version), status: state.status, queued, staged: Boolean(staged), autoDownload: autoDownload() });
    if (act === 'move') return moveToApplications();
    if (act === 'apply') applyNow();
    else if (act === 'queue') { queued = true; publish(); }
    else if (act === 'download') startStage();
    else if (act === 'download-queue') {
      await downloadAndQueue();
    } else if (act === 'manual') {
      const asset = manualAsset({ kind, version: state.version, arch, files: info?.files });
      if (asset) deps.session.defaultSession.downloadURL(asset.url); // shows in Lumen's Downloads
      else require('electron').shell.openExternal(RELEASES_URL);
      dismissed = dismissKey(); // the toolbar prompt has done its job
    }
    publish();
    return snapshot();
  }

  // The user quit (or Restart to update is quitting) with an update downloaded: install it now.
  // Called from main.js once quitting is under way (will-quit); the detached helper waits for this
  // process to exit. Reopens Lumen only for the Restart click, not for a plain quit.
  function applyOnQuit() {
    if (reason || swapStarted || !(canSelfUpdate() || relocate()) || state.status !== 'downloaded' || !staged) return false;
    // A relocated install re-checks what is at the target now: a newer Lumen may have been put there
    // since the download, and it must not be replaced. (Sync: will-quit can't wait.)
    if (relocateTo && io.exists(relocateTo) && keepExisting(io.versionSync(relocateTo), state.version)) {
      if (relaunchOnQuit) io.openApp(relocateTo);
      return false;
    }
    swapStarted = true;
    try {
      zipMod().launchSwap({ staged, execPath: process.execPath, errFile: errFile(), relaunch: relaunchOnQuit });
      return true;
    } catch {
      swapStarted = false;
      return false;
    }
  }

  // A complete staged update from an earlier run that was never applied: pick it up again instead of
  // downloading it twice. Only for a version newer than this one; anything else is deleted.
  // A relocating copy stages next to the Lumen.app it will become (either Applications folder), not
  // next to itself, so that is where its leftovers are cleared; they are never picked up again.
  function restoreStaged(lastSwapFailed) {
    const zip = zipMod();
    const reloc = Boolean(relocate());
    const exe = path.basename(process.execPath);
    const execPaths = reloc ? ['/Applications', `${io.home().replace(/\/$/, '')}/Applications`].map((d) => `${d}/Lumen.app/Contents/MacOS/${exe}`) : [process.execPath];
    const stagingDirs = [];
    for (const execPath of execPaths) {
      const found = reloc ? null : zip.readStaged?.(execPath);
      const marked = found?.version || zip.readMarker?.(execPath)?.version;
      // the failed swap's version: Settings and the pill say what couldn't be installed, and Try again looks it up
      if (lastSwapFailed && marked && !state.version) state.version = marked;
      if (found && !lastSwapFailed && isNewer(found.version, app.getVersion())) {
        staged = found.staged;
        Object.assign(state, { status: 'downloaded', version: found.version, progress: 100, error: '' });
        // the copy of the exe that runs the swap: ready before the user needs it
        if (!staged.helper) setTimeout(() => { try { if (staged && !swapStarted) staged.helper = zip.prepareHelper(process.execPath); } catch {} }, 5000).unref?.();
        return;
      }
      stagingDirs.push(zip.swapPaths(execPath).staging);
    }
    if (lastSwapFailed) installFailed = true; // say the install failed (with the version when a marker named it), not the check
    const done = Promise.all(stagingDirs.map((d) => fs.promises.rm(d, { recursive: true, force: true }).catch(() => {}))).then(() => { if (cleaning === done) cleaning = null; });
    cleaning = done;
  }

  // A standard user's old /Applications copy, launched while a newer ~/Applications one exists (the
  // update was installed there): open that one and quit, instead of running a stale copy or asking.
  async function openNewerUserCopy() {
    if (relocate() !== 'user') return false;
    const bundle = `${io.home().replace(/\/$/, '')}/Applications/Lumen.app`;
    if (!io.exists(bundle)) return false;
    const existing = await io.version(bundle);
    if (!existing || !isNewer(existing, app.getVersion())) return false;
    deps.beforeInstall?.(); // the session and chat are saved before this copy quits
    io.openApp(bundle);
    io.quit();
    return true;
  }

  function dismiss() { dismissed = dismissKey(); moveError = ''; publish(); return snapshot(); }

  function start() {
    const handle = (channel, fn) => deps.ipcMain.handle(channel, (_event, ...args) => fn(...args));
    handle('settings:updates-state', snapshot);
    handle('settings:updates-check', check);
    handle('settings:updates-apply', apply);
    handle('settings:updates-dismiss', dismiss);
    if (reason) return;
    // The last swap couldn't replace the files: the old version is what's running.
    let lastSwapFailed = false;
    try {
      const msg = fs.readFileSync(errFile(), 'utf8').trim();
      fs.rmSync(errFile(), { force: true });
      if (msg) state.error = msg.slice(0, 200), state.status = 'error', lastSwapFailed = true;
    } catch {}
    // An update that was unpacked but never applied leaves a big folder next to the install: use it
    // if it is complete and newer, else clear it (a relocating copy only clears it).
    if (canSelfUpdate() || relocate()) restoreStaged(lastSwapFailed);
    // A standard user's stale copy hands over first; the move prompt and the checks only start when it didn't.
    openNewerUserCopy().catch(() => false).then((handedOff) => {
      if (handedOff) return;
      // First launch from the dmg / Downloads: ask once, right away, to move to Applications (the
      // native dialog). Declining isn't final: the pill stays, and a new version asks once more.
      if (shouldOfferMove({ relocate: relocate(), version: null, ...promptedSettings() })) {
        setTimeout(() => {
          deps.writeSettings({ ...deps.readSettings(), movePromptedAt: Date.now() });
          moveToApplications().catch(() => {});
        }, 2500).unref?.();
      }
      wire(getUpdater());
      timer = setTimeout(function tick() {
        check();
        timer = setTimeout(tick, CHECK_EVERY_MS);
      }, FIRST_CHECK_MS + (deps.startupDelayMs?.() || 0));
    });
  }

  // Tests (test/updates.js, test/updates-units.js) swap in a stand-in updater and stager and pretend
  // to be a given kind of install.
  const testHooks = deps.test ? {
    useUpdater: (u) => { clearTimeout(timer); updater = lookOnly(u); wire(u); },
    useStager: (z) => { testStager = z; },
    stubQuit: (fn) => { io.quit = fn; emulateWillQuit = true; },
    stubMove: (fn) => { io.move = fn; },
    stubIo: (over) => Object.assign(io, over),
    setPlacement: (p) => { placement = p; publish(); },
    setKind: (k, replaceable = true) => { kind = k; mode = updateMode({ kind: k, replaceable: () => replaceable }); publish(); },
    restore: (lastSwapFailed) => restoreStaged(lastSwapFailed),
    openNewer: () => openNewerUserCopy(),
    dismiss: () => dismiss(),
    setState: (patch) => setState(patch),
    willQuit: () => applyOnQuit(),
    reset: () => { Object.assign(state, { status: 'idle', version: null, progress: 0, error: '' }); info = null; staged = null; dismissed = null; swapStarted = false; relaunchOnQuit = false; queued = false; relocateTo = null; moveError = ''; checkRunning = false; checkPromise = null; retrying = false; installFailed = false; publish(); },
  } : undefined;

  return { start, check, apply, applyOnQuit, state: snapshot, testHooks };
}

module.exports = {
  createUpdates, disabledReason, installKind, updateMode, macPlacement, isNewer, stageAsset, manualAsset,
  plistVersion, readBundleVersion, readBundleVersionSync, keepExisting, runningFrom, pickAppsDir, keepMessage, clickAction, shouldOfferMove, RELEASES_URL,
};
