const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-probe-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [
    { id: 'wweath1', type: 'weather', title: '', span: 3, place: 'Boston', lat: 42.3, lon: -71, units: 'f' },
    { id: 'wtodo01', type: 'todoist', title: '', span: 3 },
    { id: 'wemb001', type: 'embed', title: 'Board', span: 6, height: 'small', url: 'https://127.0.0.1:9/x', name: 'x', frameable: false },
  ] }));
  const app = await electron.launch({ args: [path.join(__dirname)], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await sleep(1500);
  console.log(await page(`JSON.stringify({ w: innerWidth, h: innerHeight, cards: [...document.querySelectorAll('.w-card')].map(c => ({ id: c.dataset.id, cell: c.dataset.cell, t: c.style.transform, wd: c.style.width, ht: c.style.height })), layoutLoaded: typeof window.WidgetLayout, colors: typeof window.WidgetColors, grid: typeof window.widgetGrid, main: [document.querySelector('main').offsetLeft, document.querySelector('main').offsetWidth, document.querySelector('main').offsetHeight], boxh: document.getElementById('widgets').style.height })`));
  await page('scrollTo(0, 650)'); await sleep(400);
  const errs = await app.evaluate(() => global.__wtab.webContents.executeJavaScript('window.__errs || null'));
  console.log(errs);
  const img = await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync('_probe.png', Buffer.from(img, 'base64'));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
