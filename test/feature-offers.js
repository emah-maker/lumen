// "Turn this on?" after an update (features/feature-offers.js), in a real window: an update from an old version
// shows the release notes, then the file-access card; Turn on saves aiDeviceAccess through the settings backend;
// the next launch asks nothing; a fresh profile is never asked. The rules are test/feature-offers-units.js.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return fn(); };
  const makeProfile = (settings) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-offers-'));
    if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  };
  const settingsOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return {}; } };

  async function launch(profile) {
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_WHATS_NEW_TEST: '1', LUMEN_FEATURE_OFFERS_TEST: '1' };
    const app = await electron.launch({ args: [root], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const overlay = async (script, ms = 8000) => waitFor(() => app.evaluate(async ({ webContents }, s) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
      if (!view || !(await view.executeJavaScript("document.getElementById('backdrop').classList.contains('shown')"))) return null;
      return { value: await view.executeJavaScript(s) };
    }, script), ms).then((r) => (r ? r.value : null));
    const kind = () => app.evaluate(() => global.__dialogs.currentKind());
    const press = (label) => overlay(`(() => { const b = [...document.querySelectorAll('#buttons button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const card = () => overlay("({ message: document.getElementById('message').textContent, detail: document.getElementById('detail')?.textContent || '', buttons: [...document.querySelectorAll('#buttons button')].map((b) => b.textContent) })");
    return { app, kind, press, card };
  }

  const updated = makeProfile({ lastSeenVersion: '0.3.0' });
  {
    const { app, kind, press, card } = await launch(updated);
    try {
      await waitFor(async () => (await kind()) === 'notes');
      check('update: the release notes come first', (await kind()) === 'notes', await kind());
      await waitFor(() => Array.isArray(settingsOf(updated).featureOffersSeen), 4000); // (the file is written off the main thread)
      check('the seen list is saved before any offer shows', JSON.stringify(settingsOf(updated).featureOffersSeen) === '["aiDeviceAccess"]', JSON.stringify(settingsOf(updated)));
      await press('Got it');
      await waitFor(async () => (await kind()) === 'message');
      const c = await card();
      check('then the file-access card, with Not now and Turn on', c?.message === 'Let the AI use files on this computer' && JSON.stringify(c?.buttons) === '["Not now","Turn on"]' && /Settings > AI/.test(c?.detail || ''), JSON.stringify(c));
      await press('Turn on');
      await waitFor(() => settingsOf(updated).aiDeviceAccess === true, 4000);
      check('Turn on saves the setting', settingsOf(updated).aiDeviceAccess === true, JSON.stringify(settingsOf(updated)));
      const live = await app.evaluate(() => global.__agent.browser.deviceAccess());
      check('and the AI has it at once (no restart)', live === true, live);
    } finally { await app.close().catch(() => {}); }
  }
  {
    const { app, kind } = await launch(updated);
    try {
      await sleep(3000);
      check('the next launch asks nothing', (await kind()) === null, await kind());
    } finally { await app.close().catch(() => {}); }
  }
  const fresh = makeProfile(null);
  {
    const { app, kind } = await launch(fresh);
    try {
      await sleep(3000);
      check('a fresh profile is never asked, and records the offer as seen', (await kind()) === null && JSON.stringify(settingsOf(fresh).featureOffersSeen) === '["aiDeviceAccess"]', `${await kind()} ${JSON.stringify(settingsOf(fresh))}`);
    } finally { await app.close().catch(() => {}); }
  }
  for (const dir of [updated, fresh]) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
