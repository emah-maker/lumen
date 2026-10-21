// `npm test`: runs the core suites one after another (never in parallel: several of them move focus
// between windows) and keeps going past a failure, then prints which suites failed.
// `npm test -- tabstrip groups` runs just those. Suites that need the network, an API key or a
// signed-in CLI (claudecode, drm, measure, topics-bench, …) stay manual: `node test/e2e/<name>.js`.
// `LUMEN_TEST_BACKGROUND=1 npm test`: test windows are invisible and never take focus (main.js), so
// a run doesn't get in the way of a Lumen you're using; checks that need OS focus print SKIP.
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'units', 'release-tooling-units', 'handoff-units', 'image-intent-units', 'image-infer-units', 'image-context-units', 'chat-versions-units', 'chat-save-async-units', 'step-labels-units', 'step-thumbs-units', 'claudecode-full-units', 'cli-full-access-units', 'tab-chats-units', 'automation-units', 'chat-items-units', 'chat-context-units', 'chat-history-units', 'ai-manners-units', 'close-ai-tabs-units', 'device-access-units', 'device-access', 'desktop-units', 'desktop-live-units', 'desktop-apps', 'feature-offers-units', 'feature-offers', 'hide-activity-units', 'hide-activity', 'tracking-links', 'bypass-permissions-units', 'bypass-background-units', 'bypass-background-security-units', 'bypass-permissions-ui', 'model-route-units', 'auto-model-units', 'auto-engines-units', 'local-models-units', 'auto-agent-units', 'fallback-units', 'antigravity-units', 'hidden-spawn-units', 'cwd-units', 'e2e-lock-units', 'mcp-hardening-units', 'external-apps-units', 'switch-timing-units', 'perf-budget', 'tab-queue-units', 'tab-switch-perf', 'chat-tab-speed', 'cli-json', 'no-errors', 'tools', 'ui', 'images', 'uploads', 'models', 'local-models', 'adhd', 'extensions', 'adblock', 'adblock-youtube-units', 'adblock-youtube', 'pagecontext', 'page-text-units', 'fullpage-no-shots-units', 'frames', 'frames-units', 'iframe-post', 'adblock-providers-units', 'cc-settings-units', 'reply-stuck-units', 'handoff',
  'chat-versions', 'chat-features2', 'dialogs', 'recovery', 'tasklock', 'tabstrip', 'tabmenu', 'split-view', 'tab-unload-units', 'tab-unload', 'chrome-ux', 'tabui', 'tab-icons', 'tabsearch', 'command-bar-units', 'command-bar', 'side-tabs-units', 'side-tabs', 'downloads', 'ai-downloads', 'acting-helpers', 'hardening', 'exfil', 'aicontrols', 'doc-edit-units', 'document-tool', 'content-guard-units', 'content-guard', 'security-ui', 'safe-browsing', 'focus', 'a11y', 'toolbar-layout', 'ext-pins-units', 'hide-extensions', 'windowdrag', 'updates',
  'mcp', 'external-apps', 'codex-connect', 'mcpclient', 'connectors', 'netfetch', 'settings', 'groups', 'organize-files', 'screen-local', 'cdp', 'browser', 'home', 'first-run', 'stuck-load', 'windows', 'private', 'tabdetach', 'pagetools', 'screenshot', 'translate', 'translate-local-units', 'translate-download-units', 'translate-group-units', 'managers', 'reading-list', 'chats', 'chat-list-recency', 'chat-project-drag', 'chat-parallel-project', 'chat-composer', 'dictation', 'screen-recorder-units', 'screen-recorder', 'composer-height', 'composer-bar', 'late-picture', 'chatpage', 'working-on-chip', 'ai-drive-flash', 'ai-task-flicker', 'chat-image-zoom', 'chat-actions-dup', 'chat-ui-polish', 'svg-view-units', 'svg-view', 'step-labels', 'page-load-stall', 'tab-chips-units', 'tab-chips', 'ui-consistency', 'relaunch', 'quit-saves', 'first-tab-restart', 'chat-save-stall', 'newtab-ask-ai', 'newtab-images', 'newtab-images-units', 'chat-page-from-home-units', 'canvas', 'ai-files', 'tabchats', 'chat-parallel-claude-code', 'tabchats-follow', 'sidebar-tab-state', 'sidebar-stays', 'sidebar-newchat', 'sidebar-open-newtab', 'newtab-wallpaper', 'settings-preview', 'meeting-open', 'sidebar-keeps-run', 'ai-close-focus', 'send-now', 'reply-stuck-ui', 'aimanners', 'close-ai-tabs', 'ai-tab-group', 'close-ai-tabs-paths', 'ai-tabs-ux', 'aitaboff', 'edit-keys-units', 'edit-keys', 'files', 'eml-viewer', 'restore-open-files', 'session-files-units', 'read-docs-pdf', 'pdf-zoom-keys', 'pdf-first-paint', 'pdf-blob-paint', 'viewer-cls', 'pptx-images-units', 'pptx-images', 'pptx-shapes-units', 'pptx-shapes', 'slides-nav-units', 'slides-nav', 'tab-cycle-keys', 'tab-reopen-keys', 'page-first-keys-units', 'page-first-shortcuts', 'page-shortcuts', 'shortcuts-help-units', 'shortcuts-keys', 'usage', 'look', 'music-react', 'tabsask', 'skills', 'bgtasks', 'mission-control-units', 'mission-control', 'routines-units', 'settings-routines-units', 'routine-phrase-units', 'routines-card-units', 'routines', 'routines-schedule', 'routine-triggers-units', 'routine-triggers', 'widgets', 'github-signin', 'spotify-ui', 'spotify-home-ui', 'spotify-reconnect-ui', 'apple-music-ui', 'apple-music-status-ui', 'apple-music-engine-ui', 'music-search-ui', 'spotify-engine-ui', 'calendar-multi-units', 'widget-resilience-units', 'widget-refresh-press-units', 'calendar-multi', 'edit-shake', 'newtab-scroll', 'newtab-states-ui', 'todoist-refresh-ui', 'tradingview-refresh-ui', 'layout-edit-positions', 'tradingview-ui', 'tradingview-fit', 'cdp-inproc', 'whats-new', 'passwords', 'sync-settings', 'passkeys', 'permissions', 'notify-click', 'phone-files', 'phone-wifi', 'updates-units', 'update-restart-units', 'update-swap-locked', 'update-retry-units', 'updater-session', 'signing-units', 'package-files-units', 'chrome-identity-units', 'google-auth-identity-units', 'basics', 'basics-units', 'persistence-units', 'warm-tabs', 'tab-wake', 'tab-ready', 'video-frames', 'hang-recorder', 'hang-recorder-units', 'gpu-health-units', 'gpu-health', 'a11y-mode', 'settings-lazy', 'graphics-units', 'igpu-perf', 'software-mode', 'chat-store-missing-units', 'ask-ai-model', 'auto-model', 'service-worker', 'project-folders-units', 'project-folders', 'files-store-units', 'files-fuzzy-units', 'files-index-units', 'files-ai', 'files-ui-units', 'files-widget', 'files-picker', 'notes', 'overlay-first-perf',
];

const picked = process.argv.slice(2);
const unknown = picked.filter((name) => !SUITES.includes(name));
if (unknown.length) {
  console.error(`Not a core suite: ${unknown.join(', ')}. Core suites: ${SUITES.join(', ')}`);
  process.exit(2);
}

// Each suite runs with its own TEMP folder (scripts/test/test-tmp.js), removed once the suite is over, however it ended: its copies of
// Lumen leave throwaway profiles there (a suite may read one after Lumen quits), and a full run left gigabytes.
const { suiteTmp } = require('./test-tmp');
// A suite that hangs is killed after this long (the Electron suites are the slow ones).
const TIMEOUT_MS = Number(process.env.LUMEN_SUITE_TIMEOUT_MS) || 600000;

// Each Electron suite runs under the machine-wide lock (scripts/test/e2e-lock.js) so parallel agents never overlap; pure-node suites need none.
const { withLockSync } = require('./e2e-lock');
const { isPlainSuite, suiteFile } = require('../release/release-lib');

const results = [];
for (const name of picked.length ? picked : SUITES) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const tmp = suiteTmp(name);
  const go = () => spawnSync(process.execPath, [path.join(__dirname, '..', '..', suiteFile(name))], { stdio: 'inherit', env: tmp.env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  const run = isPlainSuite(name) ? go() : withLockSync(go, { owner: 'test-all' });
  tmp.done();
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  results.push({ name, ok: run.status === 0 && !run.error, code: timedOut ? `timeout after ${TIMEOUT_MS / 1000}s` : run.status ?? run.signal ?? run.error?.message, seconds: Math.round((Date.now() - started) / 1000) });
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, ${typeof r.code === 'number' ? 'exit ' : ''}${r.code}`})`);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
