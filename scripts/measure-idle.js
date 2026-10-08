/* global document */
// Idle main-process wakeups and settings.json writes (hidden window, throwaway profile, never focused).
//   node scripts/measure-idle.js [--secs 120] [--quiet] [--app <checkout dir>]
// Seeds a session of 3 tabs, one of them a background tab whose title ticks every second, launches Lumen hidden
// (LUMEN_TEST_BACKGROUND), preloads a hook that counts main-process timer callbacks (setTimeout/setInterval, from the
// very start) and settings.json renames, waits for start-up to settle, then counts for --secs seconds.
// --quiet forces the scheduler's quiet state (as if every window were minimised); only builds that have it.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SECS = Number(val('secs', 120));
const APP = path.resolve(val('app', path.join(__dirname, '..')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, (SECS + 150) * 1000);

const hook = path.join(os.tmpdir(), 'lumen-idle-hook.js');
fs.writeFileSync(hook, `
const stats = { timers: 0, settingsWrites: 0, historyWrites: 0, otherWrites: 0 };
global.__idleStats = stats;
for (const name of ['setTimeout', 'setInterval']) {
  const orig = global[name];
  global[name] = function (fn, ms, ...rest) {
    if (typeof fn !== 'function') return orig.call(this, fn, ms, ...rest);
    return orig.call(this, function () { stats.timers++; return fn.apply(this, arguments); }, ms, ...rest);
  };
}
const fs = require('fs');
const note = (dest) => { const d = String(dest); if (/settings[.]json$/.test(d)) stats.settingsWrites++; else if (/history[.]json$/.test(d)) stats.historyWrites++; else if (/[.]json$/.test(d)) stats.otherWrites++; };
const rn = fs.promises.rename; fs.promises.rename = function (a, b) { note(b); return rn.apply(this, arguments); };
const rs = fs.renameSync; fs.renameSync = function (a, b) { note(b); return rs.apply(this, arguments); };
`);

// NODE_OPTIONS=--require is switched off in Electron builds, so a tiny entry point loads the hook, then the real main.
const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-idle-entry-'));
const appPkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(entryDir, 'package.json'), JSON.stringify({ name: appPkg.name, productName: appPkg.productName, version: appPkg.version, main: 'entry.js' }));
fs.writeFileSync(path.join(entryDir, 'entry.js'), `require(${JSON.stringify(hook)}); require('electron').app.setAppPath(${JSON.stringify(APP)}); require(${JSON.stringify(path.join(APP, appPkg.main || 'main.js'))});`);

const server = http.createServer((req, res) => {
  const n = new URL(req.url, 'http://x').pathname.slice(1);
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Page ${n}</title><body><h1>Page ${n}</h1>${n === '1' ? '<script>setInterval(()=>{document.title="tick "+Date.now()},1000)</script>' : ''}</body>`);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-idle-'));
  const urls = [0, 1, 2].map((i) => `${base}/${i}`);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ session: { urls, titles: urls.map((_, i) => `Page ${i}`), favicons: urls.map(() => null), active: 0, groupIds: urls.map(() => null), pinned: urls.map(() => false) } }));
  const app = await electron.launch({ args: [entryDir], timeout: 60000, env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab', { timeout: 60000 });
    // Restored background tabs are placeholders until opened: open the ticking page for real, then go back to the first tab.
    await ui.click('#new-tab'); await ui.fill('#address', `${base}/1`); await ui.press('#address', 'Enter');
    await ui.waitForFunction(() => document.querySelector('.tab.active .tab-title')?.textContent.includes('Page 1'), null, { timeout: 15000 });
    await ui.locator('.tab', { hasText: 'Page 0' }).first().click();
    await ui.waitForFunction(() => /Page 0/.test(document.querySelector('.tab.active .tab-title')?.textContent || ''), null, { timeout: 15000 });
    await sleep(15000); // start-up settles (restore, first saves, update checks)
    if (args.includes('--quiet')) await app.evaluate(() => global.__scheduler.setQuietOverride(true));
    const read = () => app.evaluate(() => ({ ...global.__idleStats }));
    const a = await read();
    const t0 = Date.now();
    await sleep(SECS * 1000);
    const b = await read();
    const secs = (Date.now() - t0) / 1000;
    const out = { app: APP, secs: Math.round(secs), quiet: args.includes('--quiet') };
    for (const k of Object.keys(a)) out[k] = b[k] - a[k];
    out.timerWakeupsPerSec = Number((out.timers / secs).toFixed(3));
    out.settingsWritesPerMin = Number((out.settingsWrites * 60 / secs).toFixed(2));
    out.tabs = await ui.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => (t.classList.contains('active') ? '*' : '') + t.textContent.trim().slice(0, 24)));
    out.settingsAfter = (() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).session?.titles; } catch { return null; } })();
    out.scheduler = await app.evaluate(() => (global.__scheduler ? global.__scheduler.stats() : null)).catch(() => null);
    console.log(JSON.stringify(out, null, 1));
  } finally {
    await app.close().catch(() => {});
    server.close();
    clearTimeout(hardStop);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(entryDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
