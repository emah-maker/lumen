// `npm test`: runs the core suites one after another (never in parallel: several of them move focus
// between windows) and keeps going past a failure, then prints which suites failed.
// `npm test -- tabstrip groups` runs just those. Suites that need the network, an API key or a
// signed-in CLI (claudecode, drm, measure, topics-bench, …) stay manual: `node test/<name>.js`.
// `LUMEN_TEST_BACKGROUND=1 npm test`: test windows are invisible and never take focus (main.js), so
// a run doesn't get in the way of a Lumen you're using; checks that need OS focus print SKIP.
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'units', 'claudecode-full-units', 'cli-full-access-units', 'tab-chats-units', 'automation-units', 'chat-items-units', 'chat-context-units', 'chat-history-units', 'ai-manners-units', 'device-access-units', 'device-access', 'feature-offers-units', 'feature-offers', 'bypass-permissions-units', 'bypass-permissions-ui', 'model-route-units', 'auto-model-units', 'auto-engines-units', 'auto-agent-units', 'fallback-units', 'antigravity-units', 'mcp-hardening-units', 'perf-budget', 'cli-json', 'smoke', 'tools', 'ui', 'images', 'uploads', 'models', 'adhd', 'extensions', 'adblock', 'adblock-youtube-units', 'adblock-youtube', 'pagecontext', 'page-text-units', 'frames', 'frames-units', 'cc-settings-units',
  'dialogs', 'recovery', 'tasklock', 'tabstrip', 'tabmenu', 'chrome-ux', 'tabui', 'tabsearch', 'downloads', 'hardening', 'exfil', 'aicontrols', 'security-ui', 'safe-browsing', 'a11y', 'toolbar-layout', 'windowdrag', 'updates',
  'mcp', 'codex-connect', 'mcpclient', 'netfetch', 'settings', 'groups', 'cdp', 'browser', 'home', 'windows', 'private', 'tabdetach', 'pagetools', 'screenshot', 'translate', 'translate-local-units', 'translate-download-units', 'translate-group-units', 'managers', 'chats', 'late-picture', 'chatpage', 'tabchats', 'tabchats-follow', 'sidebar-newchat', 'send-now', 'aimanners', 'aitaboff', 'files', 'usage', 'look', 'tabsask', 'skills', 'bgtasks', 'routines-units', 'routines', 'widgets', 'spotify-ui', 'apple-music-ui', 'apple-music-status-ui', 'apple-music-engine-ui', 'music-search-ui', 'spotify-engine-ui', 'calendar-multi-units', 'widget-resilience-units', 'calendar-multi', 'edit-shake', 'newtab-scroll', 'layout-edit-positions', 'tradingview-ui', 'tradingview-fit', 'cdp-inproc', 'whats-new', 'passwords', 'passkeys', 'permissions', 'updates-units', 'signing-units', 'package-files-units', 'chrome-identity-units', 'google-auth-identity-units', 'basics', 'basics-units', 'persistence-units', 'warm-tabs', 'tab-wake', 'ask-ai-model', 'auto-model', 'service-worker',
];

const picked = process.argv.slice(2);
const unknown = picked.filter((name) => !SUITES.includes(name));
if (unknown.length) {
  console.error(`Not a core suite: ${unknown.join(', ')}. Core suites: ${SUITES.join(', ')}`);
  process.exit(2);
}

// Each suite runs with its own TEMP folder (scripts/test-tmp.js), removed once the suite is over, however it ended: its copies of
// Lumen leave throwaway profiles there (a suite may read one after Lumen quits), and a full run left gigabytes.
const { suiteTmp } = require('./test-tmp');
// A suite that hangs is killed after this long (the Electron suites are the slow ones).
const TIMEOUT_MS = Number(process.env.LUMEN_SUITE_TIMEOUT_MS) || 600000;

const results = [];
for (const name of picked.length ? picked : SUITES) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const tmp = suiteTmp(name);
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'test', `${name}.js`)], { stdio: 'inherit', env: tmp.env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  tmp.done();
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  results.push({ name, ok: run.status === 0 && !run.error, code: timedOut ? `timeout after ${TIMEOUT_MS / 1000}s` : run.status ?? run.signal ?? run.error?.message, seconds: Math.round((Date.now() - started) / 1000) });
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, ${typeof r.code === 'number' ? 'exit ' : ''}${r.code}`})`);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
