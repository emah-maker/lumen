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
check('placement: an unwritable /Applications (standard user) is not helped by moving', !place('/Applications/Lumen.app/Contents/MacOS/Lumen', false).misplaced, '');

// ---- which file
const files = [{ url: 'Lumen-1.2.3-mac-arm64.zip', sha512: 'a' }, { url: 'https://github.com/x/y/releases/download/v1.2.3/Lumen-1.2.3-mac-x64.zip', sha512: 'b' }];
const s1 = U.stageAsset({ kind: 'mac', version: '1.2.3', arch: 'arm64', files });
check('asset: arm64 Mac stages the arm64 zip from the release', s1.name === 'Lumen-1.2.3-mac-arm64.zip' && s1.url === 'https://github.com/emah-maker/lumen/releases/download/v1.2.3/Lumen-1.2.3-mac-arm64.zip', JSON.stringify(s1));
check('asset: a listed https URL wins', U.stageAsset({ kind: 'mac', version: '1.2.3', arch: 'x64', files }).url.startsWith('https://github.com/x/y/'), '');
check('asset: Windows installs and zips stage the win zip', ['nsis', 'zip'].every((k) => U.stageAsset({ kind: k, version: '1.2.3', arch: 'x64' }).name === 'Lumen-1.2.3-win-x64.zip'), '');
check('asset: portable and other have nothing to stage', !U.stageAsset({ kind: 'portable', version: '1.2.3' }) && !U.stageAsset({ kind: 'other', version: '1.2.3' }), '');
check('asset: only a copy that cannot swap falls back to the dmg', U.manualAsset({ kind: 'mac', version: '1.2.3', arch: 'arm64' }).name === 'Lumen-1.2.3-mac-arm64.dmg' && U.manualAsset({ kind: 'nsis', version: '1.2.3' }) === null, '');
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

// ---- the mac swap script clears quarantine and never opens in quit-apply mode
const sh = Z.macSwapScript({ pid: 1, dir: '/Applications/Lumen.app', root: '/Applications/.Lumen.update/files/Lumen.app', old: '/Applications/Lumen.app.old', errFile: '/e', staging: '/Applications/.Lumen.update', self: '/Applications/.Lumen.update.sh' });
check('swap script: clears quarantine, renames in place, reopens', /xattr -cr "\$NEW"/.test(sh) && /mv "\$NEW" "\$APP"/.test(sh) && /open "\$APP"/.test(sh), '');
check('swap script: apply-on-quit does not reopen', !/open "\$APP"/.test(Z.macSwapScript({ pid: 1, dir: '/A/Lumen.app', root: '/A/n', old: '/A/o', errFile: '/e', staging: '/A/s', self: '/A/x', relaunch: false })), '');

// ---- installer settings
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build;
check('nsis: one click, per user (no admin), opens Lumen when done, both shortcuts', pkg.nsis.oneClick === true && pkg.nsis.perMachine === false && pkg.nsis.runAfterFinish !== false && pkg.nsis.createDesktopShortcut && pkg.nsis.createStartMenuShortcut, JSON.stringify(pkg.nsis));
check('nsis: the exe stays unedited (Smart App Control) and the profile survives uninstall', pkg.win.signAndEditExecutable === false && pkg.nsis.deleteAppDataOnUninstall === false, '');
check('dmg: drag Lumen onto an Applications link', (pkg.dmg.contents || []).some((c) => c.type === 'link' && c.path === '/Applications') && pkg.mac.target.some((t) => t.target === 'zip'), JSON.stringify(pkg.dmg));

console.log(failures ? `\n${failures} failed` : '\nall updates-units passed');
process.exit(failures ? 1 : 0);
