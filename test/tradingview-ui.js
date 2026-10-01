// TradingView watchlist in a real window: Settings imports a list from the (stand-in) TradingView account,
// saves it linked, the card follows the account on refresh, and the new-tab page frames TradingView's
// market overview. The account answer is global.__tvLists (main.js only uses it in test mode), so no
// TradingView sign-in or request is involved in the import; the card's frame is TradingView's own page.
'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };

const TECH = { id: 11, name: 'Tech', symbols: ['###Big', 'NASDAQ:AAPL', 'NASDAQ:MSFT'], active: true };
const CRYPTO = { id: 12, name: 'Crypto', symbols: ['BINANCE:BTCUSDT'] };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-tv-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [] }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const account = (lists) => app.evaluate((_e, l) => { global.__tvCalls = 0; global.__tvLists = async () => { global.__tvCalls++; return l; }; }, lists);
    const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
    const settingsFile = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    // settings.json is written off the main thread: flush before reading it straight off disk.
    const diskSettings = async () => { await app.evaluate(() => global.__settingsFlush()); return settingsFile(); };

    // Signed out: TradingView answers with its sample list, whose id is null.
    await account([{ id: null, name: 'Watchlist', symbols: ['###Indices', 'SPCFD:SPX'] }]);
    const out = await W('tradingviewLists');
    check('signed out, the account has no lists of the user’s', out.signedIn === false && out.lists.length === 0, JSON.stringify(out));

    const settingsId = await app.evaluate(() => global.__settings.open('appearance'));
    const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [settingsId, code]);
    const waitFor = async (code, tries = 40) => { for (let i = 0; i < tries; i++) { if (await sp(code).catch(() => false)) return true; await sleep(150); } return false; };
    await waitFor("Boolean(document.body.dataset.ready && document.getElementById('widget-add'))");
    await sp("document.getElementById('widget-add').click()");
    await sp("document.querySelector('.type-list [data-type=tradingview]').click()");
    await sp("{ const v = document.getElementById('widget-tv-view'); v.value = 'watchlist'; v.dispatchEvent(new Event('change', { bubbles: true })); }");
    const shown = await sp("(() => { const rowHidden = (id) => document.getElementById(id).closest('.row').hidden; return { symbol: rowHidden('widget-tv-symbol'), symbols: !rowHidden('widget-tv-symbols'), sync: !rowHidden('widget-tv-sync') }; })()");
    check('Settings: Watchlist swaps the one-symbol box for the symbols list and its switches', shown.symbol && shown.symbols && shown.sync, JSON.stringify(shown));

    await sp("document.getElementById('widget-tv-import').click()");
    check('Settings: importing while signed out says so and offers Sign in to TradingView', await waitFor("/not signed in/.test(document.getElementById('widget-tv-note').textContent) && !document.getElementById('widget-tv-signin').hidden"), await sp("document.getElementById('widget-tv-note').textContent"));

    await account([TECH, CRYPTO, { id: 13, name: 'Empty', symbols: [] }]);
    await sp("document.getElementById('widget-tv-import').click()");
    check('Settings: signed in, the lists with symbols are offered, the active one picked and filled in', await waitFor("document.querySelectorAll('#widget-tv-lists option').length === 2 && document.getElementById('widget-tv-symbols').value.includes('NASDAQ:MSFT')") && (await sp("document.getElementById('widget-tv-signin').hidden && !document.getElementById('widget-tv-lists').hidden")), await sp("document.getElementById('widget-tv-note').textContent"));
    await sp("{ const l = document.getElementById('widget-tv-lists'); l.value = '12'; l.dispatchEvent(new Event('change')); }");
    check('Settings: picking another list fills in its symbols', (await sp("document.getElementById('widget-tv-symbols').value")) === 'BINANCE:BTCUSDT', await sp("document.getElementById('widget-tv-symbols').value"));
    await sp("{ const l = document.getElementById('widget-tv-lists'); l.value = '11'; l.dispatchEvent(new Event('change')); }");
    await sp("document.getElementById('widget-save').click()");
    await waitFor("!document.getElementById('widget-form')");
    let saved = ((await diskSettings()).homeWidgets || []).find((w) => w.type === 'tradingview');
    check('Settings: the watchlist is saved linked to the account list, sync on, the account’s sections kept', saved && saved.tv.view === 'watchlist' && saved.tv.list?.id === 11 && saved.tv.sync === true && saved.tv.symbols.join() === '###Big,NASDAQ:AAPL,NASDAQ:MSFT', JSON.stringify(saved));
    const item = await sp("[...document.querySelectorAll('.widget-item')].map((e) => e.textContent).join('|')");
    check('Settings: the list row says which list, how many symbols, and that it syncs', /Tech · 2 symbols · synced/.test(item), item);

    // The account changes: a refresh shows the new symbols without touching settings.json.
    await account([{ ...TECH, symbols: ['NASDAQ:NVDA', 'NASDAQ:AMD', 'NASDAQ:AAPL'] }]);
    await sleep(15500); // a widget is fetched at most every 15 s (MIN_REFRESH), even when asked; a forced refresh re-reads the account
    await app.evaluate((_e, id) => global.__widgets.refresh(global.__widgets.list().find((w) => w.id === id), { force: true }), saved.id);
    let card = (await W('forPage')).find((c) => c.id === saved.id);
    const tabs = JSON.parse(decodeURIComponent(new URL(card.data.dark).hash.slice(1))).tabs;
    check('sync: the card follows the account list', tabs[0].symbols.map((s) => s.s).join() === 'NASDAQ:NVDA,NASDAQ:AMD,NASDAQ:AAPL' && card.data.synced && (await app.evaluate(() => global.__tvCalls)) === 1, JSON.stringify(tabs));

    // Signed out later: the last symbols stay, with a note.
    await account([]);
    await sleep(15500);
    await app.evaluate((_e, id) => global.__widgets.refresh(global.__widgets.list().find((w) => w.id === id), { force: true }), saved.id);
    card = (await W('forPage')).find((c) => c.id === saved.id);
    check('sync: signed out later, the card keeps the stored symbols and asks to sign in', /Sign in to TradingView/.test(card.data.note) && /NASDAQ%3AMSFT/.test(card.data.light), card.data.note);

    // The new-tab page frames TradingView's market overview, sandboxed, with the note above it.
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    let got = null;
    for (let i = 0; i < 40 && !got; i++) {
      got = await page(`(() => { const c = document.querySelector('.w-card[data-id="${saved.id}"]'); const f = c && c.querySelector('iframe'); return f ? { cls: c.className, src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox'), note: (c.querySelector('.tv-note') || {}).textContent || '', title: f.title } : null; })()`);
      if (!got) await sleep(150);
    }
    check('new tab: the watchlist card frames TradingView’s market overview, sandboxed without top navigation', got && /tv-watchlist/.test(got.cls) && new URL(got.src).pathname === '/embed-widget/market-overview/' && !/allow-top-navigation/.test(got.sandbox) && got.title === 'Tech from TradingView', JSON.stringify(got));
    check('new tab: the sync note shows on the card', got && /Sign in to TradingView/.test(got.note), got && got.note);

    // Editing the symbols by hand unlinks the list (so the typed list isn't overwritten by the next sync).
    await sp(`document.querySelector('.widget-item[data-id="${saved.id}"]').click()`);
    await waitFor("Boolean(document.getElementById('widget-tv-symbols'))");
    await sp("{ const a = document.getElementById('widget-tv-symbols'); a.value += '\\nNYSE:SPY'; a.dispatchEvent(new Event('input', { bubbles: true })); }");
    await sp("document.getElementById('widget-save').click()");
    await waitFor("!document.getElementById('widget-form')");
    saved = (await diskSettings()).homeWidgets.find((w) => w.id === saved.id);
    check('Settings: typing over an imported list unlinks it and keeps what was typed', saved && !saved.tv.list && saved.tv.symbols.includes('NYSE:SPY'), JSON.stringify(saved && saved.tv));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
