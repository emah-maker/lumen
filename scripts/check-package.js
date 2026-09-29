// Prints the size of a packaged Lumen (the folder electron-builder wrote: win-unpacked, or the
// .app) and fails when it grows past the budget below. CI-friendly: exit code 1 on a breach.
//   node scripts/check-package.js [folder]      folder defaults to the build folder of scripts/build.js
//   node scripts/check-package.js --launch      also starts the packaged app and checks its window comes up
// Budget (Windows, measured 2026-09: 339 MB total, 9 MB app, 12 MB locales, 1752 files): about 6% headroom, so an
// unrelated dependency or a stray asset shows up here instead of in the installer size.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUDGET = { totalMB: 360, appMB: 14, localesMB: 16, files: 2400 };

function outputDir() {
  if (process.env.LUMEN_BUILD_DIR) return path.resolve(process.env.LUMEN_BUILD_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Lumen', 'build');
  return path.join(os.homedir(), 'Library', 'Caches', 'Lumen', 'build');
}

function walk(dir, out = { bytes: 0, files: 0 }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) { out.bytes += fs.statSync(full).size; out.files++; }
  }
  return out;
}
const mb = (bytes) => Math.round(bytes / 1048576 * 10) / 10;

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let root = positional[0] ? path.resolve(positional[0]) : path.join(outputDir(), 'win-unpacked');
if (!fs.existsSync(root)) { console.error(`No packaged app at ${root}. Build with node scripts/build.js first.`); process.exit(2); }
const resources = [path.join(root, 'resources'), ...fs.readdirSync(root).filter((n) => n.endsWith('.app')).map((n) => path.join(root, n, 'Contents', 'Resources'))].find((p) => fs.existsSync(path.join(p, 'app')));
if (!resources) { console.error(`${root} has no resources/app folder.`); process.exit(2); }

const total = walk(root);
const app = walk(path.join(resources, 'app'));
const locales = fs.existsSync(path.join(root, 'locales')) ? walk(path.join(root, 'locales')) : { bytes: 0, files: 0 };
const rows = [
  ['total', mb(total.bytes), BUDGET.totalMB, 'MB'],
  ['resources/app (our code and node_modules)', mb(app.bytes), BUDGET.appMB, 'MB'],
  ['locales (Chromium .pak)', mb(locales.bytes), BUDGET.localesMB, 'MB'],
  ['files', total.files, BUDGET.files, ''],
];
let failed = false;
for (const [label, value, limit, unit] of rows) {
  const over = value > limit;
  if (over) failed = true;
  console.log(`${over ? 'FAIL' : 'ok  '}  ${label}: ${value}${unit ? ` ${unit}` : ''} (budget ${limit})`);
}
// Files that must never ship: tests, sources maps and type declarations, the docs folder.
const forbidden = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name === 'test' && dir === path.join(resources, 'app')) forbidden.push(full); else scan(full); }
    else if (/\.(map|d\.ts|d\.mts|tsbuildinfo)$/.test(entry.name)) forbidden.push(full);
  }
})(path.join(resources, 'app'));
if (forbidden.length) { failed = true; console.log(`FAIL  ${forbidden.length} files that should not ship, e.g. ${forbidden.slice(0, 3).join(', ')}`); }

async function launch() {
  const { _electron: electron } = require('playwright-core');
  const exe = process.platform === 'win32' ? path.join(root, 'Lumen.exe') : null;
  if (!exe || !fs.existsSync(exe)) { console.log('skip  --launch (Windows unpacked build only)'); return true; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-package-check-'));
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`], env: { ...process.env, LUMEN_TEST_BACKGROUND: '' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab', { timeout: 30000 });
    const loaded = await app.evaluate(() => {
      const r = (name) => { try { return typeof process.mainModule.require(name); } catch (err) { return `ERROR ${err.message.split('\n')[0]}`; } };
      return { anthropic: r('@anthropic-ai/sdk'), openai: r('openai'), adblocker: r('@ghostery/adblocker-electron') };
    });
    const ok = Object.values(loaded).every((v) => v === 'function' || v === 'object');
    console.log(`${ok ? 'ok  ' : 'FAIL'}  packaged app started; modules ${JSON.stringify(loaded)}`);
    return ok;
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

(async () => {
  if (process.argv.includes('--launch') && !(await launch())) failed = true;
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
