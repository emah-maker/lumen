// Installs a real Chrome Web Store extension (Dark Reader) and checks it runs and shows in the toolbar.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

  const installed = await app.evaluate(async () => {
    try {
      const ext = await global.__installExtension('eimadpbcbfnmbkopoojfekhnkhdbieeh');
      return { ok: true, name: ext.name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }).catch((e) => ({ ok: false, error: e.message }));
  check('install Dark Reader from Chrome Web Store', installed.ok, installed.error);

  await app.evaluate(() => global.__agent.execute('navigate', { url: 'https://example.com' }));
  await ui.waitForTimeout(3000);
  const injected = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript(
    "!!document.querySelector('style.darkreader, meta[name=darkreader]')"));
  check('extension content script runs on pages', injected, 'no darkreader styles found');

  await ui.waitForTimeout(1500);
  const visible = await ui.evaluate(() => document.getElementById('extension-actions').getBoundingClientRect().width > 0);
  check('extension toolbar is visible', visible, 'zero width');
  const actions = await ui.evaluate(() => {
    const list = document.getElementById('extension-actions');
    return list ? list.shadowRoot?.querySelectorAll('.action, button').length ?? -1 : -2;
  });
  check('extension button appears in toolbar', actions > 0, `count=${actions}`);

  // Clicking the extension's toolbar button opens its popup, sized and visible.
  await ui.evaluate(() => document.getElementById('extension-actions').shadowRoot.querySelector('.action').click());
  let popup = null;
  for (let i = 0; i < 20 && !popup?.visible; i++) {
    await ui.waitForTimeout(250);
    popup = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('chrome-extension://'));
      return w ? { visible: w.isVisible(), bounds: w.getBounds() } : null;
    });
  }
  check('extension popup opens visible and sized', popup?.visible && popup.bounds.width > 200 && popup.bounds.height > 200, JSON.stringify(popup));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
