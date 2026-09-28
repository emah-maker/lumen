// electron-builder afterPack hook: remove Electron's placeholder app from the build,
// then (Windows only) VMP-sign the castlabs ECS binary so production Widevine (Netflix,
// Disney+, Spotify, ...) works. afterPack runs before any code signing; we don't do
// Authenticode signing here (signAndEditExecutable: false), so there's no ordering issue
// with castlabs' "sign VMP after Authenticode on Windows" rule. VMP signing writes a
// separate .sig file next to the exe — it does not modify the exe itself, so this runs
// after build.js's byte-identical check for win-unpacked/Lumen.exe.
//
// On macOS it also flips two Electron fuses off (NODE_OPTIONS and --inspect), so nothing can
// attach a debugger to, or inject code into, the app from outside. electron-builder signs the app
// after this hook, so the signature covers the flipped binary. Windows is left alone: the fuses
// live inside Lumen.exe, which must stay byte-identical to Electron's (see scripts/build.js).
// RunAsNode stays on everywhere: the MCP bridge (mcp.js) and launcher.js run Lumen in Node mode.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function warnSkipVmp(reason, appOutDir) {
  console.warn(`\nWARNING: skipping Widevine VMP signing (${reason}).`);
  console.warn('Netflix, Disney+, Spotify and other production DRM will fail in this build until it is VMP-signed.');
  console.warn('One-time setup, then rebuild:');
  console.warn('  python -m pip install --upgrade castlabs-evs');
  console.warn('  python -m castlabs_evs.account signup   (or: python -m castlabs_evs.account reauth)');
  console.warn(`  python -m castlabs_evs.vmp sign-pkg "${appOutDir}"\n`);
}

function vmpSign(appOutDir) {
  const py = spawnSync('python', ['--version']);
  if (py.error || py.status !== 0) return warnSkipVmp('python was not found on PATH', appOutDir);

  const check = spawnSync('python', ['-m', 'castlabs_evs.vmp', '--help']);
  if (check.error || check.status !== 0) return warnSkipVmp('the castlabs-evs package is not installed', appOutDir);

  console.log(`Signing Widevine VMP for ${appOutDir} ...`);
  // --no-ask is a global flag and must come before the sign-pkg subcommand.
  const sign = spawnSync('python', ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', appOutDir], { stdio: 'inherit' });
  if (sign.error || sign.status !== 0) return warnSkipVmp('EVS signing failed — no EVS account configured? run account signup/reauth', appOutDir);
  console.log('Widevine VMP signing complete.');
}

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
  const config = fuses(electronPlatformName);
  if (config) await context.packager.addElectronFuses(context, config);
  if (electronPlatformName === 'win32') vmpSign(appOutDir);
};
exports.fuses = fuses;
