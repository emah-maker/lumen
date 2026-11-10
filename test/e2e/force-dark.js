// "Dark mode for all websites" (forceDarkWebsites, a restart setting) darkens a page that has no dark theme: Chromium's auto dark mode, turned on
// per page over DevTools (applyChromeIdentity in main.js). It used to set Chromium's WebContentsForceDark feature, which Electron never reads, and
// the page stayed white. Two launches on one profile: setting on (the page is drawn dark), setting off (the page is drawn white). Pixels, not styles:
// auto dark mode changes how the page is drawn, not its computed colors.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PAGE = '<!doctype html><title>white</title><style>html,body{margin:0;height:100%;background:#fff;color:#111;font:16px sans-serif}</style><p>A page with no dark theme.</p>';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-force-dark-'));

  // The brightness of the page's top-left corner area, as drawn (0 black, 255 white).
  const drawn = async (forceDark) => {
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ forceDarkWebsites: forceDark }));
    const app = await electron.launch({
      args: [path.join(__dirname, '..', '..')],
      env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile }, timeout: 30000,
    });
    try {
      const ui = await app.firstWindow();
      await ui.waitForSelector('.tab');
      return await app.evaluate(async (_e, u) => {
        const t = global.__agent.browser.openTab(u);
        await new Promise((r) => t.webContents.once('did-finish-load', r));
        await new Promise((r) => setTimeout(r, 800)); // (a frame drawn with the override)
        const img = await t.webContents.capturePage({ x: 0, y: 40, width: 200, height: 100 });
        const bmp = img.toBitmap(); // BGRA
        let sum = 0;
        for (let i = 0; i < bmp.length; i += 4) sum += (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
        return Math.round(sum / (bmp.length / 4));
      }, url);
    } finally { await app.close().catch(() => {}); }
  };

  const on = await drawn(true);
  check('with "Dark mode for all websites" on, a white page is drawn dark', on < 80, on);
  const off = await drawn(false);
  check('with it off, the same page is drawn white', off > 230, off);

  server.close();
  console.log(failures ? `\n${failures} force-dark check(s) failed.` : '\nAll force-dark checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
