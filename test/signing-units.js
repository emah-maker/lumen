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

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
