// electron-builder afterPack hook: remove Electron's placeholder app from the build,
// then VMP-sign the castlabs ECS binary so production Widevine (Netflix,
// Disney+, Spotify, ...) works. afterPack runs before any code signing; we don't do
// Authenticode signing here (signAndEditExecutable: false), so there's no ordering issue
// with castlabs' "sign VMP after Authenticode on Windows" rule. On macOS castlabs wants VMP
// signing before the Apple codesign, which electron-builder runs after this hook (and then, for a
// Developer ID build, notarizes and staples: see scripts/signing.js and docs/mac-signing.md). Order on
// macOS: VMP sign (here, needs EVS_ACCOUNT_NAME / EVS_PASSWD or a saved login) -> Apple codesign ->
// notarize -> staple. The VMP .sig files are inside the bundle by then, so the Apple seal covers them.
// VMP signing writes a
// separate .sig file next to the exe — it does not modify the exe itself, so this runs
// after build.js's byte-identical check for win-unpacked/Lumen.exe.
//
// On macOS an unsigned build also flips two Electron fuses off (NODE_OPTIONS and --inspect), so
// nothing can attach a debugger to, or inject code into, the app from outside. A VMP-signed build
// skips that: castlabs won't sign a modified binary. Windows is left alone: the fuses
// live inside Lumen.exe, which must stay byte-identical to Electron's (see scripts/build.js).
// RunAsNode stays on everywhere: the MCP bridge (mcp.js) and launcher.js run Lumen in Node mode.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function warnSkipVmp(reason, appOutDir) {
  console.warn(`
WARNING: skipping Widevine VMP signing (${reason}).`);
  console.warn('This build is unsigned: Netflix, Disney+, Spotify and other production DRM may refuse to play (Widevine L3 / software only, where a site allows it).');
  console.warn('Local setup (free castlabs EVS account), then rebuild:');
  console.warn('  python -m pip install --upgrade castlabs-evs');
  console.warn('  python -m castlabs_evs.account signup   (or: python -m castlabs_evs.account reauth)');
  console.warn('Headless/CI: set EVS_ACCOUNT_NAME and EVS_PASSWD instead of signing up interactively.');
  console.warn(`Manual signing: python -m castlabs_evs.vmp sign-pkg "${appOutDir}"
`);
}

// castlabs-evs reads EVS_ACCOUNT_NAME / EVS_PASSWD from the environment, so CI needs no interactive login.
function vmpSign(appOutDir) {
  const py = spawnSync('python', ['--version']);
  if (py.error || py.status !== 0) return warnSkipVmp('python was not found on PATH', appOutDir);

  const check = spawnSync('python', ['-m', 'castlabs_evs.vmp', '--help']);
  if (check.error || check.status !== 0) return warnSkipVmp('the castlabs-evs package is not installed', appOutDir);

  const headless = Boolean(process.env.EVS_ACCOUNT_NAME && process.env.EVS_PASSWD);
  if (headless) {
    // castlabs' CI flow: log in from the environment (no TTY) before signing.
    const reauth = spawnSync('python', ['-m', 'castlabs_evs.account', 'reauth'], { stdio: 'inherit', env: { ...process.env, EVS_NO_ASK: '1' } });
    if (reauth.error || reauth.status !== 0) return warnSkipVmp('EVS login failed; check EVS_ACCOUNT_NAME / EVS_PASSWD', appOutDir);
  }
  console.log(`Signing Widevine VMP for ${appOutDir} (${headless ? 'EVS credentials from environment' : 'saved EVS credentials'}) ...`);
  // --no-ask is a global flag and must come before the sign-pkg subcommand.
  const sign = spawnSync('python', ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', appOutDir], { stdio: 'inherit' });
  if (sign.error || sign.status !== 0) {
    return warnSkipVmp(headless ? 'EVS signing failed; check EVS_ACCOUNT_NAME / EVS_PASSWD' : 'EVS signing failed; no EVS account configured? run account signup/reauth', appOutDir);
  }
  console.log('Widevine VMP signing complete.');
  return true;
}

// A signed Windows build (scripts/signing.js, LUMEN_DEFER_VMP=1) signs Lumen.exe after this hook, and
// castlabs wants VMP after Authenticode there, so scripts/after-sign.js does the VMP signing instead.
const deferVmp = (env) => String((env || {}).LUMEN_DEFER_VMP || '').trim() === '1';

// The fuses to flip for a platform, or null to leave the Electron binary untouched.
function fuses(electronPlatformName) {
  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'mas') return null;
  const { FuseVersion, FuseV1Options } = require('@electron/fuses');
  return {
    version: FuseVersion.V1,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  };
}

exports.default = async (context) => {
  const { appOutDir, electronPlatformName } = context;
  fs.rmSync(path.join(appOutDir, 'resources', 'default_app.asar'), { force: true });
  const deferred = electronPlatformName === 'win32' && deferVmp(process.env);
  if (deferred) console.log('Deferring Widevine VMP signing until Lumen.exe is Authenticode-signed (scripts/after-sign.js).');
  const signed = !deferred && (electronPlatformName === 'win32' || electronPlatformName === 'darwin') && vmpSign(appOutDir);
  const config = fuses(electronPlatformName);
  // castlabs refuses to VMP-sign a binary whose fuses were changed, and a change after signing
  // breaks the signature, so a signed macOS build keeps stock fuses (DRM over hardening).
  if (config && signed) console.log('Leaving Electron fuses at their defaults so the VMP signature stays valid.');
  else if (config) await context.packager.addElectronFuses(context, config);
};
exports.fuses = fuses;
exports.vmpSign = vmpSign;
exports.deferVmp = deferVmp;
