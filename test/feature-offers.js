// "New in Lumen: want to turn these on?" (features/feature-offers.js, renderer/offer-card.js), in a real sidebar with invisible
// windows: an update from an old version shows the card on the empty chat with one line and a button per new feature; it is
// recorded as offered once on screen; "Turn on" saves the setting through the settings backend (no restart); "Set up" opens the
// feature's Settings section and switches nothing on (Telegram and voice input send data, so they keep their own setup);
// it never shows over a conversation; "Not now" and "Don't show again" stick across launches; a fresh profile is never asked.
// The rules are test/feature-offers-units.js.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const ALL = JSON.stringify(require('../src/features/feature-offers').OFFERS.map((o) => o.key)); // a fresh install records every offer as seen
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
  const makeProfile = (settings) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-offers-'));
    if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  };
  const settingsOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return {}; } };

  async function launch(profile) {
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_FEATURE_OFFERS_TEST: '1', ANTHROPIC_API_KEY: 'sk-ant-test' };
    const app = await electron.launch({ args: [root], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const open = async () => { // the sidebar, on its empty chat
      if (await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true')) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
      await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-moving') && document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true'));
    };
    const card = () => ui.evaluate(() => {
      const el = document.querySelector('.offer-card');
      if (!el || el.offsetParent === null) return null;
      return { title: el.querySelector('.offer-title').textContent, rows: [...el.querySelectorAll('.offer-row')].map((r) => ({ id: r.dataset.offer, name: r.querySelector('.offer-name').textContent, desc: r.querySelector('.offer-desc').textContent, button: r.querySelector('.offer-go').textContent })), foot: [...el.querySelectorAll('.offer-foot button')].map((b) => b.textContent) };
    });
    const present = () => ui.evaluate(() => Boolean(document.querySelector('.offer-card'))); // (in the DOM, even when a Settings tab has the view)
    const press = (sel) => ui.evaluate((q) => document.querySelector(q).click(), sel);
    const urls = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
    return { app, ui, open, card, urls, present, press };
  }

  const updated = makeProfile({ lastSeenVersion: '0.3.0' });
  {
    const { app, ui, open, card, urls, present, press } = await launch(updated);
    try {
      await open();
      const c = await waitFor(card);
      check('update: the card shows on the empty chat, with every new feature', c?.title === 'New in Lumen: want to turn these on?' && c.rows.map((r) => r.id).join() === 'memory,plan,skills,telegram,voice', JSON.stringify(c));
      check('each line is plain, with Turn on or Set up', c?.rows.every((r) => r.name && r.desc.length < 200 && r.button === (['telegram', 'voice'].includes(r.id) ? 'Set up' : 'Turn on')) && c.foot.join() === 'Not now,Don’t show again', JSON.stringify(c));
      await waitFor(() => JSON.stringify(settingsOf(updated).featureOffersSeen) === ALL, 4000);
      check('once it has been on screen, the features are recorded as offered', JSON.stringify(settingsOf(updated).featureOffersSeen) === ALL, JSON.stringify(settingsOf(updated)));

      await ui.click('.offer-row[data-offer="memory"] .offer-go');
      await waitFor(() => settingsOf(updated).aiMemory === true, 4000);
      check('Turn on saves the setting', settingsOf(updated).aiMemory === true, JSON.stringify(settingsOf(updated)));
      check('that row leaves the card', (await card())?.rows.every((r) => r.id !== 'memory'), JSON.stringify(await card()));

      await press('.offer-row[data-offer="telegram"] .offer-go');
      const opened = await waitFor(async () => (await urls()).some((u) => /settings\.html#telegram$/.test(u)));
      check('Set up opens the Telegram section of Settings', Boolean(opened), JSON.stringify(await urls()));
      check('and turns nothing on by itself', settingsOf(updated).telegramChannel !== true, JSON.stringify(settingsOf(updated)));
      await press('.offer-row[data-offer="voice"] .offer-go');
      check('voice input is set up in Settings too', Boolean(await waitFor(async () => (await urls()).some((u) => /settings\.html#voice-input$/.test(u)))), JSON.stringify(await urls()));

      await press('.offer-foot .offer-later');
      check('Not now takes the card away', !(await present()), 'still there');
      check('and turns nothing else on', settingsOf(updated).skillsFromClaudeCode !== true && settingsOf(updated).planModeDefault !== true, JSON.stringify(settingsOf(updated)));
    } finally { await app.close().catch(() => {}); }
  }
  {
    const { app, open, card } = await launch(updated);
    try {
      await open();
      await sleep(2500);
      check('the next launch shows nothing', (await card()) === null, JSON.stringify(await card()));
    } finally { await app.close().catch(() => {}); }
  }

  const never = makeProfile({ lastSeenVersion: '0.3.0' });
  {
    const { app, ui, open, card } = await launch(never);
    try {
      await open();
      await waitFor(card);
      await ui.click('.offer-foot .offer-never');
      await waitFor(() => settingsOf(never).featureCardNever === true, 4000);
      check('Don\'t show again is saved and the card goes', settingsOf(never).featureCardNever === true && (await card()) === null, JSON.stringify(settingsOf(never)));
    } finally { await app.close().catch(() => {}); }
  }

  const busy = makeProfile({ lastSeenVersion: '0.3.0' });
  {
    const { app, ui, open, card } = await launch(busy);
    try {
      await app.evaluate(() => { global.__agent.getClient = () => ({ beta: { messages: { stream: () => ({
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } }; await new Promise((r) => { global.__gate = r; }); },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Working' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      }) } } }); });
      await open();
      await waitFor(card);
      await ui.fill('#prompt', 'do a long task');
      await ui.press('#prompt', 'Enter');
      await waitFor(() => ui.evaluate(() => document.body.classList.contains('running')));
      check('a running task is never covered by the card', (await card()) === null, JSON.stringify(await card()));
      await app.evaluate(() => global.__gate?.());
    } finally { await app.close().catch(() => {}); }
  }

  const fresh = makeProfile(null);
  {
    const { app, open, card } = await launch(fresh);
    try {
      await open();
      await sleep(3000);
      check('a fresh profile is never asked, and records the offers as seen', (await card()) === null && JSON.stringify(settingsOf(fresh).featureOffersSeen) === ALL, `${JSON.stringify(await card())} ${JSON.stringify(settingsOf(fresh))}`);
    } finally { await app.close().catch(() => {}); }
  }
  for (const dir of [updated, never, busy, fresh]) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
