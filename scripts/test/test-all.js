// `npm test`: runs the core suites one after another (never in parallel: several of them move focus
// between windows) and keeps going past a failure, then prints which suites failed.
// `npm test -- tabstrip groups` runs just those. Suites that need the network, an API key or a
// signed-in CLI (claudecode, drm, measure, topics-bench, …) stay manual: `node test/e2e/<name>.js`.
// `LUMEN_TEST_BACKGROUND=1 npm test`: test windows are invisible and never take focus (main.js), so
// a run doesn't get in the way of a Lumen you're using; checks that need OS focus print SKIP.
const { spawnSync } = require('child_process');
const path = require('path');

// The second-last line of SUITES: 41 local suites that ran outside the release until 2026-11-25, found passing by a sweep; the last line: three
// more found by the 2026-11-27 sweep. The suites still left out (network, a real account, a signed-in CLI) are in scripts/test/manual-suites.js,
// each with its reason; release-tooling-units fails on a test/e2e file in neither list. Comments stay out of the list itself: release-lib.js readSuites parses it.
const SUITES = [
  'units', 'ime-enter-units', 'release-tooling-units', 'handoff-units', 'image-intent-units', 'image-infer-units', 'image-context-units', 'chat-versions-units', 'chat-save-async-units', 'step-labels-units', 'step-thumbs-units', 'claudecode-full-units', 'cc-helpers-units', 'cli-full-access-units', 'tab-chats-units', 'automation-units', 'chat-items-units', 'chat-context-units', 'chat-history-units', 'ai-manners-units', 'close-ai-tabs-units', 'device-access-units', 'device-access', 'desktop-units', 'desktop-live-units', 'desktop-apps', 'feature-offers-units', 'feature-offers', 'hide-activity-units', 'hide-activity', 'tracking-links', 'bypass-permissions-units', 'bypass-background-units', 'bypass-background-security-units', 'bypass-permissions-ui', 'model-route-units', 'auto-model-units', 'auto-engines-units', 'local-models-units', 'auto-agent-units', 'fallback-units', 'antigravity-units', 'hidden-spawn-units', 'cwd-units', 'e2e-lock-units', 'mcp-hardening-units', 'mcp-cold-start-units', 'external-apps-units', 'external-apps-connect-units', 'switch-timing-units', 'perf-budget', 'tab-queue-units', 'tab-switch-perf', 'chat-tab-speed', 'cli-json', 'no-errors', 'tools', 'ui', 'images', 'key-switches', 'uploads', 'models', 'local-models', 'adhd', 'extensions', 'adblock', 'ublock-mode', 'ublock-rebuilt', 'ublock-origin', 'adblock-youtube-units', 'adblock-youtube', 'pagecontext', 'page-text-units', 'fullpage-no-shots-units', 'frames', 'frames-units', 'iframe-post', 'adblock-providers-units', 'cc-settings-units', 'reply-stuck-units', 'handoff',
  'chat-versions', 'ime-enter', 'chat-features2', 'dialogs', 'recovery', 'tasklock', 'math-render', 'tabstrip', 'tabmenu', 'split-view', 'split-restore', 'tab-unload-units', 'tab-unload', 'chrome-ux', 'omnibox-units', 'omnibox-chrome', 'omnibox-click', 'tabui', 'tab-icons', 'media-controls', 'media-hub-units', 'tabsearch', 'command-bar-units', 'command-bar', 'side-tabs-units', 'side-tabs', 'group-drag-out', 'ai-tabs-seen', 'downloads', 'ai-downloads', 'acting-helpers', 'agent-tags-units', 'agent-cursors', 'select-boxes-units', 'select-boxes', 'hardening', 'exfil', 'aicontrols', 'doc-edit-units', 'document-tool', 'content-guard-units', 'content-guard', 'security-ui', 'safe-browsing', 'focus', 'a11y', 'toolbar-layout', 'ext-pins-units', 'hide-extensions', 'extensions-manage', 'extension-dialogs', 'extension-sites-except', 'windowdrag', 'updates',
  'mcp', 'external-apps', 'external-apps-connect', 'codex-connect', 'mcpclient', 'canvas-pages-units', 'connectors', 'engine-parity', 'canvas-pages', 'netfetch', 'settings', 'groups', 'organize-files', 'screen-local', 'page-in-front-units', 'page-in-front', 'cdp', 'browser', 'home', 'first-run', 'stuck-load', 'windows', 'private', 'tabdetach', 'pagetools', 'find-case', 'screenshot', 'screenshot-parallel', 'screenshot-hidden', 'translate', 'translate-local-units', 'translate-download-units', 'translate-group-units', 'managers', 'bookmark-bar-units', 'bookmarks-bar', 'reading-list', 'chats', 'chat-list-recency', 'chat-list-steady', 'chat-row-steady', 'chat-auto-delete', 'chat-project-drag', 'chat-parallel-project', 'chat-composer', 'dictation', 'screen-recorder-units', 'screen-recorder', 'composer-height', 'composer-bar', 'late-picture', 'chatpage', 'chatpage-sidebar', 'working-on-chip', 'ai-drive-flash', 'ai-task-flicker', 'chat-image-zoom', 'chat-actions-dup', 'chat-ui-polish', 'svg-view-units', 'svg-view', 'step-labels', 'page-load-stall', 'tab-chips-units', 'tab-chips', 'ui-consistency', 'relaunch', 'profiles', 'quit-saves', 'first-tab-restart', 'restore-active-tab', 'site-light', 'force-dark', 'chat-save-stall', 'newtab-ask-ai', 'newtab-images', 'newtab-images-units', 'chat-page-from-home-units', 'canvas', 'ai-files', 'office-units', 'office-previews', 'tabchats', 'chat-parallel-claude-code', 'chat-helper-progress', 'review-loop', 'review-loop-card', 'live-card-steady', 'chat-no-jump', 'run-replay', 'live-card-tabs', 'tabchats-follow', 'sidebar-tab-state', 'sidebar-switch-bounds', 'sidebar-stays', 'sidebar-newchat', 'auto-new-chat-units', 'auto-new-chat', 'sidebar-open-newtab', 'newtab-wallpaper', 'settings-preview', 'meeting-open', 'sidebar-keeps-run', 'sidebar-running-chat', 'ai-close-focus', 'send-now', 'chat-queue-ui', 'mid-run-steer', 'reply-stuck-ui', 'aimanners', 'close-ai-tabs', 'close-ai-tab-by-user', 'ai-tab-group', 'ai-tab-finder-units', 'ai-tab-finder', 'ai-tabs-hidden', 'close-ai-tabs-paths', 'ai-tab-tidy', 'ai-tabs-ux', 'aitaboff', 'account-tabs', 'edit-keys-units', 'edit-keys', 'files', 'eml-viewer', 'restore-open-files', 'session-files-units', 'read-docs-pdf', 'pdf-zoom-keys', 'pdf-first-paint', 'pdf-fallback-stuck', 'pdf-blob-paint', 'pdf-save', 'annotate-write', 'annotate-scale', 'viewer-cls', 'pptx-images-units', 'pptx-images', 'pptx-shapes-units', 'pptx-shapes', 'slides-nav-units', 'slides-nav', 'tab-cycle-keys', 'tab-reopen-keys', 'page-first-keys-units', 'page-first-shortcuts', 'page-shortcuts', 'shortcuts-help-units', 'shortcuts-keys', 'usage', 'engine-usage-bar', 'look', 'tabsask', 'skills', 'bgtasks', 'mission-control-units', 'mission-control', 'automations-units', 'automations', 'routines-units', 'settings-routines-units', 'routine-phrase-units', 'routines-card-units', 'routines', 'routines-schedule', 'routine-triggers-units', 'routine-triggers', 'widgets', 'github-signin', 'spotify-ui', 'spotify-home-ui', 'spotify-reconnect-ui', 'apple-music-ui', 'apple-music-status-ui', 'apple-music-engine-ui', 'music-search-ui', 'spotify-engine-ui', 'calendar-multi-units', 'widget-resilience-units', 'widget-refresh-press-units', 'calendar-multi', 'edit-shake', 'newtab-scroll', 'spotify-scroll', 'newtab-states-ui', 'todoist-refresh-ui', 'tradingview-refresh-ui', 'layout-edit-positions', 'newtab-no-jump', 'tradingview-ui', 'tradingview-fit', 'cdp-inproc', 'whats-new', 'passwords', 'password-import', 'password-generator-units', 'password-generator', 'sync-settings', 'secret-box', 'passkeys', 'permissions', 'notify-click', 'phone-files', 'phone-wifi', 'updates-units', 'update-restart-units', 'swap-journal-units', 'update-swap-locked', 'update-retry-units', 'updater-session', 'signing-units', 'package-files-units', 'chrome-identity-units', 'google-auth-identity-units', 'basics', 'basics-units', 'persistence-units', 'session-store-units', 'warm-tabs', 'tab-wake', 'tab-ready', 'video-frames', 'hang-recorder', 'hang-recorder-units', 'gpu-health-units', 'gpu-health', 'video-overlays', 'a11y-mode', 'settings-lazy', 'settings-routing', 'settings-drill-in', 'settings-saving', 'graphics-units', 'igpu-perf', 'software-mode', 'chat-store-missing-units', 'ask-ai-model', 'auto-model', 'service-worker', 'project-folders-units', 'project-folders', 'project-list-units', 'project-list', 'project-chats-fold', 'temp-projects-units', 'temp-projects', 'project-drive-units', 'project-drive', 'project-memory-units', 'project-memory', 'job-outcomes', 'files-store-units', 'files-fuzzy-units', 'files-index-units', 'files-ai', 'files-ui-units', 'files-widget', 'files-picker', 'notes', 'overlay-first-perf',
  'ai-tab-size', 'aistatus-ui', 'browser-card-dedupe', 'btw', 'card-first-step', 'chat-draft-survives', 'chat-image-per-chat', 'chat-queue-same-chat', 'close-guard', 'crash', 'device-chooser', 'drive-upload', 'efficiency', 'effort-picker', 'extension-perf', 'fewer-tabs', 'gmail-ui', 'helpers-auto', 'import', 'music-card-ui', 'newtab-focus', 'newtab-tiles', 'particles-perf', 'print-preview', 'project-page', 'project-portable', 'project-workspace', 'providers', 'read-tables', 'reopened-chat-files', 'screenshot-no-resize', 'settings-search-speed', 'sidebar-slide-smooth', 'sidebar-tabs', 'slack-setup-ui', 'spotify-library-ui', 'spotify-pause-ui', 'stack-dots-only', 'step-rows', 'stuck-stop', 'tab-close-window', 'ccimage', 'genimages', 'macros', 'mcp-takeover', 'mcp-window', 'setup', 'tradingview-interval', 'ai-reads-sources'
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

// After each suite: any Electron from this checkout still running is a leftover (a suite killed on its timeout leaves its app behind,
// since the kill reaches only the suite's node process). A full run once left 25 of them, still holding windows and processes.
// Only this checkout's node_modules/electron is matched, so another checkout's run and the installed Lumen are never touched.
const ELECTRON_DIR = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist');
function killStrays() {
  if (process.platform === 'win32') {
    const dir = ELECTRON_DIR.replace(/'/g, "''");
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', timeout: 30000 });
  } else {
    spawnSync('pkill', ['-9', '-f', ELECTRON_DIR], { stdio: 'ignore', timeout: 30000 });
  }
}

const results = [];
for (const name of picked.length ? picked : SUITES) {
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const tmp = suiteTmp(name);
  const go = () => spawnSync(process.execPath, [path.join(__dirname, '..', '..', suiteFile(name))], { stdio: 'inherit', env: tmp.env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  const run = isPlainSuite(name) ? go() : withLockSync(() => { try { return go(); } finally { killStrays(); } }, { owner: 'test-all' });
  tmp.done();
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  results.push({ name, ok: run.status === 0 && !run.error, code: timedOut ? `timeout after ${TIMEOUT_MS / 1000}s` : run.status ?? run.signal ?? run.error?.message, seconds: Math.round((Date.now() - started) / 1000) });
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s${r.ok ? '' : `, ${typeof r.code === 'number' ? 'exit ' : ''}${r.code}`})`);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed: ${failed.map((r) => r.name).join(', ')}` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
