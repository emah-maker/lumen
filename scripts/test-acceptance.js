// `npm run test:acceptance`: the chat acceptance suites in test/acceptance/ (one per feature: parallel CLI chats,
// unlimited chats at once, per-chat CLI history, Send now, the Grok prompt budget). Pure Node with fake CLIs, one child
// process each, like test-units.js. They specify features that are still being built, so they are kept out of
// `npm run test:units` / CI until their feature lands; then move the suite to test/<name>-units.js (fixing its
// require paths) so CI keeps it.
// `node scripts/test-acceptance.js chat-send-now` runs just the named suites.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { suiteTmp } = require('./test-tmp'); // each suite gets its own TEMP folder, removed after it

const DIR = path.join(__dirname, '..', 'test', 'acceptance');
const TIMEOUT_MS = Number(process.env.LUMEN_UNIT_TIMEOUT_MS) || 120000;
let names = fs.readdirSync(DIR).filter((f) => /^chat-.+\.js$/.test(f) && f !== 'chat-harness.js').map((f) => f.slice(0, -3)).sort();

const picked = process.argv.slice(2).map((n) => n.replace(/\.js$/, ''));
if (picked.length) {
  const unknown = picked.filter((n) => !names.includes(n));
  if (unknown.length) { console.error(`Not an acceptance suite: ${unknown.join(', ')} (have: ${names.join(', ')})`); process.exit(2); }
  names = picked;
}

const results = [];
for (const name of names) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const tmp = suiteTmp(name);
  const run = spawnSync(process.execPath, [path.join(DIR, `${name}.js`)], { stdio: 'inherit', env: tmp.env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  tmp.done();
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  results.push({ name, ok: run.status === 0 && !run.error, code: timedOut ? `timeout after ${TIMEOUT_MS / 1000}s` : `exit ${run.status ?? run.signal ?? run.error?.message}`, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, ${r.code}`})`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} acceptance suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} acceptance suites passed`);
process.exit(failed.length ? 1 : 0);
