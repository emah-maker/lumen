// `npm test`: runs the core suites one after another (never in parallel: several of them move focus
// between windows) and keeps going past a failure, then prints which suites failed.
// `npm test -- tabstrip groups` runs just those. Suites that need the network, an API key or a
// signed-in CLI (claudecode, drm, measure, topics-bench, …) stay manual: `node test/<name>.js`.
// `LUMEN_TEST_BACKGROUND=1 npm test`: test windows are invisible and never take focus (main.js), so
// a run doesn't get in the way of a Lumen you're using; checks that need OS focus print SKIP.
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'units', 'cli-json', 'smoke', 'tools', 'ui', 'images', 'models', 'adhd', 'extensions', 'adblock', 'pagecontext',
  'dialogs', 'recovery', 'tasklock', 'tabstrip', 'tabsearch', 'downloads', 'hardening', 'exfil', 'aicontrols', 'security-ui', 'safe-browsing', 'a11y', 'updates',
  'mcp', 'mcpclient', 'settings', 'groups', 'cdp', 'browser', 'home', 'windows', 'pagetools', 'managers', 'chats', 'files', 'usage', 'look',
];

const picked = process.argv.slice(2);
const unknown = picked.filter((name) => !SUITES.includes(name));
if (unknown.length) {
  console.error(`Not a core suite: ${unknown.join(', ')}. Core suites: ${SUITES.join(', ')}`);
  process.exit(2);
}

// Each suite's copies of Lumen leave their throwaway profiles in the temp folder (a suite may read
// one after Lumen quits); a full run left gigabytes. They go once the suite is over.
const os = require('os');
const fs = require('fs');
function removeTestProfiles(since) {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!/^(claude-browser-test-|playwright-artifacts-)/.test(name)) continue;
    const dir = path.join(tmp, name);
    try { if (fs.statSync(dir).mtimeMs >= since) fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { console.error(`could not remove ${dir}: ${err.message}`); }
  }
}

const results = [];
for (const name of picked.length ? picked : SUITES) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'test', `${name}.js`)], { stdio: 'inherit' });
  results.push({ name, ok: run.status === 0, code: run.status ?? run.signal, seconds: Math.round((Date.now() - started) / 1000) });
  removeTestProfiles(started);
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, exit ${r.code}`})`);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
