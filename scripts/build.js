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
const rest = args.filter((a) => a !== platformFlag);
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

console.log(`Building ${platformFlag.slice(2)} into ${out}`);
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...builderArgs], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);

// The Windows exe must be the unmodified Electron binary.
if (platformFlag === '--win') {
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
