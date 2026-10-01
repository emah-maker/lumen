// Pure unit test for scripts/signing.js (which macOS signing path a build takes, and the
// electron-builder flags for it), the after-sign guard, the entitlements files, and that the Mac
// update swap never touches a code signature. No Mac, certificate or network needed.
const fs = require('fs');
const path = require('path');
const S = require('../scripts/signing');
const AS = require('../scripts/after-sign');
const Z = require('../src/features/zip-update');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const root = path.join(__dirname, '..');

const dev = { CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' };
const apiKey = { APPLE_API_KEY: '/tmp/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' };
const appleId = { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' };

check('no secrets: ad-hoc, no notarization, no EVS', JSON.stringify(S.macSigning({})) === JSON.stringify({ mode: 'ad-hoc', notarize: null, partialNotarization: null, dropAppleId: false, evs: false }), JSON.stringify(S.macSigning({})));
check('empty or blank values count as missing', S.macSigning({ CSC_LINK: '  ', CSC_KEY_PASSWORD: '' }).mode === 'ad-hoc', '');
check('the self-signed pair alone is the self-signed mode', S.macSigning({ LUMEN_SIGN_P12: 'a', LUMEN_SIGN_PASSWORD: 'b' }).mode === 'self-signed', '');
check('half a certificate is not Developer ID', S.macSigning({ CSC_LINK: 'x' }).mode === 'ad-hoc', '');
check('Developer ID beats the self-signed pair', S.macSigning({ ...dev, LUMEN_SIGN_P12: 'a', LUMEN_SIGN_PASSWORD: 'b' }).mode === 'developer-id', '');
check('Developer ID without Apple credentials: signed, not notarized', S.macSigning(dev).notarize === null, '');
check('API key route', S.macSigning({ ...dev, ...apiKey }).notarize === 'api-key', '');
check('Apple ID route', S.macSigning({ ...dev, ...appleId }).notarize === 'apple-id', '');
const both = S.macSigning({ ...dev, ...apiKey, ...appleId });
check('both routes: the API key wins and the Apple ID variables are dropped', both.notarize === 'api-key' && both.dropAppleId, JSON.stringify(both));
check('a half-set group is reported, not silently ignored', S.macSigning({ ...dev, APPLE_API_KEY: 'k' }).partialNotarization === 'APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER' && S.macSigning({ ...dev, APPLE_ID: 'a' }).partialNotarization.startsWith('APPLE_ID'), '');
check('Apple credentials without a certificate never notarize', S.macSigning(apiKey).notarize === null, '');
check('EVS needs both the account and the password', S.macSigning({ EVS_ACCOUNT_NAME: 'a' }).evs === false && S.macSigning({ EVS_ACCOUNT_NAME: 'a', EVS_PASSWD: 'b' }).evs === true, '');

check('flags: no certificate is the old build (ad-hoc identity, notarization off even with stray APPLE_*)', JSON.stringify(S.builderArgs(apiKey)) === JSON.stringify(['-c.mac.identity=-', '-c.mac.notarize=false']), JSON.stringify(S.builderArgs(apiKey)));
check('flags: Developer ID turns the hardened runtime on and drops the ad-hoc identity', JSON.stringify(S.builderArgs({ ...dev, ...apiKey })) === JSON.stringify(['-c.mac.hardenedRuntime=true', '-c.mac.notarize=true']), JSON.stringify(S.builderArgs({ ...dev, ...apiKey })));
check('flags: Developer ID without Apple credentials signs but does not notarize', S.builderArgs(dev).includes('-c.mac.notarize=false') && S.builderArgs(dev).includes('-c.mac.hardenedRuntime=true'), '');
const env = S.builderEnv({ ...dev, ...apiKey, ...appleId, CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
check('env: Developer ID re-enables certificate lookup and removes the Apple ID variables', env.CSC_IDENTITY_AUTO_DISCOVERY === 'true' && !('APPLE_ID' in env) && env.APPLE_API_KEY === apiKey.APPLE_API_KEY, JSON.stringify(Object.keys(env)));
const plain = { CSC_IDENTITY_AUTO_DISCOVERY: 'false', FOO: '1' };
check('env: any other mode passes the environment through untouched', S.builderEnv(plain) === plain, '');
const kcEnv = S.builderEnv({ ...dev, ...appleId, LUMEN_KEYCHAIN: '/tmp/x.keychain-db' });
check('env: a pre-imported keychain replaces the CSC_LINK import', kcEnv.CSC_KEYCHAIN === '/tmp/x.keychain-db' && !('CSC_LINK' in kcEnv) && !('CSC_KEY_PASSWORD' in kcEnv) && S.macSigning({ ...dev, LUMEN_KEYCHAIN: 'x' }).mode === 'developer-id', JSON.stringify(Object.keys(kcEnv)));

check('after-sign: only the ad-hoc identity is re-signed with the self-signed certificate', AS.isAdHocBuild('-') && !AS.isAdHocBuild(undefined) && !AS.isAdHocBuild('Developer ID Application: X (ABCDE12345)'), '');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
check('package.json: the ad-hoc defaults stay (hardened runtime off), the identity comes from scripts/signing.js', pkg.mac.hardenedRuntime === false && pkg.mac.gatekeeperAssess === false && !('identity' in pkg.mac), JSON.stringify(pkg.mac));
check('package.json: afterPack (VMP) and afterSign are set, and the entitlements files exist', pkg.afterPack && pkg.afterSign && [pkg.mac.entitlements, pkg.mac.entitlementsInherit].every((f) => fs.existsSync(path.join(root, f))), '');
check('package.json: camera and microphone usage strings for the macOS permission prompt', pkg.mac.extendInfo.NSCameraUsageDescription && pkg.mac.extendInfo.NSMicrophoneUsageDescription, '');

const keys = (f) => [...fs.readFileSync(path.join(root, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]);
for (const f of [pkg.mac.entitlements, pkg.mac.entitlementsInherit]) {
  const k = keys(f);
  check(`${f}: JIT, unsigned executable memory, Widevine library validation, camera, microphone`, ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation'].every((e) => k.includes(`com.apple.security.cs.${e}`)) && k.includes('com.apple.security.device.camera') && k.includes('com.apple.security.device.audio-input'), k.join());
  check(`${f}: no dyld injection and no sandbox`, !k.some((e) => /allow-dyld-environment-variables|app-sandbox/.test(e)), k.join());
}

const sh = Z.macSwapScript({ pid: 1, dir: '/Applications/Lumen.app', root: '/n/Lumen.app', old: '/o', errFile: '/e', staging: '/s', self: '/x' });
check('swap script: never signs or strips a signature, only renames bundles and clears extended attributes', !/codesign|xattr -d /.test(sh) && /xattr -cr "\$NEW"/.test(sh), sh);

// ---- Windows: SignPath (scripts/signing.js winSigning, the workflow, the artifact configurations) ----
const sp = { SIGNPATH_API_TOKEN: 't', SIGNPATH_ORGANIZATION_ID: 'o', SIGNPATH_PROJECT_SLUG: 'lumen' };
const w0 = S.winSigning({});
check('windows: no secrets is the unsigned build', !w0.enabled && !w0.signApp && w0.partial === null && w0.invalid === null, JSON.stringify(w0));
check('windows: the token, organization id and project slug are all needed', S.winSigning(sp).enabled && ['SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG'].every((k) => { const e = { ...sp }; delete e[k]; return !S.winSigning(e).enabled; }), '');
check('windows: blank values count as missing', !S.winSigning({ ...sp, SIGNPATH_API_TOKEN: '  ' }).enabled, '');
check('windows: a half-set group is reported, not silently built unsigned', JSON.stringify(S.winSigning({ SIGNPATH_API_TOKEN: 't' }).partial) === JSON.stringify(['SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG']) && S.winSigning({}).partial === null, JSON.stringify(S.winSigning({ SIGNPATH_API_TOKEN: 't' })));
check('windows: a tag build defaults to the release policy, anything else to test-signing', S.winSigning({ ...sp, GITHUB_REF: 'refs/tags/v0.5.0' }).policy === 'release-signing' && S.winSigning({ ...sp, GITHUB_REF: 'refs/heads/main' }).policy === 'test-signing' && S.winSigning(sp).policy === 'test-signing', '');
check('windows: SIGNPATH_SIGNING_POLICY_SLUG overrides the default', S.winSigning({ ...sp, GITHUB_REF: 'refs/tags/v1', SIGNPATH_SIGNING_POLICY_SLUG: 'test-signing' }).policy === 'test-signing', '');
check('windows: only a non-test policy is expected to verify as trusted', S.winSigning({ ...sp, GITHUB_REF: 'refs/tags/v1' }).trusted && !S.winSigning(sp).trusted, '');
check('windows: slugs default to lumen-app and lumen-installer and can be set', S.winSigning(sp).appConfig === 'lumen-app' && S.winSigning(sp).installerConfig === 'lumen-installer' && S.winSigning({ ...sp, SIGNPATH_APP_CONFIG_SLUG: 'a', SIGNPATH_INSTALLER_CONFIG_SLUG: 'b' }).appConfig === 'a', '');
const bad = S.winSigning({ ...sp, SIGNPATH_PROJECT_SLUG: 'x\nenabled=true', SIGNPATH_SIGNING_POLICY_SLUG: 'a b' });
check('windows: a slug that is not a plain slug (a newline would forge a workflow output) turns signing off and is reported', !bad.enabled && !bad.signApp && JSON.stringify(bad.invalid) === JSON.stringify(['SIGNPATH_PROJECT_SLUG', 'SIGNPATH_SIGNING_POLICY_SLUG']), JSON.stringify(bad));
check('windows: Lumen.exe is signed too unless SIGNPATH_SIGN_APP says no', S.winSigning(sp).signApp && S.winSigning({ ...sp, SIGNPATH_SIGN_APP: 'true' }).signApp && ['false', 'FALSE', '0', 'no', 'off'].every((v) => !S.winSigning({ ...sp, SIGNPATH_SIGN_APP: v }).signApp), '');
check('windows: SIGNPATH_SIGN_APP alone cannot turn signing on', !S.winSigning({ SIGNPATH_SIGN_APP: 'true' }).signApp, '');
check('windows flags: pass 1 keeps the icon and version info but skips electron-builder signing; pass 2 adds nothing', JSON.stringify(S.winBuilderArgs('app')) === JSON.stringify(['-c.win.signAndEditExecutable=true', '-c.win.signExecutable=false']) && S.winBuilderArgs('installer').length === 0 && S.winBuilderArgs().length === 0, '');
check('windows: the Windows variables never change the macOS decision', JSON.stringify(S.macSigning({ ...sp })) === JSON.stringify(S.macSigning({})), '');

const AP = require('../scripts/after-pack');
check('after-pack: LUMEN_DEFER_VMP=1 (and only that) defers VMP signing until Authenticode signing is done', AP.deferVmp({ LUMEN_DEFER_VMP: '1' }) && !AP.deferVmp({}) && !AP.deferVmp({ LUMEN_DEFER_VMP: '0' }) && !AP.deferVmp(undefined), '');
check('package.json: the unsigned Windows build still keeps the stock Lumen.exe (signAndEditExecutable false) and ignores .signpath', pkg.win.signAndEditExecutable === false && pkg.files.includes('!.signpath/**'), JSON.stringify(pkg.win));

const R = require('../scripts/refresh-latest');
const yml = 'version: 0.4.4\nfiles:\n  - url: Lumen-Setup-0.4.4.exe\n    sha512: OLD\n    size: 1\n  - url: Lumen-0.4.4-win-x64.zip\n    sha512: ZIPSHA\n    size: 7\npath: Lumen-Setup-0.4.4.exe\nsha512: OLD\nreleaseDate: \'2026-10-01T15:23:58.162Z\'\n';
const files = { 'Lumen-Setup-0.4.4.exe': { sha512: 'SIGNED', size: 99 } };
const refreshed = R.refreshYml(yml, (n) => files[n] || null);
check('refresh-latest: the signed Setup exe gets its new sha512 and size, in the file list and at the top', refreshed.includes('url: Lumen-Setup-0.4.4.exe\n    sha512: SIGNED\n    size: 99\n') && refreshed.includes('path: Lumen-Setup-0.4.4.exe\nsha512: SIGNED\n'), refreshed);
check('refresh-latest: entries with no file, and every other line, are left alone', refreshed.includes('url: Lumen-0.4.4-win-x64.zip\n    sha512: ZIPSHA\n    size: 7\n') && refreshed.includes('version: 0.4.4\n') && refreshed.includes("releaseDate: '2026-10-01T15:23:58.162Z'"), refreshed);
check('refresh-latest: --check sees a stale entry, and nothing once refreshed', R.mismatches(yml, (n) => files[n] || null).join() === 'Lumen-Setup-0.4.4.exe' && R.mismatches(refreshed, (n) => files[n] || null).length === 0, '');
const Z2 = require('../scripts/add-zip-to-latest');
check('add-zip-to-latest after refresh-latest: the zip entry goes in front of path: and the refreshed hash stays', /sha512: SIGNED\n {4}size: 99\n {2}- url: Lumen-0.4.4-win-x64.zip\n {4}sha512: Z\n {4}size: 5\npath:/.test(Z2.withZip(refreshed.replace(/ {2}- url: Lumen-0.4.4-win-x64.zip\n {4}sha512: ZIPSHA\n {4}size: 7\n/, ''), 'Lumen-0.4.4-win-x64.zip', 'Z', 5)), '');

// The workflow: the unsigned path stays what it was, the signed one is gated and keeps secrets out of logs.
const lf = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const wf = lf(path.join(root, '.github', 'workflows', 'release.yml'));
const steps = wf.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));
const step = (name) => steps.find((s) => new RegExp(`^ {6}- (name: )?${name.replace(/[()]/g, '\\$&')}`).test(s)) || '';
const sPlain = step('Build\\b');
check('workflow: the plain Build step still runs `node scripts/build.js --${{ matrix.platform }} ${{ matrix.targets }}`, only when SignPath is off', /run: node scripts\/build\.js --\$\{\{ matrix\.platform \}\} \$\{\{ matrix\.targets \}\}/.test(sPlain) && /if: steps\.winsign\.outputs\.enabled != 'true'/.test(sPlain), sPlain.slice(0, 200));
check('workflow: the unsigned zip listing runs only without SignPath', /if: matrix\.platform == 'win' && steps\.winsign\.outputs\.enabled != 'true'/.test(step('List the zip in latest.yml')) && /add-zip-to-latest/.test(step('List the zip in latest.yml')), '');
const signed = steps.filter((s) => /Build the app directory \(SignPath\)|Stage |Upload (Lumen\.exe|the Setup exe)|\(SignPath\)|Put the signed|installer and zip from the signed|Publish the signed|Verify the Windows/.test(s.split('\n')[0]));
check('workflow: every signed-path step is Windows-only and gated on the SignPath detection', signed.length === 11 && signed.every((s) => /if: matrix\.platform == 'win' && steps\.winsign\.outputs\.(enabled|sign_app) == 'true'/.test(s)), signed.map((s) => s.split('\n')[0]).join(' | '));
const order = ['Build the app directory (SignPath)', 'Sign Lumen.exe (SignPath)', 'Put the signed Lumen.exe back and VMP-sign it', 'Build the installer and zip from the signed directory', 'Sign the Setup exe (SignPath)', 'Publish the signed Setup exe and refresh the update info', 'Verify the Windows signatures'].map((n) => wf.indexOf(`- name: ${n}`));
check('workflow order: pack -> sign Lumen.exe -> VMP -> installer and zip -> sign the installer -> refresh latest.yml -> verify', order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join());
check('workflow: VMP runs after the signed Lumen.exe is back, and the first pass defers it (build.js sets LUMEN_DEFER_VMP)', /cp dist\/signed-app\/Lumen\.exe dist\/win-unpacked\/Lumen\.exe[\s\S]*vmp-sign\.js --require dist\/win-unpacked/.test(step('Put the signed Lumen.exe back and VMP-sign it')) && /LUMEN_DEFER_VMP: '1'/.test(fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8')), '');
check('workflow: the installer and zip are built from the signed directory (--prepackaged), not repacked', /build\.js --win nsis zip --prepackaged dist\/win-unpacked/.test(step('Build the installer and zip from the signed directory')), '');
check('workflow: latest.yml is refreshed from the signed Setup exe before the zip is listed, then re-checked', /refresh-latest\.js dist\n\s+node scripts\/add-zip-to-latest\.js\n\s+node scripts\/refresh-latest\.js --check dist/.test(step('Publish the signed Setup exe and refresh the update info')), '');
check('workflow: the SignPath action is pinned to a commit and fed uploaded artifacts of this run', (wf.match(/uses: signpath\/github-action-submit-signing-request@[0-9a-f]{40} # v3/g) || []).length === 2 && /github-artifact-id: \$\{\{ steps\.upload-app\.outputs\.artifact-id \}\}/.test(wf) && /github-artifact-id: \$\{\{ steps\.upload-installer\.outputs\.artifact-id \}\}/.test(wf), '');
check('workflow: the SignPath inputs name the secrets and never echo one', /api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/.test(wf) && /organization-id: \$\{\{ secrets\.SIGNPATH_ORGANIZATION_ID \}\}/.test(wf) && !/(echo|Write-Host|Write-Output|printf)[^\n]*(SIGNPATH_API_TOKEN|SIGNPATH_ORGANIZATION_ID|secrets\.)/.test(wf), '');
check('workflow: the intermediate artifacts expire after a day, and the release artifact list is unchanged', (wf.match(/retention-days: 1/g) || []).length === 2 && /dist\/\*\.exe\n\s+dist\/\*\.zip\n\s+dist\/\*\.dmg\n\s+dist\/latest\*\.yml\n\s+dist\/\*\.blockmap/.test(wf), '');
check('workflow: the signatures are verified with Get-AuthenticodeSignature and signtool verify /pa /v', /Get-AuthenticodeSignature/.test(step('Verify the Windows signatures')) && /verify \/pa \/v/.test(step('Verify the Windows signatures')), '');

const xml = (f) => lf(path.join(root, '.signpath', f));
for (const [f, file] of [['artifact-configuration-app.xml', 'Lumen.exe'], ['artifact-configuration-installer.xml', 'Lumen-Setup-*.exe']]) {
  const x = xml(f).replace(/<!--[\s\S]*?-->/g, '');
  check(`.signpath/${f}: a zip with ${file}, Authenticode-signed, restricted to ProductName Lumen and the version parameter`, x.includes('xmlns="http://signpath.io/artifact-configuration/v1"') && x.includes(`<pe-file path="${file}" product-name="Lumen" product-version="\${productVersion}">`) && /<authenticode-sign \/>/.test(x) && /<parameter name="productVersion" required="true" \/>/.test(x) && (x.match(/<zip-file>/g) || []).length === 1, x);
}
check('.signpath: only Lumen.exe is signed in the app configuration (no upstream DLLs)', (xml('artifact-configuration-app.xml').replace(/<!--[\s\S]*?-->/g, '').match(/<pe-file /g) || []).length === 1, '');

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
