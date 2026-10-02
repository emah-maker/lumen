// TradingView cards at small sizes, in a real window (the pure rules are in test/tradingview-units.js):
// a card as small as 2 x 2 cells has a frame of about 68 px, where TradingView's full chart is all toolbar,
// a watchlist's tab row eats the first rows and the mini price clips. So the new-tab page swaps what the frame
// shows by its size (features/tradingview-fit.js) and shrinks the mini view to fit, and swaps back when the
// card grows. The frames load TradingView's own pages; nothing here needs a sign-in.
'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };

const CHART = 'wtvchart01';
const MINI = 'wtvmini001';
const LIST = 'wtvlist001';
const widgets = [
  { id: CHART, type: 'tradingview', tv: { symbol: 'NASDAQ:AAPL', interval: 'D', view: 'chart', theme: 'light' }, x: 0, y: 0, w: 2, h: 2 },
  { id: MINI, type: 'tradingview', tv: { symbol: 'NASDAQ:AAPL', interval: 'D', view: 'mini', theme: 'light' }, x: 3, y: 0, w: 2, h: 2 },
  { id: LIST, type: 'tradingview', tv: { view: 'watchlist', theme: 'light', chart: true, symbols: ['###Tech', 'NASDAQ:AAPL', 'NASDAQ:TSLA', '###Crypto', 'BINANCE:BTCUSDT', '###Index', 'SPX'] }, x: 6, y: 0, w: 2, h: 2 },
];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-tvfit-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    // What one card's frame shows now: the embed's path, its tabs and chart switch (watchlist), and how it is shrunk.
    const look = (id) => page(`(() => {
      const c = document.querySelector('.w-card[data-id="${id}"]'); const f = c && c.querySelector('iframe'); const box = c && c.querySelector('.tv-fit');
      if (!f || !f.getAttribute('src')) return null;
      const u = new URL(f.getAttribute('src')); let opts = null;
      try { opts = JSON.parse(decodeURIComponent(u.hash.slice(1))); } catch {}
      const r = box.getBoundingClientRect();
      return { path: u.pathname, tabs: opts && opts.tabs ? opts.tabs.length : 0, chart: opts ? opts.showChart : null, transform: f.style.transform, fw: f.style.width, box: [Math.round(r.width), Math.round(r.height)], over: box.scrollWidth > box.clientWidth + 1 };
    })()`);
    const until = async (id, test, tries = 60) => { let got = null; for (let i = 0; i < tries; i++) { got = await look(id).catch(() => null); if (got && test(got)) return got; await sleep(150); } return got; };
    const place = (rects) => app.evaluate((_e, r) => global.__widgets.layout(r), rects);
    const scaleOf = (g) => (g && g.transform ? Number(/scale\(([\d.]+)\)/.exec(g.transform)?.[1]) : 1);

    // ---- small: 2 x 2 cells ----
    const chartSmall = await until(CHART, (g) => g.path === '/embed-widget/mini-symbol-overview/');
    check('small chart: the 2 x 2 card shows the mini price view, not the full chart’s toolbar', chartSmall && chartSmall.path === '/embed-widget/mini-symbol-overview/', JSON.stringify(chartSmall));
    check('small chart: the frame is shrunk to fit and nothing overflows the card', chartSmall && scaleOf(chartSmall) < 1 && scaleOf(chartSmall) >= 0.6 && !chartSmall.over, JSON.stringify(chartSmall));
    const miniSmall = await until(MINI, () => true);
    check('small mini: the price view stays the price view, shrunk to fit', miniSmall && miniSmall.path === '/embed-widget/mini-symbol-overview/' && scaleOf(miniSmall) < 1 && !miniSmall.over, JSON.stringify(miniSmall));
    const listSmall = await until(LIST, () => true);
    check('small watchlist: one flat list with no tab row and no chart on top', listSmall && listSmall.path === '/embed-widget/market-overview/' && listSmall.tabs === 1 && listSmall.chart === false && !listSmall.over, JSON.stringify(listSmall));

    // ---- grown: the same cards swap back to the full views ----
    await place([{ id: CHART, x: 0, y: 0, w: 6, h: 6 }, { id: MINI, x: 6, y: 0, w: 4, h: 3 }, { id: LIST, x: 0, y: 7, w: 6, h: 8 }]);
    const chartBig = await until(CHART, (g) => g.path === '/widgetembed/');
    check('big chart: the full chart is back once the card has room', chartBig && chartBig.path === '/widgetembed/' && !chartBig.transform && !chartBig.over, JSON.stringify(chartBig));
    const miniBig = await until(MINI, (g) => !g.transform);
    check('big mini: shown at full size, no shrinking', miniBig && miniBig.path === '/embed-widget/mini-symbol-overview/' && !miniBig.transform, JSON.stringify(miniBig));
    const listBig = await until(LIST, (g) => g.tabs === 3);
    check('big watchlist: its tab row and chart are back', listBig && listBig.tabs === 3 && listBig.chart === true, JSON.stringify(listBig));

    // ---- and small again ----
    await place([{ id: CHART, x: 0, y: 0, w: 2, h: 2 }, { id: MINI, x: 3, y: 0, w: 2, h: 2 }, { id: LIST, x: 6, y: 0, w: 2, h: 2 }]);
    const chartAgain = await until(CHART, (g) => g.path === '/embed-widget/mini-symbol-overview/');
    const listAgain = await until(LIST, (g) => g.tabs === 1);
    check('shrinking again swaps back to the compact views', chartAgain && chartAgain.path === '/embed-widget/mini-symbol-overview/' && listAgain && listAgain.tabs === 1 && listAgain.chart === false, JSON.stringify([chartAgain, listAgain]));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
