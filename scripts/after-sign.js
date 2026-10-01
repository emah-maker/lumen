// electron-builder afterSign hook (macOS only): re-sign the app with Lumen's own certificate.
//
// Builds are ad-hoc signed, which gives every build a different code identity. macOS ties an
// "Always Allow" on the "Lumen Safe Storage" Keychain item to that identity, so it asked again after
// every update. Signing every build with the same certificate keeps the identity, and the answer,
// stable. The certificate is self-signed: Gatekeeper still says "unidentified developer" (only a paid
// Apple Developer ID changes that), and nothing here is notarized. With a Developer ID certificate
// (CSC_LINK, see docs/mac-signing.md) this whole step is skipped.
//
// The certificate comes from the repository secrets LUMEN_SIGN_P12 (base64 .p12) and
// LUMEN_SIGN_PASSWORD. Without them, or if anything fails, the ad-hoc signature stays and the build
// carries on; a local `npm run dist` is unaffected.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// The SHA-1 of the identity named `name` in `keychain`, from `security find-identity` (not -v:
// a self-signed certificate is not "trusted", and codesign signs with it anyway).
function identityHash(listing, name) {
  for (const line of String(listing).split('\n')) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"/i);
    if (m && m[2] === name) return m[1];
  }
  return null;
}

async function signWithLumenCert(appPath) {
  const p12b64 = (process.env.LUMEN_SIGN_P12 || '').trim();
  const password = (process.env.LUMEN_SIGN_PASSWORD || '').trim();
  if (!p12b64 || !password) return console.log('after-sign: no LUMEN_SIGN_P12 / LUMEN_SIGN_PASSWORD; keeping the ad-hoc signature.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sign-'));
  const keychain = path.join(dir, 'lumen-sign.keychain-db');
  const keychainPassword = crypto.randomBytes(16).toString('hex');
  let previous = [];
  try {
    previous = run('security', ['list-keychains', '-d', 'user']).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  } catch {}
  try {
    const p12 = path.join(dir, 'lumen.p12');
    fs.writeFileSync(p12, Buffer.from(p12b64, 'base64'));
    run('security', ['create-keychain', '-p', keychainPassword, keychain]);
    run('security', ['set-keychain-settings', '-lut', '3600', keychain]);
    run('security', ['unlock-keychain', '-p', keychainPassword, keychain]);
    run('security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain]);
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...previous]);
    const hash = identityHash(run('security', ['find-identity', '-p', 'codesigning', keychain]), 'Lumen Release Signing');
    if (!hash) throw new Error('the Lumen signing identity is not in the imported certificate');
    run('codesign', ['--force', '--deep', '--sign', hash, '--keychain', keychain, '--timestamp=none', appPath]);
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
    const requirement = run('codesign', ['-d', '-r-', appPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`after-sign: signed ${path.basename(appPath)} with Lumen Release Signing (${hash.slice(0, 8)}…)`);
    console.log(`after-sign: designated requirement: ${String(requirement).split('\n').find((l) => l.startsWith('designated')) || '(none printed)'}`);
  } finally {
    try { run('security', ['list-keychains', '-d', 'user', '-s', ...previous]); } catch {}
    try { run('security', ['delete-keychain', keychain]); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// electron-builder signs, and (with Developer ID credentials) notarizes and staples, BEFORE this hook
// runs. Signing again here would replace the Developer ID signature and void the notarization
// ticket, so the self-signed step only applies to the ad-hoc path (build.js passes identity "-").
const isAdHocBuild = (identity) => identity === '-';

exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const identity = context.packager && context.packager.platformSpecificBuildOptions && context.packager.platformSpecificBuildOptions.identity;
  if (!isAdHocBuild(identity)) return console.log('after-sign: Developer ID build; leaving the Apple signature (and notarization) untouched.');
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    await signWithLumenCert(appPath);
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    console.warn(`after-sign: could not sign with the Lumen certificate (${detail}); keeping the ad-hoc signature.`);
  }
};
exports.identityHash = identityHash;
exports.isAdHocBuild = isAdHocBuild;
