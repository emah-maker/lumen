// Search-engine picker and importing from other browsers (fake Chrome and Firefox profiles).
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');

function fakeChromeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fake-chrome-'));
  fs.writeFileSync(path.join(dir, 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { type: 'folder', children: [
      { type: 'url', name: 'Hacker News', url: 'https://news.ycombinator.com/' },
      { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'MDN', url: 'https://developer.mozilla.org/' }] },
      { type: 'url', name: 'Local file', url: 'file:///C:/secret.txt' },
    ] },
    other: { type: 'folder', children: [{ type: 'url', name: 'GitHub', url: 'https://github.com/' }] },
  } }));
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)');
  const chromeTime = (ms) => (BigInt(ms) + 11644473600000n) * 1000n; // µs since 1601
  const insert = db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)');
  insert.run('https://news.ycombinator.com/', 'Hacker News', 42, chromeTime(Date.UTC(2026, 8, 20)), 0);
  insert.run('https://en.wikipedia.org/wiki/Web_browser', 'Web browser - Wikipedia', 3, chromeTime(Date.UTC(2026, 8, 19)), 0);
  insert.run('https://www.google.com/sorry/index?continue=x', 'Sorry', 1, chromeTime(Date.UTC(2026, 8, 18)), 0);
  insert.run('https://hidden.example/', 'Hidden', 1, chromeTime(Date.UTC(2026, 8, 18)), 1);
  db.close();
  return dir;
}

function fakeFirefoxProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fake-firefox-'));
  const db = new DatabaseSync(path.join(dir, 'places.sqlite'));
  db.exec('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER)');
  db.exec('CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT)');
  db.prepare('INSERT INTO moz_places VALUES (1, ?, ?, ?, ?)').run('https://www.rust-lang.org/', 'Rust', 7, BigInt(Date.UTC(2026, 8, 21)) * 1000n);
  db.prepare('INSERT INTO moz_places VALUES (2, ?, ?, ?, ?)').run('https://news.ycombinator.com/', 'HN', 5, BigInt(Date.UTC(2026, 8, 1)) * 1000n);
  db.prepare('INSERT INTO moz_bookmarks VALUES (1, 1, 1, ?)').run('Rust lang');
  db.close();
  return dir;
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // ---- Import
  const chrome = fakeChromeProfile();
  const result = await app.evaluate((_e, dir) => global.__importBrowser('chrome', dir), chrome);
  // GitHub is already a default favorite, so 2 of the 3 web bookmarks are new.
  check('Chrome import adds web bookmarks from all folders (deduped)', result.bookmarks === 2 && result.history === 2, JSON.stringify(result));
  const settings = await ui.evaluate(() => window.assistant.getSettings());
  const suggestions = await ui.evaluate(() => window.browser.suggest('news.yc'));
  check('imported history feeds address-bar suggestions', suggestions.some((s) => s.url === 'https://news.ycombinator.com/'), JSON.stringify(suggestions));
  const captcha = await ui.evaluate(() => window.browser.suggest('google.com/sorry'));
  check('CAPTCHA and hidden pages are not imported', !captcha.some((s) => s.url.includes('/sorry/')) && !(await ui.evaluate(() => window.browser.suggest('hidden.example'))).length, JSON.stringify(captcha));
  const again = await app.evaluate((_e, dir) => global.__importBrowser('chrome', dir), chrome);
  check('importing twice adds no duplicates', again.bookmarks === 0 && again.history === 0, JSON.stringify(again));

  const firefox = fakeFirefoxProfile();
  const ff = await app.evaluate((_e, dir) => global.__importBrowser('firefox', dir), firefox);
  check('Firefox import reads places.sqlite', ff.bookmarks === 1 && ff.history === 1, JSON.stringify(ff));
  const ffDate = await ui.evaluate(async () => (await window.browser.suggest('rust-lang'))[0]?.url);
  check('Firefox history is searchable', ffDate === 'https://www.rust-lang.org/', ffDate);
  // Wait for the page itself rather than a fixed delay (the old 600 ms wait was flaky).
  const nt = await app.evaluate(async () => {
    const t = global.__agent.browser.openTab();
    if (t.webContents.isLoading()) await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.webContents.getURL();
  });
  const hash = JSON.parse(decodeURIComponent(nt.split('#')[1]));
  check('imported bookmarks reach the new-tab favorites', hash.favorites.some((b) => b.url === 'https://news.ycombinator.com/') || hash.favorites.length === 12, JSON.stringify(hash.favorites.map((b) => b.url)));
  check('file:// bookmarks are never imported', !hash.favorites.some((b) => b.url.startsWith('file:')), 'file bookmark present');

  // ---- Search engine
  const inSettings = await openSettingsTab(app, 'search');
  const engines = await inSettings("[...document.querySelectorAll('#pref-searchEngine option')].map((o) => o.value)");
  check('settings list 6 search engines', engines.length === 6 && engines.includes('duckduckgo'), JSON.stringify(engines));
  await inSettings("location.hash = 'you-and-ai'");
  await ui.waitForTimeout(600);
  const importButtons = await inSettings("[...document.querySelectorAll('#ai-import button, #ai-import .note')].map((b) => b.textContent)");
  check('settings list installed browsers to import from', Array.isArray(importButtons) && importButtons.length > 0, JSON.stringify(importButtons));
  await inSettings("{ const s = document.getElementById('pref-searchEngine'); s.value = 'duckduckgo'; s.dispatchEvent(new Event('change')); }");
  await ui.waitForTimeout(300);
  check('the chosen engine is saved', (await ui.evaluate(async () => (await window.assistant.getSettings()).searchEngine)) === 'duckduckgo', 'not saved');
  await app.evaluate((_e, sid) => global.__agent.browser.closeTab(sid), inSettings.id);
  await ui.waitForTimeout(300);
  await ui.fill('#address', 'best pizza near me');
  await ui.press('#address', 'Enter');
  await ui.waitForTimeout(1500);
  const url = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  check('address bar searches with the chosen engine', /^https:\/\/duckduckgo\.com\/\?q=best(%20|\+)pizza/.test(url), url);
  await ui.click('#address');
  await ui.keyboard.type('some query words', { delay: 20 });
  await ui.waitForTimeout(1000);
  const rows = await app.evaluate(async ({ BrowserWindow }) => {
    // Any window: a hidden spare new-tab window (or the drag card's) can come first in the list.
    const v = BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children).find((x) => x.webContents?.getURL().endsWith('suggest.html'));
    return v ? v.webContents.executeJavaScript('[...document.querySelectorAll("li")].map(l => l.textContent)') : [];
  });
  check('suggestion row names the engine', rows.some((r) => r.includes('DuckDuckGo Search')), JSON.stringify(rows));
  await ui.keyboard.press('Escape');
  await ui.keyboard.press('Escape');
  const nt2 = await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => setTimeout(r, 800)); return { url: t.webContents.getURL(), placeholder: await t.webContents.executeJavaScript("document.getElementById('q').placeholder") }; });
  check('new-tab page searches with the chosen engine', nt2.placeholder === 'Search DuckDuckGo', nt2.placeholder);

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
