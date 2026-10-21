// `npm run test:units`: every pure-node suite (no window, no network, no API key), one child process
// each, with a per-suite timeout. CI (ci.yml, release.yml) runs this, so a new
// test/units/*-units.js file is picked up without editing a list. Exits non-zero if any suite fails.
// `node scripts/test/test-units.js foo-units` runs just the named suites.
// `--jobs N` (or LUMEN_UNIT_JOBS=N) runs N suites at a time, each one's output printed in one block when it ends;
// the default is one after another with the output going straight through.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { suiteTmp } = require('./test-tmp'); // each suite gets its own TEMP folder, removed after it

const TEST_DIR = path.join(__dirname, '..', '..', 'test', 'units');
const TIMEOUT_MS = Number(process.env.LUMEN_UNIT_TIMEOUT_MS) || 120000;

// Suites that match the globs below or are named in EXTRA but must not run here.
const EXCLUDE = {
  'perf-budget': 'launches Electron through playwright-core (a startup/memory budget); runs from npm test',
};
// Pure-node suites that don't follow the *-units.js name.
const EXTRA = ['cli-json'];

const found = new Set(['units', ...fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('-units.js')).map((f) => f.slice(0, -3)), ...EXTRA]);
let names = [...found].filter((n) => !(n in EXCLUDE) && fs.existsSync(path.join(TEST_DIR, `${n}.js`))).sort();

const args = process.argv.slice(2);
let jobs = Number(process.env.LUMEN_UNIT_JOBS) || 1;
const picked = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--jobs') jobs = Number(args[++i]) || 1;
  else picked.push(args[i]);
}
if (picked.length) {
  const unknown = picked.filter((n) => !names.includes(n));
  if (unknown.length) { console.error(`Not a unit suite: ${unknown.join(', ')}`); process.exit(2); }
  names = picked;
}

const summarize = (name, started, status, error, signal) => {
  const timedOut = error && error.code === 'ETIMEDOUT';
  return { name, ok: status === 0 && !error, code: timedOut ? `timeout after ${TIMEOUT_MS / 1000}s` : `exit ${status ?? signal ?? error?.message}`, seconds: ((Date.now() - started) / 1000).toFixed(1) };
};

// One suite at a time with its output going straight to ours (the default).
function runSerial() {
  const results = [];
  for (const name of names) {
    console.log(`\n=== ${name}`);
    const started = Date.now();
    const tmp = suiteTmp(name);
    const run = spawnSync(process.execPath, [path.join(TEST_DIR, `${name}.js`)], { stdio: 'inherit', env: tmp.env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
    tmp.done();
    results.push(summarize(name, started, run.status, run.error, run.signal));
  }
  return Promise.resolve(results);
}

// `jobs` suites at once, each one's output printed as one block when it ends. The real temp folder is not swept (suiteTmp's sweep: false):
// a sweep by one suite could remove folders a neighbour or another agent's tests are using.
function runParallel() {
  return new Promise((resolve) => {
    const results = [];
    const queue = [...names];
    let active = 0;
    const next = () => {
      if (!queue.length && !active) return resolve(results);
      while (queue.length && active < jobs) {
        const name = queue.shift();
        active++;
        const started = Date.now();
        const tmp = suiteTmp(name);
        const child = spawn(process.execPath, [path.join(TEST_DIR, `${name}.js`)], { env: tmp.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        let error = null;
        let ended = false;
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => { error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); child.kill('SIGKILL'); }, TIMEOUT_MS);
        const end = (status, signal, err) => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          tmp.done();
          process.stdout.write(`\n=== ${name}\n${out}`);
          results.push(summarize(name, started, status, error || err, signal));
          active--;
          next();
        };
        child.on('error', (err) => end(null, null, err));
        child.on('close', (status, signal) => end(status, signal, null));
      }
    };
    next();
  });
}

// A few suites load modules that require('electron'), and electron's index.js downloads its binary the first time it finds it missing.
// Several suites at once would all start that download into the same folder and race ("File exists" on macOS). So when running in
// parallel, install the binary once here first, before any suite starts. Nothing to do when it is already there.
function ensureElectronBinary() {
  const dir = path.join(__dirname, '..', '..', 'node_modules', 'electron');
  if (!fs.existsSync(path.join(dir, 'install.js')) || process.env.ELECTRON_OVERRIDE_DIST_PATH) return;
  const pathFile = path.join(dir, 'path.txt');
  const rel = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8') : '';
  if (rel && fs.existsSync(path.join(dir, 'dist', rel))) return;
  console.log('Installing the Electron binary once before the parallel suites start...');
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('Electron install failed'); process.exit(1); }
}

(jobs > 1 ? (ensureElectronBinary(), runParallel()) : runSerial()).then((results) => {
  results.sort((a, b) => (a.name < b.name ? -1 : 1));
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== summary');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, ${r.code}`})`);
  console.log(failed.length ? `\n${failed.length} of ${results.length} unit suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} unit suites passed`);
  process.exit(failed.length ? 1 : 0);
});
