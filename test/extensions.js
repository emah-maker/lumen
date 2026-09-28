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

  // ---- the "Add extension?" dialog lists what it asks for
  const { extensionPermissionLines } = require('../extension-permissions');
  const broad = extensionPermissionLines({ permissions: ['tabs', 'storage', 'cookies'], host_permissions: ['<all_urls>'] });
  check('install prompt: all-sites access is listed first', broad[0] === 'Read and change all your data on all websites', JSON.stringify(broad));
  check('install prompt: tabs and cookies are listed, storage is not', broad.includes('Read your browsing history') && broad.some((l) => /cookies/.test(l)) && broad.length === 3, JSON.stringify(broad));
  const narrow = extensionPermissionLines({ content_scripts: [{ matches: ['https://*.github.com/*', 'https://example.com/*'] }] });
  check('install prompt: specific sites are named', narrow.length === 1 && narrow[0].includes('github.com') && narrow[0].includes('example.com'), JSON.stringify(narrow));
  check('install prompt: nothing special says so', extensionPermissionLines({ permissions: ['storage'] }).length === 0, 'expected no lines');
  check('main.js uses no private Electron preload getter', !/_getPreloadScript/.test(require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')), '_getPreloadScript found');

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

  // declarativeNetRequest: only content blockers with static rulesets are refused; others install
  // and get a working (in-memory) chrome.declarativeNetRequest.
  const gate = await app.evaluate(() => ({
    helper: global.__isContentBlocker({ name: '1Password', permissions: ['declarativeNetRequest'] }, '1Password – Password Manager'),
    helperWithRules: global.__isContentBlocker({ name: 'Password helper', description: 'Fills passwords', declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'r.json' }] } }),
    blocker: global.__isContentBlocker({ name: 'Super Ad Blocker', description: 'Blocks ads and trackers', declarative_net_request: { rule_resources: [{ id: 'ads', enabled: true, path: 'ads.json' }] } }),
  }));
  check('DNR gate: an extension asking for DNR without rulesets installs', gate.helper === false && gate.helperWithRules === false, JSON.stringify(gate));
  check('DNR gate: a blocker with static rulesets is still refused', gate.blocker === true, JSON.stringify(gate));
  const fixture = await app.evaluate(async ({ session }, dir) => {
    const ext = await session.defaultSession.extensions.loadExtension(dir);
    const t = global.__agent.browser.openTab(`chrome-extension://${ext.id}/page.html`);
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.webContents.executeJavaScript('window.dnrResult');
  }, path.join(__dirname, 'fixtures', 'dnr-ext'));
  check('chrome.declarativeNetRequest works in extension pages (rules kept, no throw)', fixture.present && JSON.stringify(fixture.added) === '[7]' && fixture.after === 0 && fixture.block === 'block' && fixture.regex === true, JSON.stringify(fixture));
  check('extension pages get `browser` as chrome, and can still set their own', fixture.alias === true && fixture.ownKept === true, JSON.stringify(fixture));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
