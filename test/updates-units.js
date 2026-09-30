// Update and install logic, pure node (no Electron, no network): where a Mac copy runs from
// (translocation, dmg), which zip/dmg each copy gets, version compare, checksum handling, and that
// package.json's installer settings keep the one-click, per-user, drag-to-Applications setup.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const U = require('../src/features/updates');
const Z = require('../src/features/zip-update');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const home = '/Users/me';
const place = (execPath, replaceable) => U.macPlacement({ execPath, home, replaceable });

// ---- where a Mac copy runs from
check('placement: Applications and writable is fine', !place('/Applications/Lumen.app/Contents/MacOS/Lumen', true).misplaced, '');
check('placement: ~/Applications is fine too', !place(`${home}/Applications/Lumen.app/Contents/MacOS/Lumen`, false).misplaced, '');
check('placement: App Translocation is misplaced even though it looks writable', place('/private/var/folders/ab/xyz/AppTranslocation/1234-UUID/d/Lumen.app/Contents/MacOS/Lumen', true).why === 'translocated', '');
check('placement: a read-only disk image is misplaced', place('/Volumes/Lumen/Lumen.app/Contents/MacOS/Lumen', false).why === 'dmg', '');
check('placement: a writable external-drive copy is left alone', !place('/Volumes/Work/Lumen.app/Contents/MacOS/Lumen', true).misplaced, '');
check('placement: an unwritable copy outside Applications is misplaced', place('/opt/Lumen.app/Contents/MacOS/Lumen', false).why === 'unwritable', '');
check('placement: ~/Downloads that is writable updates in place', !place(`${home}/Downloads/Lumen.app/Contents/MacOS/Lumen`, true).misplaced, '');
check('placement: an unwritable /Applications (standard user) is not misplaced but installs into ~/Applications', !place('/Applications/Lumen.app/Contents/MacOS/Lumen', false).misplaced && place('/Applications/Lumen.app/Contents/MacOS/Lumen', false).userApps === true && !place(`${home}/Applications/Lumen.app/Contents/MacOS/Lumen`, false).userApps, '');

// ---- which file
const files = [{ url: 'Lumen-1.2.3-mac-arm64.zip', sha512: 'a' }, { url: 'https://github.com/x/y/releases/download/v1.2.3/Lumen-1.2.3-mac-x64.zip', sha512: 'b' }];
const s1 = U.stageAsset({ kind: 'mac', version: '1.2.3', arch: 'arm64', files });
check('asset: arm64 Mac stages the arm64 zip from the release', s1.name === 'Lumen-1.2.3-mac-arm64.zip' && s1.url === 'https://github.com/emah-maker/lumen/releases/download/v1.2.3/Lumen-1.2.3-mac-arm64.zip', JSON.stringify(s1));
check('asset: a listed https URL wins', U.stageAsset({ kind: 'mac', version: '1.2.3', arch: 'x64', files }).url.startsWith('https://github.com/x/y/'), '');
check('asset: Windows installs and zips stage the win zip', ['nsis', 'zip'].every((k) => U.stageAsset({ kind: k, version: '1.2.3', arch: 'x64' }).name === 'Lumen-1.2.3-win-x64.zip'), '');
check('asset: portable and other have nothing to stage', !U.stageAsset({ kind: 'portable', version: '1.2.3' }) && !U.stageAsset({ kind: 'other', version: '1.2.3' }), '');
check('asset: only a copy that cannot swap falls back to the dmg / Setup exe', U.manualAsset({ kind: 'mac', version: '1.2.3', arch: 'arm64' }).name === 'Lumen-1.2.3-mac-arm64.dmg' && U.manualAsset({ kind: 'nsis', version: '1.2.3' }).name === 'Lumen-Setup-1.2.3.exe' && U.manualAsset({ kind: 'nsis', version: '1.2.3' }).url === 'https://github.com/emah-maker/lumen/releases/download/v1.2.3/Lumen-Setup-1.2.3.exe' && U.manualAsset({ kind: 'other', version: '1.2.3' }) === null, '');
check('mode: a replaceable mac copy self-updates, an unwritable one does not', U.updateMode({ kind: 'mac', replaceable: () => true }) === 'stage' && U.updateMode({ kind: 'mac', replaceable: () => false }) === 'manual', '');

// ---- versions
check('version: newer, equal, older, v prefix, multi-digit', U.isNewer('0.4.2', '0.4.1') && !U.isNewer('0.4.1', '0.4.1') && !U.isNewer('0.4.0', '0.4.1') && U.isNewer('v0.10.0', '0.9.9'), '');
check('version: a pre-release sorts before its release', U.isNewer('1.0.0', '1.0.0-beta.1') && !U.isNewer('1.0.0-beta.1', '1.0.0'), '');
check('version: garbage is never newer', !U.isNewer('', '0.4.1') && !U.isNewer(undefined, '0.4.1'), '');

// ---- checksums (sha512, base64, as latest*.yml lists them)
const bytes = Buffer.from('lumen update payload');
const b64 = crypto.createHash('sha512').update(bytes).digest('base64');
check('sha: the listed hash for a file name is found, also behind a URL', Z.expectedHash(files, 'Lumen-1.2.3-mac-x64.zip') === 'b' && Z.expectedHash(files, 'Lumen-1.2.3-mac-arm64.zip') === 'a' && Z.expectedHash(files, 'nope.zip') === '', '');
check('sha: a matching download passes, a flipped byte or a missing hash fails', Z.hashMatches(b64, b64)
  && !Z.hashMatches(crypto.createHash('sha512').update(Buffer.from('lumen update payloaD')).digest('base64'), b64) && !Z.hashMatches(b64, ''), '');

// ---- the synchronous bundle version (will-quit): XML plist directly, a binary one through /usr/bin/plutil on macOS only
{
  const xml = Buffer.from('<plist><dict><key>CFBundleShortVersionString</key><string>3.4.5</string></dict></plist>');
  const bin = Buffer.from('bplist00xx');
  const rs = (readFile, exec, platform = 'darwin') => U.readBundleVersionSync('/Applications/Lumen.app', { readFile, exec, platform });
  const seen = [];
  check('bundle version (sync): an XML plist is read directly, without running anything', rs(() => xml, () => { seen.push('ran'); return ''; }) === '3.4.5' && seen.length === 0, seen.join());
  check('bundle version (sync): a binary plist is converted with /usr/bin/plutil, not a bare plutil', rs(() => bin, (b, args) => { seen.push(b); return args.includes('xml1') ? xml.toString() : ''; }) === '3.4.5' && seen[0] === '/usr/bin/plutil', seen.join());
  check('bundle version (sync): a binary plist off macOS, an unreadable file or a failing plutil is null', rs(() => bin, () => xml.toString(), 'win32') === null && rs(() => { throw new Error('ENOENT'); }, () => xml.toString()) === null && rs(() => bin, () => { throw new Error('nope'); }) === null, '');
}

// ---- the mac swap script clears quarantine and never opens in quit-apply mode
const sh = Z.macSwapScript({ pid: 1, dir: '/Applications/Lumen.app', root: '/Applications/.Lumen.update/files/Lumen.app', old: '/Applications/Lumen.app.old', errFile: '/e', staging: '/Applications/.Lumen.update', self: '/Applications/.Lumen.update.sh' });
check('swap script: clears quarantine, renames in place, reopens', /xattr -cr "\$NEW"/.test(sh) && /mv "\$NEW" "\$APP"/.test(sh) && /open "\$APP"/.test(sh), '');
const shText = Z.macSwapScript({ pid: 1, dir: '/A/Lumen.app', root: '/A/n', old: '/A/o', errFile: '/e', staging: '/A/s', self: '/A/x' });
check('swap script: the error file gets only a short cause, not a whole sentence that the UI would repeat', /echo "\$\{1:-the update couldn’t be installed\}" > "\$ERR"/.test(shText) && !/old version was kept|couldn.t replace/.test(shText) && shText.includes('fail "Lumen didn’t quit in time"'), shText);
check('swap script: each failure names its own cause (missing files, move into place, unwritable folder); none defaults to "not writable"', shText.includes('if [ ! -d "$NEW" ]; then fail "the update files were missing"; fi') && shText.includes('fail "the update couldn’t be moved into place"') && shText.includes('fail "the Applications folder isn’t writable"') && !/^\s*fail\s*$/m.test(shText)
  && shText.indexOf('the update couldn’t be moved into place') < shText.indexOf('fail "the Applications folder isn’t writable"') && /if \[ ! -d "\$APP" \] \|\| mv "\$APP" "\$OLD"; then/.test(shText), shText);
check('swap script: apply-on-quit does not reopen', !/open "\$APP"/.test(Z.macSwapScript({ pid: 1, dir: '/A/Lumen.app', root: '/A/n', old: '/A/o', errFile: '/e', staging: '/A/s', self: '/A/x', relaunch: false })), '');

// ---- installer settings
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build;
check('nsis: one click, per user (no admin), opens Lumen when done, both shortcuts', pkg.nsis.oneClick === true && pkg.nsis.perMachine === false && pkg.nsis.runAfterFinish !== false && pkg.nsis.createDesktopShortcut && pkg.nsis.createStartMenuShortcut, JSON.stringify(pkg.nsis));
check('nsis: the exe stays unedited (Smart App Control) and the profile survives uninstall', pkg.win.signAndEditExecutable === false && pkg.nsis.deleteAppDataOnUninstall === false, '');
check('dmg: drag Lumen onto an Applications link', (pkg.dmg.contents || []).some((c) => c.type === 'link' && c.path === '/Applications') && pkg.mac.target.some((t) => t.target === 'zip'), JSON.stringify(pkg.dmg));

(async () => {
  // ---- pure helpers for a Lumen already in Applications, relocating and the click
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const plist = (v) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Lumen</string><key>CFBundleShortVersionString</key>\n\t<string>${v}</string></dict></plist>`;
  check('plist: the version comes out of an XML Info.plist', U.plistVersion(plist('1.4.2')) === '1.4.2' && U.plistVersion(Buffer.from(plist('0.10.0-beta.1'))) === '0.10.0-beta.1', '');
  check('plist: binary, empty or junk gives null, never a wrong version', U.plistVersion(Buffer.from('bplist00\u0001CFBundleShortVersionString')) === null && U.plistVersion('') === null && U.plistVersion(undefined) === null && U.plistVersion(plist('<script>')) === null && U.plistVersion('<key>CFBundleShortVersionString</key>') === null, '');

  // ---- reading it: XML directly; a binary plist through plutil, then defaults; else skipped with a warning
  const warned = [];
  const rv = (readFile, exec) => U.readBundleVersion('/Applications/Lumen.app', { readFile, exec, warn: (m) => warned.push(m) });
  check('bundle version: XML plist is parsed without running anything', await rv(async () => plist('2.0.0'), async () => { throw new Error('should not run'); }) === '2.0.0', '');
  check('bundle version: a missing app gives null quietly', await rv(async () => { throw new Error('ENOENT'); }, async () => '') === null && warned.length === 0, '');
  const calls = [];
  check('bundle version: a binary plist goes through plutil (json)', await rv(async () => Buffer.from('bplist00xx'), async (bin, args) => { calls.push(bin); return JSON.stringify({ CFBundleShortVersionString: '3.1.0' }); }) === '3.1.0' && calls[0] === '/usr/bin/plutil', calls.join());
  check('bundle version: plutil failing falls back to `defaults read`', await rv(async () => Buffer.from('bplist00xx'), async (bin) => { if (bin.endsWith('plutil')) throw new Error('nope'); return '3.2.0\n'; }) === '3.2.0', '');
  check('bundle version: nothing can read it -> null with a warning (the check is skipped)', await rv(async () => Buffer.from('bplist00xx'), async () => { throw new Error('nope'); }) === null && warned.length === 1, String(warned));

  check('keep: an equal or newer copy in Applications is kept, an older or unreadable one is replaced', U.keepExisting('2.0.0', '1.5.0') && U.keepExisting('1.5.0', '1.5.0') && !U.keepExisting('1.0.0', '1.5.0') && !U.keepExisting(null, '1.5.0') && U.keepExisting('1.0.0', '1.0.0-beta.1') && !U.keepExisting('1.0.0-beta.1', '1.0.0'), '');
  check('keep: the dialog text says newer or same', /newer Lumen \(2\.0\.0\)/.test(U.keepMessage('2.0.0', '1.5.0').message) && /Lumen 1\.5\.0 is already/.test(U.keepMessage('1.5.0', '1.5.0').message), '');
  const writable = (...ok) => (d) => ok.includes(d);
  check('apps dir: /Applications when writable, else ~/Applications (created), else nothing', U.pickAppsDir({ home: '/Users/me', canWrite: writable('/Applications'), mkdir() {} }) === '/Applications'
    && U.pickAppsDir({ home: '/Users/me/', canWrite: writable('/Users/me/Applications'), mkdir() {} }) === '/Users/me/Applications'
    && U.pickAppsDir({ home: '/Users/me', canWrite: writable(), mkdir() {} }) === null
    && U.pickAppsDir({ home: '', canWrite: writable(), mkdir() {} }) === null
    && U.pickAppsDir({ home: '/Users/me', canWrite: writable('/Users/me/Applications'), mkdir() { throw new Error('EACCES'); } }) === null, '');
  const pg = (out) => U.runningFrom('/Applications/Lumen.app', { pid: 100, exec: async (bin, args) => { if (out === null) throw new Error('exit 1'); pg.args = args; return out; } });
  check('running: another pid under the bundle counts, our own pid and "nothing found" do not', await pg('5555\n') === true && await pg('100\n') === false && await pg(null) === false && pg.args[0] === '-f' && /Applications\/Lumen\\\.app\/Contents\/MacOS\/$/.test(pg.args[1]), String(pg.args));

  // ---- the click state machine (pure): idle, downloading + queued, ready, apply, misplaced
  const st = (o) => U.clickAction({ disabled: null, canSelfUpdate: true, relocate: null, hasVersion: true, status: 'idle', queued: false, staged: false, autoDownload: true, ...o });
  check('click: nothing found yet does nothing (idle, checking, up to date)', ['idle', 'checking', 'up-to-date'].every((status) => st({ hasVersion: false, status }) === 'none'), '');
  check('click: disabled does nothing', st({ disabled: 'dev', status: 'downloaded', staged: true }) === 'none', '');
  check('click: downloading queues the update once, then waits', st({ status: 'downloading' }) === 'queue' && st({ status: 'downloading', queued: true }) === 'none', '');
  check('click: ready (staged) applies, in one click', st({ status: 'downloaded', staged: true }) === 'apply' && st({ status: 'downloaded', staged: false }) === 'none', '');
  check('click: found but not started (or failed) downloads and queues; with automatic downloads off it only downloads', st({ status: 'available' }) === 'download-queue' && st({ status: 'error' }) === 'download-queue' && st({ status: 'available', autoDownload: false }) === 'download', '');
  check('click: a copy that cannot install itself downloads the file', st({ canSelfUpdate: false, status: 'available' }) === 'manual', '');
  check('click: a misplaced Mac copy moves AND updates in one go (download-queue, then apply), or just moves with no update known', st({ canSelfUpdate: false, relocate: 'misplaced', status: 'available', autoDownload: false }) === 'download-queue' && st({ canSelfUpdate: false, relocate: 'misplaced', status: 'downloaded', staged: true }) === 'apply' && st({ canSelfUpdate: false, relocate: 'misplaced', hasVersion: false }) === 'move' && st({ canSelfUpdate: false, relocate: 'user', hasVersion: false }) === 'none', '');
  check('offer: a declined move is re-offered once per new version, never twice within an hour', !U.shouldOfferMove({ relocate: null, version: null }) && U.shouldOfferMove({ relocate: 'misplaced', version: null }) && !U.shouldOfferMove({ relocate: 'misplaced', version: null, promptedAt: 1 })
    && U.shouldOfferMove({ relocate: 'misplaced', version: '2.0.0', promptedAt: 1000, promptedVersion: '', now: 1000 + 3600e3 }) && !U.shouldOfferMove({ relocate: 'misplaced', version: '2.0.0', promptedAt: 1000, promptedVersion: '2.0.0', now: 1e12 })
    && !U.shouldOfferMove({ relocate: 'misplaced', version: '2.0.0', promptedAt: 1000, promptedVersion: '', now: 2000 }) && !U.shouldOfferMove({ relocate: 'user', version: '2.0.0' }), '');

  // ---- the controller, with a stand-in updater, stager and the outside world
  process.env.LUMEN_UPDATES_TEST = '1';
  const { EventEmitter } = require('events');
  const os = require('os');
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  function make({ veto = false, settings = {} } = {}) {
    const log = { quits: 0, swaps: [], stages: [], dialogs: [], saves: 0, settings, answer: 1, moves: 0, opened: [] };
    const fake = new EventEmitter();
    const app = { isPackaged: false, getVersion: () => '1.0.0', getPath: () => os.tmpdir(), quit() {}, moveToApplicationsFolder() {} };
    const u = U.createUpdates({ app, ipcMain: { handle() {} }, session: {}, ui: () => null, readSettings: () => log.settings, writeSettings: (s) => { log.settings = s; }, prefs: () => ({}), beforeInstall: () => { log.saves++; }, test: true });
    const h = u.testHooks;
    h.useUpdater(fake);
    const pending = [];
    h.useStager({ canReplace: () => true, canWriteDir: () => true, swapPaths: () => ({ staging: '/x' }),
      stage: (a) => { log.stages.push(a); return new Promise((res) => pending.push(() => res({ fake: a.execPath }))); },
      launchSwap: (a) => log.swaps.push(a) });
    if (veto) h.stubIo({ quit: () => { log.quits++; } }); else h.stubQuit(() => { log.quits++; });
    h.stubIo({ dialog: async (o) => { log.dialogs.push(o); return { response: log.answer }; }, openApp: (b) => log.opened.push(b), exists: () => false, running: async () => false, version: async () => null, versionSync: () => null, home: () => '/Users/me', canWrite: (d) => d === '/Applications', mkdir() {} });
    return { u, h, log, fake, emit: (v) => fake.emit('update-available', { version: v, files: [] }), finish: () => pending.shift()() };
  }

  // idle: a click with nothing to do changes nothing
  let t = make();
  await t.u.apply();
  check('flow idle: a click does nothing', t.u.state().status === 'idle' && t.log.quits === 0 && t.log.stages.length === 0 && t.log.swaps.length === 0, JSON.stringify(t.u.state()));

  // downloading + queued: found, downloads by itself; a click queues; it applies and relaunches when ready
  t = make(); t.h.setKind('nsis'); t.emit('2.0.0'); await flush();
  check('flow: an update found is downloaded in the background', t.u.state().status === 'downloading' && t.log.stages.length === 1 && !t.u.state().queued, JSON.stringify(t.u.state()));
  await t.u.apply();
  check('flow queued: a click while downloading queues, nothing quits yet, no dialog', t.u.state().queued === true && t.log.quits === 0 && t.log.swaps.length === 0 && t.log.dialogs.length === 0, JSON.stringify(t.u.state()));
  await t.u.apply();
  check('flow queued: a second click changes nothing', t.log.stages.length === 1 && t.log.quits === 0 && t.u.state().queued === true, '');
  t.finish(); await flush();
  check('flow queued: when ready it applies and relaunches by itself (one swap, one quit, session saved)', t.log.quits === 1 && t.log.swaps.length === 1 && t.log.swaps[0].relaunch === true && t.log.saves === 1 && t.u.state().queued === false, JSON.stringify(t.log.swaps));

  // ready + apply: one click restarts, no second dialog
  t = make(); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); t.finish(); await flush();
  check('flow ready: the update is staged and waiting (no restart on its own)', t.u.state().status === 'downloaded' && t.log.quits === 0 && t.log.swaps.length === 0, '');
  await t.u.apply();
  check('flow apply: one click relaunches into it, with no dialog', t.log.quits === 1 && t.log.swaps.length === 1 && t.log.swaps[0].relaunch === true && t.log.dialogs.length === 0, JSON.stringify(t.log.swaps));

  // the quit is cancelled (before-quit vetoed): the swap helper is not started, so no false "couldn't replace" error
  t = make({ veto: true }); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); t.finish(); await flush();
  await t.u.apply();
  check('flow veto: the helper only starts at will-quit, so a cancelled quit starts none', t.log.quits === 1 && t.log.swaps.length === 0, JSON.stringify(t.log.swaps));
  t.h.willQuit();
  check('flow veto: when the quit does happen the helper starts and relaunches', t.log.swaps.length === 1 && t.log.swaps[0].relaunch === true, '');
  t = make({ veto: true }); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); t.finish(); await flush();
  t.h.willQuit();
  check('flow quit: a plain quit with an update ready installs it without reopening Lumen', t.log.swaps.length === 1 && t.log.swaps[0].relaunch === false, '');

  // misplaced Mac copy: one click = install the update into Applications, then apply and relaunch
  const dmg = () => { const m = make(); m.h.setKind('mac', false); m.h.setPlacement({ misplaced: true, why: 'dmg' }); return m; };
  t = dmg(); t.emit('2.0.0'); await flush();
  check('flow misplaced: a new version asks once (Move and update / Not now), downloads nothing yet', t.log.dialogs.length === 1 && t.log.dialogs[0].buttons[0] === 'Move and update' && t.log.stages.length === 0 && t.log.settings.movePromptedVersion === '2.0.0' && t.u.state().relocate === 'misplaced' && t.u.state().asset === null, JSON.stringify(t.log.settings));
  t.emit('2.0.0'); await flush();
  check('flow misplaced: the same version is not asked again', t.log.dialogs.length === 1, '');
  await t.u.apply();
  check('flow misplaced: the click stages the update INSIDE /Applications, queued', t.log.stages.length === 1 && t.log.stages[0].execPath.startsWith('/Applications/Lumen.app/Contents/MacOS/') && t.u.state().queued === true && t.u.state().moveError === '', JSON.stringify(t.log.stages.map((s) => s.execPath)));
  t.finish(); await flush();
  check('flow misplaced: then it applies and relaunches (no separate move step, no extra dialog)', t.log.quits === 1 && t.log.swaps.length === 1 && t.log.swaps[0].relaunch === true && t.log.dialogs.length === 1 && t.log.settings.movePromptedVersion === '2.0.0', JSON.stringify(t.log.swaps));
  t = dmg(); t.log.answer = 0; t.emit('2.0.0'); await flush();
  check('flow misplaced: answering "Move and update" to the dialog does the whole thing', t.log.stages.length === 1 && t.u.state().queued === true, '');
  t = dmg(); t.log.settings = { movePromptedAt: Date.now(), movePromptedVersion: '' }; t.emit('2.0.0'); await flush();
  check('flow misplaced: no second dialog right after the launch prompt; the pill still shows', t.log.dialogs.length === 0 && t.u.state().status === 'available' && t.u.state().relocate === 'misplaced', '');
  t = dmg(); t.log.settings = { movePromptedAt: Date.now() - 2 * 3600e3, movePromptedVersion: '1.9.0' }; t.emit('2.0.0'); await flush();
  check('flow misplaced: a new version later asks again', t.log.dialogs.length === 1 && t.log.settings.movePromptedVersion === '2.0.0', '');

  // a newer Lumen is already in Applications: not overwritten, offered instead
  t = dmg(); t.h.stubIo({ exists: () => true, version: async () => '3.0.0' }); t.log.settings = { movePromptedAt: 1, movePromptedVersion: '2.0.0' }; t.emit('2.0.0'); await flush();
  await t.u.apply();
  check('flow newer copy: nothing is downloaded or overwritten, and it offers to open the newer one', t.log.stages.length === 0 && t.log.dialogs.length === 1 && /newer Lumen \(3\.0\.0\)/.test(t.log.dialogs[0].message) && t.u.state().queued === false, JSON.stringify(t.log.dialogs));
  t = dmg(); t.h.stubIo({ exists: () => true, version: async () => '3.0.0' }); t.log.answer = 0; t.log.settings = { movePromptedAt: 1, movePromptedVersion: '2.0.0' }; t.emit('2.0.0'); await flush();
  await t.u.apply();
  check('flow newer copy: "Open it" opens that copy and quits this one', eq(t.log.opened, ['/Applications/Lumen.app']) && t.log.quits === 1, JSON.stringify(t.log.opened));
  // an older copy there is replaced; one that is running is not
  t = dmg(); t.h.stubIo({ exists: () => true, version: async () => '1.5.0' }); t.log.settings = { movePromptedAt: 1, movePromptedVersion: '2.0.0' }; t.emit('2.0.0'); await flush();
  await t.u.apply();
  check('flow older copy: it is replaced by the update', t.log.stages.length === 1 && t.log.dialogs.length === 0, '');
  t = dmg(); t.h.stubIo({ exists: () => true, running: async () => true }); t.log.settings = { movePromptedAt: 1, movePromptedVersion: '2.0.0' }; t.emit('2.0.0'); await flush();
  await t.u.apply();
  check('flow running copy: the message says to quit the other Lumen, nothing is downloaded', t.log.stages.length === 0 && /Quit the other Lumen/.test(t.u.state().moveError) && t.u.state().queued === false, t.u.state().moveError);
  t.h.stubIo({ running: async () => false }); await t.u.apply();
  check('flow running copy: quitting the other one and clicking again goes through', t.u.state().moveError === '' && t.log.stages.length === 1, '');

  // a standard user's /Applications: the update goes to ~/Applications
  t = make(); t.h.setKind('mac', false); t.h.setPlacement({ misplaced: false, why: null, userApps: true }); t.h.stubIo({ canWrite: (d) => d === '/Users/me/Applications' });
  t.emit('2.0.0'); await flush();
  check('flow non-admin /Applications: no dialog, the pill offers it', t.log.dialogs.length === 0 && t.u.state().relocate === 'user' && t.u.state().status === 'available', '');
  await t.u.apply();
  check('flow non-admin /Applications: one click stages into ~/Applications, then relaunches from there', t.log.stages.length === 1 && t.log.stages[0].execPath.startsWith('/Users/me/Applications/Lumen.app/'), JSON.stringify(t.log.stages.map((s) => s.execPath)));
  t.finish(); await flush();
  check('flow non-admin /Applications: applied and relaunched', t.log.quits === 1 && t.log.swaps.length === 1, '');

  // a failed download while queued: not applied, shows the error, a retry works
  t = make(); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); await t.u.apply();
  t.h.useStager({ canReplace: () => true, swapPaths: () => ({ staging: '/x' }), stage: async () => { throw new Error('the download failed its checksum'); }, launchSwap: (a) => t.log.swaps.push(a) });
  t.h.setState({ status: 'available' }); await t.u.apply(); await flush();
  check('flow failure: a failed download is shown and nothing is applied', t.u.state().status === 'error' && /checksum/.test(t.u.state().error) && t.log.quits === 0 && t.u.state().queued === false, JSON.stringify(t.u.state()));

  // the plain move (no update known): the native flow, with the downgrade check and errors shown
  const mv = (over = {}) => { const m = dmg(); m.h.stubIo({ exists: () => true, version: async () => null, ...over }); return m; };
  t = mv({ version: async () => '1.0.0' }); t.h.stubMove(() => { t.log.moves++; return true; });
  await t.u.apply();
  check('plain move: an equal copy in Applications is kept and offered, the native move is not run', t.log.moves === 0 && t.log.dialogs.length === 1, JSON.stringify(t.log.dialogs));
  t = mv(); t.h.stubMove(() => { t.log.moves++; return true; });
  await t.u.apply();
  check('plain move: an unreadable version skips the check and moves', t.log.moves === 1 && t.log.dialogs.length === 0 && t.u.state().moveError === '', '');
  t = mv(); t.h.stubMove((o) => { t.log.conflict = [o.conflictHandler('exists'), o.conflictHandler('existsAndRunning')]; return false; });
  await t.u.apply();
  check('plain move: replaces an older copy, and a running one is refused with a clear message', eq(t.log.conflict, [true, false]) && /Quit the other Lumen/.test(t.u.state().moveError), JSON.stringify(t.log.conflict));
  t = mv(); t.h.stubMove(() => { throw new Error('Permission denied'); });
  await t.u.apply();
  check('plain move: a failed move is shown, not swallowed', /Permission denied/.test(t.u.state().moveError) && t.u.state().status === 'idle', t.u.state().moveError);

  // a failed swap (the error marker): the version that couldn't be installed is known, so the pill and Settings say so
  t = make(); t.h.setKind('nsis');
  t.h.useStager({ canReplace: () => true, swapPaths: () => ({ staging: '/x' }), readMarker: () => ({ version: '2.0.0' }), stage: (a) => { t.log.stages.push(a); return new Promise(() => {}); }, launchSwap: (a) => t.log.swaps.push(a) });
  t.h.setState({ status: 'error', error: 'Lumen couldn’t replace its files' }); t.h.restore(true);
  check('failed swap: the status is an error that names the version, so the pill shows', t.u.state().status === 'error' && t.u.state().version === '2.0.0' && /couldn’t replace/.test(t.u.state().error), JSON.stringify(t.u.state()));
  t.fake.checkForUpdates = async () => { t.fake.emit('update-available', { version: '2.0.0', files: [] }); return { updateInfo: { version: '2.0.0' } }; };
  await t.u.apply(); await new Promise((r) => setTimeout(r, 50)); // the old staging folder is deleted first
  check('failed swap: Try again (no release info after a restart) looks the update up, then downloads it', t.log.stages.length === 1 && t.u.state().status === 'downloading', JSON.stringify(t.u.state()));

  // Try again is one click: the re-check's update-available goes straight to downloading and applying
  t = dmg(); t.h.setState({ status: 'error', version: '2.0.0', error: 'the download failed' });
  t.fake.checkForUpdates = async () => { t.emit('2.0.0'); return { updateInfo: { version: '2.0.0' } }; };
  await t.u.apply(); await flush();
  check('try again (relocating copy): one click stages into /Applications, queued, with no move dialog', t.log.stages.length === 1 && t.log.stages[0].execPath.startsWith('/Applications/Lumen.app/') && t.u.state().queued === true && t.log.dialogs.length === 0, JSON.stringify(t.u.state()));
  t.finish(); await flush();
  check('try again (relocating copy): it then applies and relaunches by itself', t.log.quits === 1 && t.log.swaps.length === 1 && t.log.swaps[0].relaunch === true, JSON.stringify(t.log.swaps));
  const off = U.createUpdates({ app: { isPackaged: false, getVersion: () => '1.0.0', getPath: () => os.tmpdir(), quit() {}, moveToApplicationsFolder() {} }, ipcMain: { handle() {} }, session: {}, ui: () => null, readSettings: () => ({}), writeSettings() {}, prefs: () => ({ autoDownloadUpdates: false }), beforeInstall() {}, test: true });
  const offLog = []; const offFake = new EventEmitter();
  off.testHooks.useUpdater(offFake); off.testHooks.setKind('nsis'); off.testHooks.stubQuit(() => offLog.push('quit'));
  off.testHooks.useStager({ canReplace: () => true, canWriteDir: () => true, swapPaths: () => ({ staging: '/x' }), stage: async () => { offLog.push('stage'); return {}; }, launchSwap: () => offLog.push('swap') });
  off.testHooks.setState({ status: 'error', version: '2.0.0', error: 'x' });
  offFake.checkForUpdates = async () => { offFake.emit('update-available', { version: '2.0.0', files: [] }); return { updateInfo: { version: '2.0.0' } }; };
  await off.apply(); await flush();
  check('try again (automatic downloads off): still one click to download, apply and restart', eq(offLog, ['stage', 'quit', 'swap']), offLog.join());
  t = make(); t.h.setKind('nsis'); t.h.setState({ status: 'error', version: '2.0.0', error: 'x' });
  t.fake.checkForUpdates = async () => ({ updateInfo: { version: '1.0.0' } });
  await t.u.apply(); t.emit('2.1.0'); await flush();
  check('try again: the retry flag does not outlive its check (a later find downloads but is not queued)', t.u.state().queued === false && t.u.state().status === 'downloading', JSON.stringify(t.u.state()));

  // Try again while a background check is already running: it waits for that check and downloads what it finds
  t = make(); t.h.setKind('nsis'); t.h.setState({ status: 'error', version: '2.0.0', error: 'x' });
  let release; const gate = new Promise((r) => { release = r; });
  t.fake.checkForUpdates = async () => { await gate; t.emit('2.0.0'); return { updateInfo: { version: '2.0.0' } }; };
  const bg = t.u.check(); await flush();
  check('try again during a background check: the check is in flight', t.u.state().checking === true, JSON.stringify(t.u.state()));
  const retry = t.u.apply(); await flush();
  release(); await Promise.all([bg, retry]); await flush();
  check('try again during a background check: it waits for that check instead of doing nothing, then stages and queues', t.log.stages.length === 1 && t.u.state().queued === true && t.u.state().status === 'downloading', JSON.stringify(t.u.state()));
  t.finish(); await flush();
  check('try again during a background check: it then applies and relaunches', t.log.quits === 1 && t.log.swaps.length === 1 && t.log.swaps[0].relaunch === true, JSON.stringify(t.log.swaps));
  t = make(); t.h.setKind('nsis'); t.h.setState({ status: 'error', version: '2.0.0', error: 'x' });
  t.fake.checkForUpdates = async () => ({ updateInfo: { version: '1.0.0' } });
  await t.u.check(); await t.u.apply(); t.emit('2.1.0'); await flush();
  check('try again: the retry flag is cleared after a wait too (a later find is not queued)', t.u.state().queued === false, JSON.stringify(t.u.state()));

  // "checking" is a flag on top of the old status, so the buttons show progress without the prompt flickering
  t = make(); t.h.setKind('nsis'); t.h.setState({ status: 'error', version: '2.0.0', error: 'x' }); let mid = null;
  t.fake.checkForUpdates = async () => { mid = t.u.state(); return { updateInfo: { version: '2.0.0' } }; };
  check('checking: false when idle', t.u.state().checking === false, '');
  await t.u.check();
  check('checking: true during a check with a version known, the old status stays, and it clears after', mid.checking === true && mid.status === 'error' && t.u.state().checking === false, JSON.stringify(mid));
  t = make(); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); t.finish(); await flush(); mid = null;
  t.fake.checkForUpdates = async () => { mid = t.u.state(); return { updateInfo: { version: '2.0.0' } }; };
  await t.u.check();
  check('checking: also set over "Restart to update" without changing it', mid.checking === true && mid.status === 'downloaded', JSON.stringify(mid));

  // a failed swap that left a marker: the version is named, it is an install failure, and a fresh stage installs on quit again
  t = make(); t.h.setKind('nsis');
  t.h.useStager({ canReplace: () => true, swapPaths: () => ({ staging: '/x' }), readMarker: () => ({ version: '2.0.0' }), stage: (a) => { t.log.stages.push(a); return Promise.resolve({ fake: 1 }); }, launchSwap: (a) => t.log.swaps.push(a) });
  t.h.setState({ status: 'error', error: 'the Applications folder isn’t writable' }); t.h.restore(true);
  check('failed swap (marker): the version is named and it counts as an install failure', t.u.state().version === '2.0.0' && t.u.state().installFailed === true && t.u.state().status === 'error' && !('blocked' in t.u.state()), JSON.stringify(t.u.state()));
  t.fake.checkForUpdates = async () => { t.emit('2.0.0'); return { updateInfo: { version: '2.0.0' } }; };
  await t.u.check(); await new Promise((r) => setTimeout(r, 50)); await flush(); // the old staging folder is deleted first
  check('failed swap (marker): a fresh successful stage clears the failure and is "Restart to update"', t.u.state().status === 'downloaded' && t.u.state().installFailed === false, JSON.stringify(t.u.state()));
  t.h.willQuit();
  check('failed swap (marker): a plain quit then installs the new stage (no relaunch)', t.log.swaps.length === 1 && t.log.swaps[0].relaunch === false, JSON.stringify(t.log.swaps));

  // a failed swap with no marker left: the version is unknown, so it is an install failure, not a failed check
  t = make(); t.h.setKind('nsis');
  t.h.useStager({ canReplace: () => true, swapPaths: () => ({ staging: '/x' }), readMarker: () => null, stage: (a) => { t.log.stages.push(a); return new Promise(() => {}); }, launchSwap: (a) => t.log.swaps.push(a) });
  t.h.setState({ status: 'error', error: 'Lumen couldn’t replace its files' }); t.h.restore(true);
  check('no marker: version stays null but installFailed is set, so the UI does not say "couldn’t check"', t.u.state().version === null && t.u.state().installFailed === true && t.u.state().status === 'error', JSON.stringify(t.u.state()));
  t.fake.checkForUpdates = async () => { t.emit('2.0.0'); return { updateInfo: { version: '2.0.0' } }; };
  await t.u.apply(); await new Promise((r) => setTimeout(r, 50));
  check('no marker: Try again looks the update up and downloads it in one click, and the flag clears', t.log.stages.length === 1 && t.u.state().installFailed === false && t.u.state().queued === true, JSON.stringify(t.u.state()));
  t = make(); t.h.setKind('nsis'); t.h.setState({ status: 'error', error: 'x' }); t.h.restore(false);
  check('no marker: an ordinary check error is not an install failure', t.u.state().installFailed === false, '');

  // Try again over a failed install: when the re-check itself fails, the pill and Settings get the new cause
  t = make(); t.h.setKind('nsis');
  t.h.useStager({ canReplace: () => true, swapPaths: () => ({ staging: '/x' }), readMarker: () => ({ version: '2.0.0' }), stage: (a) => { t.log.stages.push(a); return new Promise(() => {}); }, launchSwap: (a) => t.log.swaps.push(a) });
  t.h.setState({ status: 'error', error: 'the Applications folder isn’t writable' }); t.h.restore(true);
  t.fake.checkForUpdates = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
  await t.u.apply();
  check('try again: a failed re-check records the new cause and keeps the install failure and its version', t.u.state().error === 'net::ERR_INTERNET_DISCONNECTED' && t.u.state().installFailed === true && t.u.state().version === '2.0.0' && t.u.state().status === 'error' && t.u.state().checking === false, JSON.stringify(t.u.state()));

  // the pill's x for an install failure that names no version
  t = make(); t.h.setKind('nsis');
  t.h.useStager({ canReplace: () => true, swapPaths: () => ({ staging: '/x' }), readMarker: () => null, stage: () => new Promise(() => {}), launchSwap() {} });
  t.h.setState({ status: 'error', error: 'Lumen couldn’t replace its files' }); t.h.restore(true);
  const beforeX = t.u.state();
  const afterX = t.h.dismiss();
  check('dismiss: a version-less install failure can be closed (the pill x), and stays closed on the next snapshot', beforeX.installFailed === true && beforeX.version === null && beforeX.dismissed === false && afterX.dismissed === true && t.u.state().dismissed === true, JSON.stringify(afterX));

  // a standard user's old /Applications copy hands over to the newer ~/Applications one
  const user = (existing) => { const m = make(); m.h.setKind('mac', false); m.h.setPlacement({ misplaced: false, why: null, userApps: true }); m.h.stubIo({ exists: () => true, version: async () => existing }); return m; };
  t = user('3.0.0');
  check('newer user copy: the old /Applications copy opens ~/Applications and quits, without a dialog, after saving the session', await t.h.openNewer() === true && eq(t.log.opened, ['/Users/me/Applications/Lumen.app']) && t.log.quits === 1 && t.log.dialogs.length === 0 && t.log.saves === 1, JSON.stringify(t.log.opened));
  t = user('1.0.0');
  check('newer user copy: an equal or older one there does nothing', await t.h.openNewer() === false && t.log.opened.length === 0 && t.log.quits === 0 && t.log.saves === 0, '');
  t = dmg(); t.h.stubIo({ exists: () => true, version: async () => '3.0.0' });
  check('newer user copy: only for the /Applications-as-standard-user case', await t.h.openNewer() === false && t.log.quits === 0, '');

  t = make(); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); t.finish(); await flush();
  t = make(); t.h.setKind('nsis'); t.emit('2.0.0'); await flush(); t.finish(); await flush();
  let seen = '';
  t.fake.checkForUpdates = async () => { seen = t.u.state().status; t.fake.emit('update-available', { version: '2.0.0', files: [] }); return { updateInfo: { version: '2.0.0' } }; };
  await t.u.check();
  check('check while downloaded: the same version changes nothing (no restage, still Restart to update)', seen === 'downloaded' && t.u.state().status === 'downloaded' && t.log.stages.length === 1, seen + t.log.stages.length + t.u.state().status);
  t.fake.checkForUpdates = async () => { t.fake.emit('update-available', { version: '2.1.0', files: [] }); return { updateInfo: { version: '2.1.0' } }; };
  await t.u.check(); await flush();
  check('check while downloaded: a newer version is staged instead', t.log.stages.length === 2 && t.u.state().status === 'downloading' && t.u.state().version === '2.1.0', JSON.stringify(t.u.state()));
  t.finish(); await flush();
  t.fake.checkForUpdates = async () => { t.fake.emit('error', new Error('offline')); throw new Error('offline'); };
  await t.u.check();
  check('check while downloaded: a failed re-check keeps the ready update', t.u.state().status === 'downloaded' && t.u.state().version === '2.1.0', JSON.stringify(t.u.state()));
  t = make(); let first = '';
  t.fake.checkForUpdates = async () => { first = t.u.state().status; return { updateInfo: { version: '1.0.0' } }; };
  await t.u.check();
  check('check with nothing known shows "checking", then up to date', first === 'checking' && t.u.state().status === 'up-to-date', first);

  // a newer Lumen appeared at the install target after the download: quitting doesn't overwrite it
  t = dmg(); t.emit('2.0.0'); await flush(); await t.u.apply();
  t.h.stubIo({ exists: () => true, versionSync: () => '3.0.0' });
  t.finish(); await flush();
  check('downgrade at quit: a newer copy at the target is kept, nothing is swapped, and Restart opens it instead', t.log.swaps.length === 0 && eq(t.log.opened, ['/Applications/Lumen.app']), JSON.stringify(t.log.swaps));
  t = dmg(); t.emit('2.0.0'); await flush(); await t.u.apply();
  t.h.stubIo({ exists: () => true, versionSync: () => '1.5.0' });
  t.finish(); await flush();
  check('downgrade at quit: an older copy at the target is replaced as usual', t.log.swaps.length === 1, JSON.stringify(t.log.swaps));

  // ---- the mac swap script can install where there was nothing before
  const fresh = Z.macSwapScript({ pid: 1, dir: '/Applications/Lumen.app', root: '/Applications/.Lumen.update/files/Lumen.app', old: '/Applications/Lumen.app.old', errFile: '/e', staging: '/Applications/.Lumen.update', self: '/Applications/.Lumen.update.sh' });
  check('swap script: a first install (no old app) still moves the new one in, and rollback only with an old one', fresh.includes('[ ! -d "$APP" ] || mv "$APP" "$OLD"') && fresh.includes('[ -d "$OLD" ] && mv "$OLD" "$APP"'), fresh);
  const reopened = Z.macSwapScript({ pid: 1, dir: '/Applications/Lumen.app', root: '/n', old: '/o', errFile: '/e', staging: '/s', self: '/x', orig: '/Volumes/Lumen/Lumen.app' });
  check('swap script: a failed relocation reopens the original bundle when the target is missing', /ORIG='\/Volumes\/Lumen\/Lumen\.app'/.test(reopened) && reopened.includes('elif [ -n "$ORIG" ] && [ -d "$ORIG" ]; then open "$ORIG"'), reopened);
  check('write probe: canWriteDir follows the probe', Z.canWriteDir('/x', () => {}) === true && Z.canWriteDir('/x', () => { throw new Error('EACCES'); }) === false, '');


  // ---- every string key the update screens ask for exists in en.json (ut() is updates.settings.*)
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/locales/en.json'), 'utf8'));
  for (const file of ['settings-updates.js', 'updates.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
    const keys = new Set();
    for (const m of src.matchAll(/(?<![\w.])ut\(\s*'([^']+)'/g)) keys.add(`updates.settings.${m[1]}`);
    for (const m of src.matchAll(/(?<![\w.])ut\(\s*[^'()]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) { keys.add(`updates.settings.${m[1]}`); keys.add(`updates.settings.${m[2]}`); }
    for (const m of src.matchAll(/(?:window\.t|(?<![\w.])t)\(\s*'([^']+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/'(updates\.[\w.]+)'/g)) keys.add(m[1]); // keys picked by a ternary, then passed to window.t(key)
    const missing = [...keys].filter((k) => !(k in en));
    check(`locale keys: ${file} uses ${keys.size} keys and all exist in en.json`, keys.size > 0 && missing.length === 0, missing.join(', '));
  }

  console.log(failures ? String.fromCharCode(10) + failures + ' failed' : String.fromCharCode(10) + 'all updates-units passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
