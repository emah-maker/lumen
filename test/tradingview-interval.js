// TradingView chart card in a real window: it follows the dark/light scheme (and changes with it), takes the dark
// chart on a wallpaper page (whose cards are dark whatever the scheme), and its interval menu reloads the chart at
// the picked bar size and remembers the pick.
'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };

// Opens a profile with the chart card on the new tab page; the page's prefers-color-scheme is emulated (the in-app
// setting drives it through nativeTheme, which a background test window does not pass on).
async function withChart(extra, run, tv = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-tvi-'));
  const widget = { id: 'wtvi0001', x: 0, y: 0, w: 6, h: 5, type: 'tradingview', tv: { symbol: 'NASDAQ:CONL', interval: 'D', view: 'chart', theme: 'auto', ...tv } };
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [widget], ...extra }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const scheme = (v) => app.evaluate(async (_e, val) => { const d = global.__wtab.webContents.debugger; if (!d.isAttached()) d.attach('1.3'); await d.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: val }] }); }, v);
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    const src = async () => { for (let i = 0; i < 60; i++) { const u = await page(`(() => { const f = document.querySelector('.w-card.tradingview iframe'); return f && f.getAttribute('src'); })()`); if (u) return new URL(u); await sleep(150); } return null; };
    const theme = async () => { await sleep(800); const u = await src(); return u && u.searchParams.get('theme'); };
    await run({ scheme, page, src, theme, app, profile });
  } finally {
    await app.close().catch(() => {});
  }
}

(async () => {
  await withChart({}, async ({ scheme, page, src, theme, app, profile }) => {
    await scheme('dark');
    let t = await theme();
    check('dark scheme: the chart loads with theme=dark', t === 'dark', t);
    await scheme('light');
    t = await theme();
    check('switching to light reloads the chart with theme=light', t === 'light', t);
    await scheme('dark');
    t = await theme();
    check('and to dark again', t === 'dark', t);

    check('the card head has an interval menu starting at the stored interval', await page(`document.querySelector('.w-card.tradingview .tv-interval')?.value === 'D'`), 'no menu');
    await page(`(() => { const m = document.querySelector('.w-card.tradingview .tv-interval'); m.value = '60'; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(500);
    const u = await src();
    check('picking 1h reloads the chart at interval=60, theme kept', u && u.searchParams.get('interval') === '60' && u.searchParams.get('theme') === 'dark', u && u.href);
    await sleep(800);
    await app.evaluate(() => { if (global.__settingsFlush) global.__settingsFlush(); });
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).homeWidgets.find((w) => w.id === 'wtvi0001');
    check('the pick is saved as the widget’s Interval (what Settings edits)', saved?.tv?.interval === '60' && saved.tv.symbol === 'NASDAQ:CONL', JSON.stringify(saved));
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    await scheme('dark');
    const again = await src();
    check('a new tab opens the chart at the saved interval, menu showing it', again && again.searchParams.get('interval') === '60' && (await page(`document.querySelector('.w-card.tradingview .tv-interval')?.value`)) === '60', again && again.href);
  });

  await withChart({ newTabBackground: 'aurora' }, async ({ scheme, page, theme }) => {
    await scheme('light');
    check('wallpaper page: its cards are dark, so the chart is too, even when the scheme is light', await page(`document.body.classList.contains('on-media')`) && (await theme()) === 'dark', 'light chart');
  });

  // The mini chart and the watchlist take a date range near the interval, in their options.
  for (const [view, extraTv, path_] of [['mini', {}, '/embed-widget/mini-symbol-overview/'], ['watchlist', { symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] }, '/embed-widget/market-overview/']]) {
    await withChart({}, async ({ scheme, page, src }) => {
      await scheme('dark');
      let u = await src();
      const range = (x) => JSON.parse(decodeURIComponent(x.hash.slice(1))).dateRange;
      check(`${view}: loads ${path_} at the range for the stored 1 day (1M)`, u && u.pathname === path_ && range(u) === '1M', u && u.href);
      await page(`(() => { const m = document.querySelector('.w-card.tradingview .tv-interval'); m.value = 'W'; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(800);
      u = await src();
      check(`${view}: picking 1 week reloads it with the 12M range`, u && range(u) === '12M', u && u.href);
    }, { view, ...extraTv });
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
