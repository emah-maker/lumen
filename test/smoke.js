// Launches the app, loads a page, and screenshots the window.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const errors = [];
  app.process().stderr.on('data', (d) => errors.push(String(d)));
  const ui = await app.firstWindow();
  ui.on('console', (m) => { if (m.type() === 'error') errors.push('UI: ' + m.text()); });
  ui.on('pageerror', (e) => errors.push('UI pageerror: ' + e.message));
  await ui.waitForSelector('.tab');
  await ui.waitForTimeout(1000);
  const out = process.argv[2] || 'shot';
  await ui.screenshot({ path: `${out}-newtab.png` }).catch(() => {});
  await app.evaluate(async ({ BrowserWindow }) => {}); // ensure main is alive
  await ui.fill('#address', 'example.com');
  await ui.press('#address', 'Enter');
  await ui.waitForFunction(() => document.querySelector('#address').value.includes('example.com'), null, { timeout: 15000 });
  await ui.waitForTimeout(1500);
  const title = await ui.textContent('.tab.active .tab-title');
  console.log('active tab title:', title);
  // window screenshot including WebContentsViews
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return img.toPNG().toString('base64');
  });
  require('fs').writeFileSync(`${out}-ui.png`, Buffer.from(png, 'base64'));
  console.log('errors:', errors.filter(e => !/DevTools|GPU|gpu/.test(e)).join('\n') || 'none');
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
