// `npm run test:units`: every pure-node suite (no window, no network, no API key), one child process
// each, run one after another with a per-suite timeout. CI (ci.yml, release.yml) runs this, so a new
// test/*-units.js file is picked up without editing a list. Exits non-zero if any suite fails.
// `node scripts/test-units.js foo-units` runs just the named suites.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '..', 'test');
const TIMEOUT_MS = Number(process.env.LUMEN_UNIT_TIMEOUT_MS) || 120000;

// Suites that match the globs below or are named in EXTRA but must not run here.
const EXCLUDE = {
  'perf-budget': 'launches Electron through playwright-core (a startup/memory budget); runs from npm test',
};
// Pure-node suites that don't follow the *-units.js name.
const EXTRA = ['cli-json'];

const found = new Set(['units', ...fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('-units.js')).map((f) => f.slice(0, -3)), ...EXTRA]);
let names = [...found].filter((n) => !(n in EXCLUDE) && fs.existsSync(path.join(TEST_DIR, `${n}.js`))).sort();

const picked = process.argv.slice(2);
if (picked.length) {
  const unknown = picked.filter((n) => !names.includes(n));
  if (unknown.length) { console.error(`Not a unit suite: ${unknown.join(', ')}`); process.exit(2); }
  names = picked;
}

const results = [];
for (const name of names) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(TEST_DIR, `${name}.js`)], { stdio: 'inherit', timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  results.push({ name, ok: run.status === 0 && !run.error, code: timedOut ? `timeout after ${TIMEOUT_MS / 1000}s` : `exit ${run.status ?? run.signal ?? run.error?.message}`, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, ${r.code}`})`);
console.log(failed.length ? `\n${failed.length} of ${results.length} unit suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} unit suites passed`);
process.exit(failed.length ? 1 : 0);
