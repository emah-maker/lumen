// Builds Lumen with electron-builder into a local, non-synced folder, never into the project
// folder (which may live in OneDrive):
//   Windows  %LOCALAPPDATA%\Lumen\build
//   macOS    ~/Library/Caches/Lumen/build
// Override with LUMEN_BUILD_DIR. Usage: node scripts/build.js [--win|--mac] [targets…]
// Linux isn't a packaged target (package.json has no build.linux); run it from source.
// Windows builds use the untouched Electron binary from node_modules, so the app's exe stays
// byte-identical to Electron's (Windows Smart App Control trusts that file; an edited exe is blocked).
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

function outputDir() {
  if (process.env.LUMEN_BUILD_DIR) return path.resolve(process.env.LUMEN_BUILD_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Lumen', 'build');
  return path.join(os.homedir(), 'Library', 'Caches', 'Lumen', 'build');
}

const args = process.argv.slice(2);
const platformFlag = args.find((a) => ['--win', '--mac'].includes(a))
  || { win32: '--win', darwin: '--mac' }[process.platform];
if (!platformFlag) {
  console.error('Lumen builds for Windows (--win) and macOS (--mac) only; on Linux, run it from source with npm start.');
  process.exit(1);
}
// SignPath builds (docs/windows-signing.md) run electron-builder twice. `--signpath-app` marks the first
// pass (`--win dir`): Lumen.exe keeps its icon and version info for SignPath's metadata checks, and
// Widevine VMP signing is left for after SignPath has signed it. The second pass is
// `--win nsis zip --prepackaged <the signed directory>`. Neither flag is used by the unsigned build.
const signpathApp = args.includes('--signpath-app');
const rest = args.filter((a) => a !== platformFlag && a !== '--signpath-app');
const prepackaged = rest.some((a) => a === '--prepackaged' || a === '--pd');
const out = outputDir();
if (/onedrive/i.test(out)) console.warn(`warning: building into ${out}, which looks like a synced folder`);

const builderArgs = [platformFlag, ...rest, `-c.directories.output=${out}`, '--publish', 'never']; // publishing is the workflow's job
// LUMEN_ELECTRON_DIST: build with another Electron's dist folder (e.g. stock Electron instead of the
// castlabs DRM build in node_modules), without touching the project's dependencies.
const electronDist = process.env.LUMEN_ELECTRON_DIST ? path.resolve(process.env.LUMEN_ELECTRON_DIST) : path.join(root, 'node_modules', 'electron', 'dist');
if (platformFlag === '--win') {
  builderArgs.push(`-c.electronDist=${electronDist}`);
  const version = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim().replace(/^v/, '');
  if (process.env.LUMEN_ELECTRON_DIST) builderArgs.push(`-c.electronVersion=${version}`);
}

// The UI's sandboxed preload ships from the committed bundle; rebuild it so a stale one never ships.
const preload = require('./bundle-preload');
const fresh = preload.bundle();
if (!fs.existsSync(preload.OUT) || fs.readFileSync(preload.OUT, 'utf8').replace(/\r\n/g, '\n') !== fresh) {
  fs.writeFileSync(preload.OUT, fresh);
  console.warn('warning: preload.bundle.js was out of date and has been rebuilt; commit it');
}

// Lumen's built-in Google client (one-click "Sign in with Google" for the Gmail widget): from
// LUMEN_GOOGLE_CLIENT_ID / LUMEN_GOOGLE_CLIENT_SECRET (the release workflow passes repository secrets)
// into src/features/google-client.json for this build only; the file is gitignored and removed afterwards.
// Without them the build has no built-in client and Settings shows the paste-your-own-client flow.
const googleFile = path.join(root, 'src', 'features', 'google-client.json');
const googleId = (process.env.LUMEN_GOOGLE_CLIENT_ID || '').trim();
const googleSecret = (process.env.LUMEN_GOOGLE_CLIENT_SECRET || '').trim();
let wroteGoogle = false;
if (googleId && googleSecret) {
  const { builtinClient } = require('../src/features/google-client');
  if (!builtinClient({ env: { LUMEN_GOOGLE_CLIENT_ID: googleId, LUMEN_GOOGLE_CLIENT_SECRET: googleSecret }, file: {} })) {
    console.error('LUMEN_GOOGLE_CLIENT_ID / LUMEN_GOOGLE_CLIENT_SECRET are set but do not look like a Google Desktop OAuth client');
    process.exit(1);
  }
  fs.writeFileSync(googleFile, `${JSON.stringify({ clientId: googleId, clientSecret: googleSecret, verified: process.env.LUMEN_GOOGLE_VERIFIED === '1' })}\n`);
  wroteGoogle = true;
  console.log('Built-in Google client: included (one-click Gmail sign-in)');
} else {
  console.log('Built-in Google client: not set (LUMEN_GOOGLE_CLIENT_ID / LUMEN_GOOGLE_CLIENT_SECRET); Gmail uses the paste-your-own-client flow');
}

console.log(`Building ${platformFlag.slice(2)} into ${out}`);
// macOS signing (scripts/signing.js): a Developer ID certificate in CSC_LINK / CSC_KEY_PASSWORD gives a
// hardened-runtime, Apple-signed app, notarized and stapled when APPLE_* credentials exist. Without
// one the build is ad-hoc signed (or self-signed by scripts/after-sign.js) exactly as before.
const signing = require('./signing');
let builderEnv = process.env;
if (platformFlag === '--win' && signpathApp) {
  builderArgs.push(...signing.winBuilderArgs('app'));
  builderEnv = { ...process.env, LUMEN_DEFER_VMP: '1' };
}
if (platformFlag === '--mac') {
  builderArgs.push(...signing.builderArgs());
  builderEnv = signing.builderEnv();
  const s = signing.macSigning();
  console.log(`macOS signing: ${s.mode}${s.mode === 'developer-id' ? `, notarization: ${s.notarize || 'off (no credentials)'}` : ''}`);
  if (s.partialNotarization) console.warn(`warning: ${s.partialNotarization} is only partly set; the app will be signed but not notarized`);
}
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...builderArgs], { cwd: root, stdio: 'inherit', env: builderEnv });
if (wroteGoogle) fs.rmSync(googleFile, { force: true });
if (result.status !== 0) process.exit(result.status || 1);

// The Windows exe must be the unmodified Electron binary. Not checked for a SignPath build that edits
// and signs it (its signature and version info are the point), nor for the pass that packages the
// already signed directory.
if (platformFlag === '--win' && !signpathApp && !prepackaged) {
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const built = path.join(out, 'win-unpacked', 'Lumen.exe');
  const stock = path.join(electronDist, 'electron.exe');
  if (fs.existsSync(built) && fs.existsSync(stock)) {
    const same = sha(built) === sha(stock);
    console.log(`Lumen.exe ${same ? 'matches' : 'DOES NOT match'} the stock Electron binary (${sha(built).slice(0, 12)}…)`);
    if (!same) process.exit(2);
  }
}
console.log(`Done: ${out}`);
