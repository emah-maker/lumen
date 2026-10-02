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
async function withChart(extra, run) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-tvi-'));
  const widget = { id: 'wtvi0001', x: 0, y: 0, w: 6, h: 5, type: 'tradingview', tv: { symbol: 'NASDAQ:CONL', interval: 'D', view: 'chart', theme: 'auto' } };
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
    await run({ scheme, page, src, theme });
  } finally {
    await app.close().catch(() => {});
  }
}

(async () => {
  await withChart({}, async ({ scheme, page, src, theme }) => {
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
    check('the pick is remembered for the card', await page(`localStorage.getItem('tv-interval:wtvi0001')`) === '60', 'not stored');
  });

  await withChart({ newTabBackground: 'aurora' }, async ({ scheme, page, theme }) => {
    await scheme('light');
    check('wallpaper page: its cards are dark, so the chart is too, even when the scheme is light', await page(`document.body.classList.contains('on-media')`) && (await theme()) === 'dark', 'light chart');
  });

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
